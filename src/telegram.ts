import type { TelegramConfig } from "./config.js";
import type { ActResult } from "./chain/act.js";
import type { Logger } from "./log.js";

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
      return `Tiang Rebalance DLMM Bot started\nPool: ${alert.pool}\nMode: ${alert.dryRun ? "dry run" : "LIVE"}`;
    case "action":
      switch (alert.result._tag) {
        case "opened":
          return `Position opened\nAddress: ${alert.result.position.toBase58()}`;
        case "closed":
          return `Position closed\nAddress: ${alert.result.position.toBase58()}`;
        case "rebalanced":
          return `Position rebalanced\nFrom: ${alert.result.from.toBase58()}\nTo: ${alert.result.to?.toBase58() ?? "none"}`;
      }
    case "halt":
      return `Bot halted\nReason: ${alert.reason}`;
    case "cycle-error":
      return `Bot cycle failed\n${alert.message.replace(/https?:\/\/\S+/g, "[URL redacted]").slice(0, 2_000)}`;
  }
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
