import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseConfig } from "../src/config.js";
import { makeSettingsStore } from "../src/settings.js";

const dirs: string[] = [];
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const make = () => {
  const stateDir = mkdtempSync(join(tmpdir(), "settings-test-"));
  dirs.push(stateDir);
  const parsed = parseConfig({ POOL_ADDRESS: "5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6", WALLET_KEYPAIR_PATH: "./wallet.json", STATE_DIR: stateDir });
  if (parsed._tag !== "ok") throw new Error("test config invalid");
  return { store: makeSettingsStore(parsed.config, logger), config: parsed.config, stateDir };
};
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("settings store", () => {
  it("migrates v1 polling settings and persists v2 snapshots", async () => {
    const { store, stateDir, config } = make();
    const path = join(stateDir, "runtime-settings.json");
    await import("node:fs").then(({ writeFileSync }) => writeFileSync(path, JSON.stringify({ version: 1, pollIntervalMs: 8_000 })));
    const migrated = makeSettingsStore(config, logger);
    expect(migrated.currentConfig().pollIntervalMs).toBe(8_000);
    expect((await migrated.set("priorityFeeMicroLamports", "100000")).ok).toBe(true);
    expect(readFileSync(path, "utf8")).toContain('"version": 2');
    expect(readFileSync(path, "utf8")).not.toContain("secret");
    expect(makeSettingsStore(config, logger).currentConfig().priorityFeeMicroLamports).toBe(100_000n);
  });

  it("rejects range and cross-field violations without changing current values", async () => {
    const { store } = make();
    expect((await store.set("dwellTicks", "61")).ok).toBe(false);
    expect((await store.set("priorityFeeMicroLamports", "3000000")).ok).toBe(false);
    expect(store.currentConfig().dwellTicks).toBe(2);
    expect(store.currentConfig().priorityFeeMicroLamports).toBe(50_000n);
    expect((await store.set("walletKeypairPath", "111111111111111111111111111111111111111111111111111111111")).ok).toBe(false);
  });

  it("requires explicit live confirmation and tracks restart-only differences", async () => {
    const { store } = make();
    expect((await store.set("mode", "live")).ok).toBe(false);
    const enabled = await store.set("mode", "live", true);
    expect(enabled).toEqual(expect.objectContaining({ ok: true }));
    expect(store.currentConfig().live).toBe(true);
    const result = await store.set("poolAddress", "11111111111111111111111111111111");
    expect(result.ok).toBe(true);
    expect(store.snapshot().pendingRestart).toContain("poolAddress");
  });

  it("resets persisted changes to environment defaults", async () => {
    const { store } = make();
    await store.set("pollIntervalMs", "8000");
    await store.reset();
    expect(store.currentConfig().pollIntervalMs).toBe(4_000);
    expect(store.snapshot().pendingRestart).toEqual([]);
  });

  it("does not publish an update when persistence fails", async () => {
    const { store, stateDir } = make();
    rmSync(stateDir, { recursive: true, force: true });
    writeFileSync(stateDir, "not a directory");
    const result = await store.set("pollIntervalMs", "8000");
    expect(result.ok).toBe(false);
    expect(store.currentConfig().pollIntervalMs).toBe(4_000);
  });
});
