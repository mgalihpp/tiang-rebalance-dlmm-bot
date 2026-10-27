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
  it("registers commands, renders category pages, and accepts a plain-text value after ForceReply", async () => {
    const { config, store } = setup();
    const requests: { method: string; body: Record<string, unknown> }[] = [];
    const updates = [
      [{ update_id: 1, message: { chat: { id: 12345, type: "private" }, from: { id: 12345 }, text: "/settings" } }],
      [{ update_id: 2, callback_query: { id: "cb0", data: "nav:protected", from: { id: 12345 }, message: { message_id: 10, chat: { id: 12345, type: "private" } } } }],
      [{ update_id: 3, callback_query: { id: "cb1", data: "nav:limits", from: { id: 12345 }, message: { message_id: 10, chat: { id: 12345, type: "private" } } } }],
      [{ update_id: 4, callback_query: { id: "cb2", data: "nav:timing", from: { id: 12345 }, message: { message_id: 10, chat: { id: 12345, type: "private" } } } }],
      [{ update_id: 5, callback_query: { id: "cb3", data: "edit:pollIntervalMs", from: { id: 12345 }, message: { message_id: 10, chat: { id: 12345, type: "private" } } } }],
      [{ update_id: 6, message: { chat: { id: 12345, type: "private" }, from: { id: 12345 }, text: "8000" } }],
      [],
    ];
    let pollCount = 0;
    const controller = new AbortController();
    const fetchMessage: typeof fetch = async (input, init) => {
      const method = String(input).split("/").pop() ?? "";
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ method, body });
      if (method === "getUpdates") { pollCount++; if (pollCount === 7) controller.abort(); return Response.json({ ok: true, result: updates.shift() ?? [] }); }
      if (method === "sendMessage" && (body.text as string).includes("Change poll interval")) return Response.json({ ok: true, result: { message_id: 99 } });
      return Response.json({ ok: true, result: {} });
    };
    await makeTelegramSettingsController(config, logger, store, fetchMessage).start(controller.signal);
    expect(requests.find((request) => request.method === "setMyCommands")?.body.commands).toEqual([{ command: "settings", description: "Configure bot settings" }, { command: "status", description: "View active configuration" }]);
    expect(JSON.stringify(requests.find((request) => request.method === "sendMessage")?.body)).toContain("BOT SETTINGS");
    expect(requests.some(({ body }) => String(JSON.stringify(body.reply_markup)).includes("force_reply"))).toBe(true);
    expect(requests.some(({ body }) => String(body.text).includes("minimum SOL reserve: 0.05") && String(body.text).includes("maximum token X deposit (raw units): unlimited"))).toBe(true);
    expect(requests.filter(({ body }) => typeof body.text === "string").every(({ body }) => !String(body.text).includes("undefined"))).toBe(true);
    expect(requests.some(({ body }) => String(body.text).includes("TELEGRAM_BOT_TOKEN") && !String(body.text).includes("test-token"))).toBe(true);
    expect(store.currentConfig().pollIntervalMs).toBe(8_000);
  });

  it("/stop and /resume from the owner toggle the pause; /shutdown acknowledges the update and exits; others are ignored", async () => {
    const { config, store } = setup();
    const controller = new AbortController();
    const requests: { method: string; body: Record<string, unknown> }[] = [];
    const controls = { pause: vi.fn(), resume: vi.fn(), shutdown: vi.fn(), isPaused: () => false };
    const msg = (id: number, from: number, text: string) => ({ update_id: id, message: { chat: { id: 12345, type: "private" }, from: { id: from }, text } });
    const fetchMessage: typeof fetch = async (input, init) => {
      const method = String(input).split("/").pop() ?? "";
      requests.push({ method, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      if (method === "getUpdates" && requests.filter((r) => r.method === "getUpdates").length === 1) return Response.json({ ok: true, result: [
        msg(7, 999, "/stop"), msg(8, 12345, "/stop"), msg(9, 12345, "/resume"), msg(10, 12345, "/shutdown"),
      ] });
      if (method === "getUpdates") controller.abort();
      return Response.json({ ok: true, result: [] });
    };
    await makeTelegramSettingsController(config, logger, store, fetchMessage, controls).start(controller.signal);
    expect(controls.pause).toHaveBeenCalledTimes(1);
    expect(controls.resume).toHaveBeenCalledTimes(1);
    expect(controls.shutdown).toHaveBeenCalledTimes(1);
    expect(requests.filter((r) => r.method === "getUpdates")[1]?.body).toMatchObject({ offset: 11, timeout: 0 });
    expect(requests.some((r) => r.method === "sendMessage" && String(r.body.text).includes("Paused"))).toBe(true);
  });

  it("menu has a Bot Control page with pause/resume buttons and a confirmed shutdown", async () => {
    const { config, store } = setup();
    const controller = new AbortController();
    const requests: { method: string; body: Record<string, unknown> }[] = [];
    let paused = false;
    const controls = { pause: vi.fn(() => { paused = true; }), resume: vi.fn(() => { paused = false; }), shutdown: vi.fn(), isPaused: () => paused };
    const cb = (id: number, data: string) => ({ update_id: id, callback_query: { id: `c${id}`, data, from: { id: 12345 }, message: { message_id: 1, chat: { id: 12345, type: "private" } } } });
    const fetchMessage: typeof fetch = async (input, init) => {
      const method = String(input).split("/").pop() ?? "";
      requests.push({ method, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      if (method === "getUpdates" && requests.filter((r) => r.method === "getUpdates").length === 1) return Response.json({ ok: true, result: [
        { update_id: 1, message: { chat: { id: 12345, type: "private" }, from: { id: 12345 }, text: "/settings" } },
        cb(2, "nav:control"), cb(3, "ctl:pause"), cb(4, "ctl:resume"), cb(5, "ctl:shutdown:ask"), cb(6, "ctl:shutdown:confirm"),
      ] });
      if (method === "getUpdates") controller.abort();
      return Response.json({ ok: true, result: [] });
    };
    await makeTelegramSettingsController(config, logger, store, fetchMessage, controls).start(controller.signal);
    const sent = requests.filter((r) => r.method === "sendMessage");
    expect(JSON.stringify(sent[0]?.body.reply_markup)).toContain("nav:control");
    expect(JSON.stringify(sent[1]?.body.reply_markup)).toContain("ctl:pause");
    expect(JSON.stringify(sent[2]?.body.reply_markup)).toContain("ctl:resume");
    expect(controls.pause).toHaveBeenCalledTimes(1);
    expect(controls.resume).toHaveBeenCalledTimes(1);
    expect(controls.shutdown).toHaveBeenCalledTimes(1);
    expect(requests.filter((r) => r.method === "getUpdates")[1]?.body).toMatchObject({ offset: 7, timeout: 0 });
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
      if (method === "sendMessage" && String(JSON.parse(String(init?.body)).text).includes("Change trading mode")) return Response.json({ ok: true, result: { message_id: 44 } });
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
