import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseConfig } from "../src/config.js";
import { makeTelegramNotifier, makeTelegramSettingsController } from "../src/telegram.js";
import { makeSettingsStore } from "../src/settings.js";

const dirs: string[] = [];
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const setup = () => {
  const stateDir = mkdtempSync(join(tmpdir(), "telegram-test-")); dirs.push(stateDir);
  const result = parseConfig({ POOL_ADDRESS: "5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6", WALLET_KEYPAIR_PATH: "./wallet.json", STATE_DIR: stateDir, TELEGRAM_BOT_TOKEN: "test-token", TELEGRAM_CHAT_ID: "12345" });
  if (result._tag !== "ok") throw new Error("test config invalid");
  return { config: result.config, store: makeSettingsStore(result.config, logger) };
};
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("Telegram settings", () => {
  it("registers commands, renders category pages, and updates through ForceReply", async () => {
    const { config, store } = setup();
    const requests: { method: string; body: Record<string, unknown> }[] = [];
    const updates = [
      [{ update_id: 1, message: { chat: { id: 12345, type: "private" }, from: { id: 12345 }, text: "/settings" } }],
      [{ update_id: 2, callback_query: { id: "cb0", data: "nav:protected", from: { id: 12345 }, message: { message_id: 10, chat: { id: 12345, type: "private" } } } }],
      [{ update_id: 3, callback_query: { id: "cb1", data: "nav:timing", from: { id: 12345 }, message: { message_id: 10, chat: { id: 12345, type: "private" } } } }],
      [{ update_id: 4, callback_query: { id: "cb2", data: "edit:pollIntervalMs", from: { id: 12345 }, message: { message_id: 10, chat: { id: 12345, type: "private" } } } }],
      [{ update_id: 5, message: { chat: { id: 12345, type: "private" }, from: { id: 12345 }, text: "8000", reply_to_message: { message_id: 99 } } }],
      [],
    ];
    let pollCount = 0;
    const controller = new AbortController();
    const fetchMessage: typeof fetch = async (input, init) => {
      const method = String(input).split("/").pop() ?? "";
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ method, body });
      if (method === "getUpdates") { pollCount++; if (pollCount === 6) controller.abort(); return Response.json({ ok: true, result: updates.shift() ?? [] }); }
      if (method === "sendMessage" && (body.text as string).includes("Enter poll interval")) return Response.json({ ok: true, result: { message_id: 99 } });
      return Response.json({ ok: true, result: {} });
    };
    await makeTelegramSettingsController(config, logger, store, fetchMessage).start(controller.signal);
    expect(requests.find((request) => request.method === "setMyCommands")?.body.commands).toEqual([{ command: "settings", description: "Configure bot settings" }, { command: "status", description: "Show current settings" }]);
    expect(JSON.stringify(requests.find((request) => request.method === "sendMessage")?.body)).toContain("Strategy");
    expect(requests.some(({ body }) => String(JSON.stringify(body.reply_markup)).includes("force_reply"))).toBe(true);
    expect(requests.some(({ body }) => String(body.text).includes("TELEGRAM_BOT_TOKEN") && !String(body.text).includes("test-token"))).toBe(true);
    expect(store.currentConfig().pollIntervalMs).toBe(8_000);
  });

  it("does not read unauthorized inputs or accept an invalid callback", async () => {
    const { config, store } = setup();
    const controller = new AbortController();
    const requests: string[] = [];
    const fetchMessage: typeof fetch = async (input) => {
      const method = String(input).split("/").pop() ?? ""; requests.push(method);
      if (method === "getUpdates") { controller.abort(); return Response.json({ ok: true, result: [
        { update_id: 1, message: { chat: { id: 12345, type: "private" }, from: { id: 999 }, text: "/settings" } },
        { update_id: 2, callback_query: { id: "bad", data: "edit:mode", from: { id: 999 }, message: { chat: { id: 12345, type: "private" } } } },
        { update_id: 3, message: { chat: { id: 12345, type: "private" }, from: { id: 999 }, text: "secret-value", reply_to_message: { message_id: 44 } } },
        { update_id: 4, callback_query: { id: "invalid", data: "not-allowed", from: { id: 12345 }, message: { chat: { id: 12345, type: "private" } } } },
      ] }); }
      return Response.json({ ok: true, result: {} });
    };
    const snapshot = vi.spyOn(store, "snapshot");
    await makeTelegramSettingsController(config, logger, store, fetchMessage).start(controller.signal);
    expect(snapshot).not.toHaveBeenCalled();
    expect(requests).toEqual(["setMyCommands", "getUpdates", "answerCallbackQuery"]);
  });

  it("requires a second authorized callback before live mode is stored", async () => {
    const { config, store } = setup();
    const updates = [
      [{ update_id: 1, callback_query: { id: "1", data: "edit:mode", from: { id: 12345 }, message: { chat: { id: 12345, type: "private" } } } }],
      [{ update_id: 2, message: { chat: { id: 12345, type: "private" }, from: { id: 12345 }, text: "live", reply_to_message: { message_id: 44 } } }],
      [{ update_id: 3, callback_query: { id: "3", data: "confirm:live", from: { id: 12345 }, message: { chat: { id: 12345, type: "private" } } } }],
      [],
    ];
    let count = 0; const controller = new AbortController(); const methods: string[] = [];
    const fetchMessage: typeof fetch = async (input, init) => {
      const method = String(input).split("/").pop() ?? ""; methods.push(method);
      if (method === "getUpdates") { if (++count === 4) controller.abort(); return Response.json({ ok: true, result: updates.shift() ?? [] }); }
      if (method === "sendMessage" && String(JSON.parse(String(init?.body)).text).includes("Enter mode")) return Response.json({ ok: true, result: { message_id: 44 } });
      return Response.json({ ok: true, result: {} });
    };
    await makeTelegramSettingsController(config, logger, store, fetchMessage).start(controller.signal);
    expect(store.currentConfig().live).toBe(true);
    expect(methods).toContain("answerCallbackQuery");
  });
});

describe("Telegram notifier", () => {
  it("sends notifications and contains failures without logging the token", async () => {
    const config = { enabled: true as const, botToken: "secret-token", chatId: "12345", timeoutMs: 1_000 };
    const fetchMessage: typeof fetch = async () => Response.json({ ok: false }, { status: 401 });
    await makeTelegramNotifier(config, logger, fetchMessage).notify({ _tag: "halt", reason: "stale-chain" });
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("secret-token");
  });
});
