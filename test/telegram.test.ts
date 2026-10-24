import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTelegramNotifier, makeTelegramSettingsController } from "../src/telegram.js";

const servers: Server[] = [];

const localTelegram = async (status: number, body: unknown) => {
  let received: { url: string | undefined; method: string | undefined; body: string } | null = null;
  const server = createServer((request, response) => {
    let text = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => (text += chunk));
    request.on("end", () => {
      received = { url: request.url, method: request.method, body: text };
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const fetchMessage: typeof fetch = (_input, init) => fetch(`http://127.0.0.1:${address.port}/sendMessage`, init);
  return { fetchMessage, received: () => received, server };
};

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )),
  );
});

describe("Telegram notifier", () => {
  it("sends a plain-text notification to the configured chat", async () => {
    const api = await localTelegram(200, { ok: true, result: {} });
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const notifier = makeTelegramNotifier(
      { enabled: true, botToken: "test-token", chatId: "12345", timeoutMs: 1_000 },
      log,
      api.fetchMessage,
    );

    await notifier.notify({ _tag: "started", pool: "pool-address", dryRun: false });

    expect(api.received()).toEqual({
      url: "/sendMessage",
      method: "POST",
      body: JSON.stringify({
        chat_id: "12345",
        text: "DLMM bot started\nMode: LIVE, transactions may be sent\nPool: pool-address",
      }),
    });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("contains Telegram failures and does not log the token", async () => {
    const api = await localTelegram(401, { ok: false, description: "unauthorized" });
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const notifier = makeTelegramNotifier(
      { enabled: true, botToken: "secret-token", chatId: "12345", timeoutMs: 1_000 },
      log,
      api.fetchMessage,
    );

    await expect(notifier.notify({ _tag: "halt", reason: "stale-chain" })).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith("Telegram notification rejected", { status: 401 });
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain("secret-token");
  });

  it("does not call the network when disabled", async () => {
    const fetchMessage = vi.fn<typeof fetch>();
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const notifier = makeTelegramNotifier({ enabled: false }, log, fetchMessage);

    await notifier.notify({ _tag: "halt", reason: "stale-chain" });

    expect(fetchMessage).not.toHaveBeenCalled();
  });

  it("shows settings for an authorized /settings command and persists an allowed choice", async () => {
    const requests: { method: string; body: Record<string, unknown> }[] = [];
    const updates = [
      [{ update_id: 1, message: { chat: { id: 12345, type: "private" }, from: { id: 12345 }, text: "/settings" } }],
      [{ update_id: 2, callback_query: { id: "cb-1", data: "poll:8000", from: { id: 12345 }, message: { message_id: 9, chat: { id: 12345, type: "private" } } } }],
      [],
    ];
    const controller = new AbortController();
    const fetchMessage: typeof fetch = async (input, init) => {
      const method = String(input).split("/").pop() ?? "";
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ method, body });
      if (method === "getUpdates") {
        const result = updates.shift() ?? [];
        if (requests.filter((request) => request.method === "getUpdates").length === 3) controller.abort();
        return Response.json({ ok: true, result });
      }
      return Response.json({ ok: true, result: {} });
    };
    const setPollIntervalMs = vi.fn(async (_value: number) => undefined);
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    await makeTelegramSettingsController(
      { enabled: true, botToken: "secret-token", chatId: "12345", timeoutMs: 1_000 },
      log,
      { getPollIntervalMs: () => 4_000, setPollIntervalMs },
      fetchMessage,
    ).start(controller.signal);

    expect(requests.find((request) => request.method === "sendMessage")?.body).toEqual({
      chat_id: "12345",
      text: "Poll interval: 4s",
      reply_markup: { inline_keyboard: [1, 2, 4, 8, 15, 30].map((seconds) => [{
        text: `${seconds}s${seconds === 4 ? " ✓" : ""}`,
        callback_data: `poll:${seconds * 1_000}`,
      }]) },
    });
    expect(setPollIntervalMs).toHaveBeenCalledWith(8_000);
    expect(requests.map((request) => request.method)).toContain("answerCallbackQuery");
    expect(requests.find((request) => request.method === "editMessageText")?.body.text).toBe("Poll interval set to 8s");
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain("secret-token");
  });

  it("ignores unauthorized callbacks without reading or changing settings", async () => {
    const requests: string[] = [];
    const controller = new AbortController();
    const fetchMessage: typeof fetch = async (input) => {
      const method = String(input).split("/").pop() ?? "";
      requests.push(method);
      if (method === "getUpdates") {
        controller.abort();
        return Response.json({ ok: true, result: [{ update_id: 1, callback_query: {
          id: "bad", data: "poll:8000", from: { id: 999 },
          message: { message_id: 3, chat: { id: 12345, type: "private" } },
        } }] });
      }
      return Response.json({ ok: true, result: {} });
    };
    const getPollIntervalMs = vi.fn(() => 4_000);
    const setPollIntervalMs = vi.fn(async (_value: number) => undefined);
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    await makeTelegramSettingsController(
      { enabled: true, botToken: "secret-token", chatId: "12345", timeoutMs: 1_000 },
      log,
      { getPollIntervalMs, setPollIntervalMs },
      fetchMessage,
    ).start(controller.signal);

    expect(getPollIntervalMs).not.toHaveBeenCalled();
    expect(setPollIntervalMs).not.toHaveBeenCalled();
    expect(requests).toEqual(["getUpdates"]);
  });
});
