import type { TelegramConfig } from "./config.js";
import type { ActResult } from "./chain/act.js";
import type { Logger } from "./log.js";
import { pollIntervals } from "./settings.js";

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

const settingData = (value: number): string => `poll:${value}`;
const settingKeyboard = (current: number) => ({
  inline_keyboard: pollIntervals.map((value) => [{
    text: `${value / 1_000}s${value === current ? " ✓" : ""}`,
    callback_data: settingData(value),
  }]),
});

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
  config: TelegramConfig,
  log: Logger,
  options: { getPollIntervalMs: () => number; setPollIntervalMs: (value: number) => Promise<void> },
  fetchMessage: typeof fetch = fetch,
): { start(signal: AbortSignal): Promise<void> } => ({
  start: async (signal) => {
    if (!config.enabled) return;
    let offset = 0;
    while (!signal.aborted) {
      try {
        const body = record(await telegramCall(fetchMessage, config, "getUpdates", {
          offset,
          timeout: 30,
          allowed_updates: ["message", "callback_query"],
        }, signal));
        const results = body && Array.isArray(body.result) ? body.result : [];
        for (const raw of results) {
          const update = record(raw);
          if (!update || typeof update.update_id !== "number") continue;
          const message = record(update.message);
          if (message) {
            const chat = record(message.chat);
            const from = record(message.from);
            if (chat?.type === "private" && String(chat.id) === config.chatId && String(from?.id) === config.chatId &&
              typeof message.text === "string" && /^\/settings(?:@\w+)?$/.test(message.text.trim())) {
              const current = options.getPollIntervalMs();
              await telegramCall(fetchMessage, config, "sendMessage", {
                chat_id: config.chatId,
                text: `Poll interval: ${current / 1_000}s`,
                reply_markup: settingKeyboard(current),
              }, signal);
            }
          }
          const callback = record(update.callback_query);
          if (callback) {
            const from = record(callback.from);
            const callbackMessage = record(callback.message);
            const chat = record(callbackMessage?.chat);
            if (chat?.type !== "private" || String(chat.id) !== config.chatId || String(from?.id) !== config.chatId ||
              typeof callback.id !== "string") {
              offset = Math.max(offset, update.update_id + 1);
              continue;
            }
            const data = typeof callback.data === "string" ? callback.data : "";
            const selected = pollIntervals.find((value) => data === settingData(value));
            if (selected === undefined) {
              await telegramCall(fetchMessage, config, "answerCallbackQuery", {
                callback_query_id: callback.id,
                text: "This setting is no longer available",
              }, signal);
              offset = Math.max(offset, update.update_id + 1);
              continue;
            }
            try {
              await options.setPollIntervalMs(selected);
            } catch {
              await telegramCall(fetchMessage, config, "answerCallbackQuery", {
                callback_query_id: callback.id,
                text: "Could not save this setting",
                show_alert: true,
              }, signal);
              offset = Math.max(offset, update.update_id + 1);
              continue;
            }
            await telegramCall(fetchMessage, config, "answerCallbackQuery", {
              callback_query_id: callback.id,
              text: `Saved. Polling every ${selected / 1_000}s.`,
            }, signal);
            const messageId = callbackMessage?.message_id;
            if (typeof messageId === "number") {
              await telegramCall(fetchMessage, config, "editMessageText", {
                chat_id: config.chatId,
                message_id: messageId,
                text: `Poll interval set to ${selected / 1_000}s`,
                reply_markup: settingKeyboard(selected),
              }, signal);
            }
          }
          offset = Math.max(offset, update.update_id + 1);
        }
      } catch (error) {
        if (!signal.aborted) log.warn("Telegram settings polling failed", {
          error: error instanceof Error ? error.name : "unknown error",
        });
        if (!signal.aborted) await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
  },
});

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
