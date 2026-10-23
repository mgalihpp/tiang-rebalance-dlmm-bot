import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTelegramNotifier } from "../src/telegram.js";

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
        text: "Tiang Rebalance DLMM Bot started\nPool: pool-address\nMode: LIVE",
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
});
