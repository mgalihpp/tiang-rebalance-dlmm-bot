import type { Config, TelegramConfig } from "./config.js";
import type { ActResult } from "./chain/act.js";
import type { Logger } from "./log.js";
import { makeSettingsStore, type SettingKey, type SettingsStore } from "./settings.js";

type CompletedAction = Extract<ActResult, { readonly _tag: "opened" | "closed" | "rebalanced" }>;

export type TelegramAlert =
  | { readonly _tag: "started"; readonly pool: string; readonly dryRun: boolean }
  | { readonly _tag: "action"; readonly result: CompletedAction }
  | { readonly _tag: "halt"; readonly reason: string }
  | { readonly _tag: "cycle-error"; readonly message: string };

export type TelegramNotifier = {
  readonly notify: (alert: TelegramAlert) => Promise<void>;
};

const formatAlert = (alert: TelegramAlert): string => {
  switch (alert._tag) {
    case "started":
      return `DLMM bot started\nMode: ${alert.dryRun ? "DRY RUN, no transactions sent" : "LIVE, transactions may be sent"}\nPool: ${alert.pool}`;
    case "action":
      switch (alert.result._tag) {
        case "opened":
          return `Position opened\nAddress: ${alert.result.position.toBase58()}`;
        case "closed":
          return `Position closed\nAddress: ${alert.result.position.toBase58()}`;
        case "rebalanced":
          return `Position rebalanced\nClosed: ${alert.result.from.toBase58()}\nOpened: ${alert.result.to?.toBase58() ?? "no new position"}`;
      }
    case "halt":
      return `Trading halted\nReason: ${alert.reason}\nReview the logs and HALT file before restarting.`;
    case "cycle-error":
      return `Cycle failed\n${alert.message.replace(/https?:\/\/\S+/g, "[URL redacted]").slice(0, 2_000)}`;
  }
};

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null ? value as Record<string, unknown> : null;

