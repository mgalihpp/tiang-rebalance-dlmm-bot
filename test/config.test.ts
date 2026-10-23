import { describe, expect, it } from "vitest";
import { deriveWsUrl, parseConfig, type Env } from "../src/config.js";

const base: Env = {
  POOL_ADDRESS: "5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6",
  WALLET_KEYPAIR_PATH: "./wallet.json",
};

const ok = (env: Env) => {
  const result = parseConfig(env);
  if (result._tag !== "ok") throw new Error(JSON.stringify(result.errors));
  return result.config;
};

describe("parseConfig", () => {
  it("applies safe defaults", () => {
    const config = ok(base);
    expect(config.width).toBe(1);
    expect(config.dryRun).toBe(true);
    expect(config.live).toBe(false);
    expect(config.slippagePercent).toBe(1);
    expect(config.minSolReserve).toBe(50_000_000n);
    expect(config.maxRebalancesPerHour).toBe(20);
    expect(config.telegram).toEqual({ enabled: false });
  });

  it("requires both Telegram credentials", () => {
    expect(parseConfig({ ...base, TELEGRAM_BOT_TOKEN: "secret" })._tag).toBe("err");
    expect(parseConfig({ ...base, TELEGRAM_CHAT_ID: "123" })._tag).toBe("err");
  });

  it("enables Telegram alerts when both credentials are set", () => {
    const config = ok({
      ...base,
      TELEGRAM_BOT_TOKEN: "secret",
      TELEGRAM_CHAT_ID: "123",
      TELEGRAM_TIMEOUT_MS: "5000",
    });
    expect(config.telegram).toEqual({
      enabled: true,
      botToken: "secret",
      chatId: "123",
      timeoutMs: 5000,
    });
  });

  it("requires a pool address", () => {
    const result = parseConfig({ WALLET_KEYPAIR_PATH: "./wallet.json" });
    expect(result._tag).toBe("err");
  });

  it("refuses LIVE with DRY_RUN still on", () => {
    const result = parseConfig({ ...base, LIVE: "true" });
    expect(result._tag).toBe("err");
  });

  it("accepts live trading only with dry run disabled", () => {
    const config = ok({ ...base, LIVE: "true", DRY_RUN: "false" });
    expect(config.live).toBe(true);
    expect(config.dryRun).toBe(false);
  });

  it("accepts width 3", () => {
    expect(ok({ ...base, POSITION_WIDTH: "3" }).width).toBe(3);
  });

  it("rejects a width outside 1..3", () => {
    expect(parseConfig({ ...base, POSITION_WIDTH: "4" })._tag).toBe("err");
  });

  it("rejects a priority fee above the cap", () => {
    const result = parseConfig({
      ...base,
      PRIORITY_FEE_MICRO_LAMPORTS: "5000000",
      MAX_PRIORITY_FEE_MICRO_LAMPORTS: "1000000",
    });
    expect(result._tag).toBe("err");
  });

  it("reads a token cap", () => {
    const config = ok({ ...base, MAX_DEPLOY_Y: "2500000" });
    expect(config.maxDeployY).toBe(2_500_000n);
  });

  it("derives the websocket url from https", () => {
    expect(deriveWsUrl("https://mainnet.helius-rpc.com/?api-key=abc")).toBe(
      "wss://mainnet.helius-rpc.com/?api-key=abc",
    );
  });
});