const telegramCall = async (
  fetchMessage: typeof fetch,
  config: Extract<TelegramConfig, { enabled: true }>,
  method: string,
  payload: unknown,
  signal?: AbortSignal,
): Promise<unknown> => {
  const response = await fetchMessage(`https://api.telegram.org/bot${config.botToken}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    ...(signal ? { signal } : {}),
  });
  const body: unknown = await response.json();
  if (!response.ok || !isTelegramSuccess(body)) throw new Error(`Telegram ${method} rejected`);
  return body;
};

export const makeTelegramSettingsController = (
  config: Config,
  log: Logger,
  store: SettingsStore = makeSettingsStore(config, log),
  fetchMessage: typeof fetch = fetch,
): { start(signal: AbortSignal): Promise<void> } => ({
  start: async (signal) => {
    const telegram = config.telegram;
    if (!telegram.enabled) return;
    let offset = 0;
    let commandsRegistered = false;
    let liveConfirmation: { expires: number; key: SettingKey } | null = null;
    const prompts = new Map<number, SettingKey>();
    const call = (method: string, payload: unknown) => telegramCall(fetchMessage, telegram, method, payload, signal);
    const sendPage = async (page: string, text = "") => call("sendMessage", {
      chat_id: telegram.chatId,
      text: text || renderPage(page, store.snapshot()),
      reply_markup: pageKeyboard(page),
    });
    while (!signal.aborted) {
      try {
        if (!commandsRegistered) {
          await call("setMyCommands", { commands: [{ command: "settings", description: "Configure bot settings" }, { command: "status", description: "Show current settings" }] });
          commandsRegistered = true;
        }
        const body = record(await call("getUpdates", {
          offset,
          timeout: 30,
          allowed_updates: ["message", "callback_query"],
        }));
        const results = body && Array.isArray(body.result) ? body.result : [];
        for (const raw of results) {
          const update = record(raw);
          if (!update || typeof update.update_id !== "number") continue;
          const message = record(update.message);
          if (message) {
            const chat = record(message.chat);
            const from = record(message.from);
            if (chat?.type === "private" && String(chat.id) === telegram.chatId && String(from?.id) === telegram.chatId && typeof message.text === "string") {
              const text = message.text.trim();
              if (/^\/(settings|status)(?:@\w+)?$/.test(text)) {
                await sendPage(/^\/status(?:@\w+)?$/.test(text) ? "status" : "menu");
              } else if (message.reply_to_message) {
                const reply = record(message.reply_to_message);
                const key = typeof reply?.message_id === "number" ? prompts.get(reply.message_id) : undefined;
                if (key && validSettingKey(key)) {
                  if (typeof reply?.message_id === "number") prompts.delete(reply.message_id);
                  const result = await store.set(key, text);
                  if (result.ok) await sendPage(categoryFor(key), `Saved.\n${renderPage(categoryFor(key), result.snapshot)}`);
                  else if (result.confirmationRequired && key === "mode" && text === "live") {
                    liveConfirmation = { key, expires: Date.now() + 60_000 };
                    await call("sendMessage", { chat_id: telegram.chatId, text: "Warning: live transactions can move funds. Confirm enabling LIVE mode.", reply_markup: { inline_keyboard: [[{ text: "Confirm live mode", callback_data: "confirm:live" }, { text: "Cancel", callback_data: "nav:mode" }]] } });
                  } else await sendPage(categoryFor(key), `Not saved. ${result.message}\nCurrent value is unchanged.\n\n${renderPage(categoryFor(key), store.snapshot())}`);
                }
              }
            }
          }
          const callback = record(update.callback_query);
          if (callback) {
            const from = record(callback.from);
            const callbackMessage = record(callback.message);
            const chat = record(callbackMessage?.chat);
            if (chat?.type !== "private" || String(chat.id) !== telegram.chatId || String(from?.id) !== telegram.chatId ||
              typeof callback.id !== "string") {
              offset = Math.max(offset, update.update_id + 1);
              continue;
            }
            const data = typeof callback.data === "string" ? callback.data : "";
            const answer = (text: string, alert = false) => call("answerCallbackQuery", { callback_query_id: callback.id, text, show_alert: alert });
            if (data === "confirm:live" && liveConfirmation?.key === "mode" && liveConfirmation.expires > Date.now()) {
              liveConfirmation = null;
              const result = await store.set("mode", "live", true);
              await answer(result.ok ? "Live mode enabled" : result.message, !result.ok);
              await sendPage("mode");
            } else if (/^nav:(menu|strategy|limits|fees|timing|mode|restart|protected|status)$/.test(data)) {
              const page = data.slice(4);
              await answer("Settings opened");
              await sendPage(page);
            } else if (data === "reset:confirm") {
              try {
                await store.reset();
                await answer("Settings reset to environment defaults");
                await sendPage("menu");
              } catch {
                await answer("Could not reset settings. Current values are unchanged.", true);
              }
            } else if (data === "reset:ask") {
              await answer("Confirm reset", true);
              await call("sendMessage", { chat_id: telegram.chatId, text: "Reset all settings to environment defaults?", reply_markup: { inline_keyboard: [[{ text: "Confirm reset", callback_data: "reset:confirm" }, { text: "Cancel", callback_data: "nav:menu" }]] } });
            } else if (/^width:[123]$/.test(data)) {
              const result = await store.set("width", data.slice(6));
              await answer(result.ok ? "Width saved" : result.message, !result.ok);
              await sendPage("strategy");
            } else if (data === "mode:dry-run") {
              const result = await store.set("mode", "dry-run");
              await answer(result.ok ? "Dry-run enabled" : result.message, !result.ok);
              await sendPage("mode");
            } else if (/^edit:[a-zA-Z]+$/.test(data)) {
              const key = data.slice(5);
              if (validSettingKey(key)) {
                await answer("Reply with the new value");
                const prompt = record(await call("sendMessage", { chat_id: telegram.chatId, text: `Enter ${settingLabel(key)}. Reply to this message with the value.`, reply_markup: { force_reply: true, selective: true } }));
                const result = record(prompt?.result);
                if (typeof result?.message_id === "number") prompts.set(result.message_id, key);
              } else await answer("This setting is unavailable", true);
            } else await answer("This action is unavailable", true);
          }
            offset = Math.max(offset, update.update_id + 1);
        }
      } catch (error) {
        if (!signal.aborted) log.warn("Telegram settings polling failed", {
          error: error instanceof Error ? error.name : "unknown error",
        });
        if (!signal.aborted) await abortableDelay(signal, 1_000);
      }
    }
  },
});

const abortableDelay = (signal: AbortSignal, milliseconds: number): Promise<void> => new Promise((resolve) => {
  if (signal.aborted) { resolve(); return; }
  const timer = setTimeout(done, milliseconds);
  function done() {
    clearTimeout(timer);
    signal.removeEventListener("abort", done);
    resolve();
  }
  signal.addEventListener("abort", done, { once: true });
});

const validSettingKey = (key: string): key is SettingKey => ["width", "slippagePercent", "maxDeployX", "maxDeployY", "minSolReserve", "priorityFeeMicroLamports", "maxPriorityFeeMicroLamports", "pollIntervalMs", "dwellTicks", "maxRebalancesPerHour", "minRebalanceIntervalMs", "maxSnapshotAgeMs", "mode", "poolAddress", "walletKeypairPath", "logLevel", "telegramTimeoutMs"].includes(key);
const categoryFor = (key: SettingKey): string => ["poolAddress", "walletKeypairPath", "logLevel", "telegramTimeoutMs"].includes(key) ? "restart" : key === "mode" ? "mode" : ["width", "slippagePercent"].includes(key) ? "strategy" : ["maxDeployX", "maxDeployY", "minSolReserve"].includes(key) ? "limits" : ["priorityFeeMicroLamports", "maxPriorityFeeMicroLamports"].includes(key) ? "fees" : "timing";
const settingLabel = (key: SettingKey): string => ({ width: "position width", slippagePercent: "slippage percent", maxDeployX: "maximum deploy X (raw units)", maxDeployY: "maximum deploy Y (raw units)", minSolReserve: "minimum SOL reserve (lamports)", priorityFeeMicroLamports: "priority fee (micro-lamports)", maxPriorityFeeMicroLamports: "maximum priority fee (micro-lamports)", pollIntervalMs: "poll interval (milliseconds)", dwellTicks: "dwell ticks", maxRebalancesPerHour: "maximum rebalances per hour", minRebalanceIntervalMs: "minimum rebalance interval (milliseconds)", maxSnapshotAgeMs: "maximum snapshot age (milliseconds)", mode: "mode", poolAddress: "pool address", walletKeypairPath: "wallet keypair file path", logLevel: "log level", telegramTimeoutMs: "Telegram timeout (milliseconds)" })[key];
const valueFor = (key: SettingKey, snapshot: ReturnType<SettingsStore["snapshot"]>): string => {
  const value = (snapshot.runtime as unknown as Record<string, unknown>)[key] ?? (snapshot.restart as unknown as Record<string, unknown>)[key];
  if (typeof value === "bigint") return value.toString();
  if (value === null) return "unlimited";
  return String(value);
};
const editable: Record<string, readonly SettingKey[]> = {
  strategy: ["width", "slippagePercent"], limits: ["maxDeployX", "maxDeployY", "minSolReserve"], fees: ["priorityFeeMicroLamports", "maxPriorityFeeMicroLamports"],
  timing: ["pollIntervalMs", "dwellTicks", "maxRebalancesPerHour", "minRebalanceIntervalMs", "maxSnapshotAgeMs"], mode: ["mode"],
  restart: ["poolAddress", "walletKeypairPath", "logLevel", "telegramTimeoutMs"],
};
const renderPage = (page: string, snapshot: ReturnType<SettingsStore["snapshot"]>): string => {
  if (page === "protected") return "Protected settings\nPrivate wallet keys, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, RPC_URL, and WS_URL remain environment-only. STATE_DIR cannot be changed because it owns this file.";
  if (page === "status") return `Current configuration\n${[...(editable.strategy ?? []), ...(editable.limits ?? []), ...(editable.fees ?? []), ...(editable.timing ?? []), ...(editable.mode ?? []), ...(editable.restart ?? [])].map((key) => `${settingLabel(key)}: ${valueFor(key, snapshot)}${snapshot.pendingRestart.includes(key) ? " (after restart)" : " (next cycle)"}`).join("\n")}\nMode: ${snapshot.runtime.mode}${snapshot.runtime.mode === "live" ? ". Live transactions can move funds." : ". No live transactions."}`;
  const keys = editable[page] ?? [];
  return `${page === "menu" ? "Settings" : `${(page[0] ?? "").toUpperCase()}${page.slice(1)} settings`}\n${keys.map((key) => `${settingLabel(key)}: ${valueFor(key, snapshot)} (${snapshot.pendingRestart.includes(key) ? "after restart" : "next cycle"})`).join("\n")}${page === "mode" ? "\nLive transactions can move funds. Enabling live requires confirmation." : ""}`;
};
const pageKeyboard = (page: string) => {
  if (page === "menu" || page === "status") return { inline_keyboard: [["strategy", "limits"], ["fees", "timing"], ["mode", "restart"], ["protected", "status"], ["reset:ask"]].map((row) => row.map((item) => ({ text: item === "reset:ask" ? "Reset" : `${item[0]?.toUpperCase() ?? ""}${item.slice(1)}`, callback_data: item === "reset:ask" ? item : `nav:${item}` }))) };
  const buttons = page === "strategy" ? [["width:1", "width:2", "width:3"].map((value) => ({ text: `Width ${value.slice(-1)}`, callback_data: value })), ...(editable.strategy ?? []).filter((key) => key !== "width").map((key) => [{ text: `Edit ${settingLabel(key)}`, callback_data: `edit:${key}` }])] : page === "mode" ? [[{ text: "Enable dry-run", callback_data: "mode:dry-run" }], [{ text: "Enable live…", callback_data: "edit:mode" }]] : (editable[page] ?? []).map((key) => [{ text: `Edit ${settingLabel(key)}`, callback_data: `edit:${key}` }]);
  return { inline_keyboard: [...buttons, [{ text: "Back", callback_data: "nav:menu" }]] };
};

const isTelegramSuccess = (value: unknown): boolean =>
  typeof value === "object" && value !== null && "ok" in value && value.ok === true;

export const makeTelegramNotifier = (
  config: TelegramConfig,
  log: Logger,
  fetchMessage: typeof fetch = fetch,
): TelegramNotifier => ({
  notify: async (alert) => {
    if (!config.enabled) return;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const response = await fetchMessage(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: config.chatId, text: formatAlert(alert) }),
        signal: controller.signal,
      });
      const body: unknown = await response.json();
      if (!response.ok || !isTelegramSuccess(body)) {
        log.warn("Telegram notification rejected", { status: response.status });
      }
    } catch (error) {
      log.warn("Telegram notification failed", {
        error: error instanceof Error ? error.name : "unknown error",
      });
    } finally {
      clearTimeout(timeout);
    }
  },
});
