import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfig, type Config } from "../src/config.js";
import { makeEnvReloader } from "../src/envReload.js";
import { makeSettingsStore } from "../src/settings.js";

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const pool = "5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6";

const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), "envreload-"));
  const file = join(dir, ".env");
  const body = (extra: string) => `POOL_ADDRESS=${pool}\nWALLET_KEYPAIR_PATH=./w.json\nSTATE_DIR=${dir}\n${extra}\n`;
  writeFileSync(file, body("POSITION_WIDTH=1"));
  const env = { POOL_ADDRESS: pool, WALLET_KEYPAIR_PATH: "./w.json", STATE_DIR: dir, POSITION_WIDTH: "1" };
  const parsed = parseConfig(env);
  if (parsed._tag !== "ok") throw new Error("bad env");
  const store = makeSettingsStore(parsed.config, logger);
  const reloader = makeEnvReloader(file, env, parsed.config, (next: Config) => store.rebase(next), logger);
  const edit = (extra: string, secs: number) => {
    writeFileSync(file, body(extra));
    utimesSync(file, secs, secs);
  };
  return { store, reloader, edit };
};

describe("env hot reload", () => {
  it("applies changed .env values without restart", () => {
    const { store, reloader, edit } = setup();
    edit("POSITION_WIDTH=5", 2_000_000_000);
    reloader.check();
    expect(store.currentConfig().width).toBe(5);
  });

  it("keeps the current config when .env is invalid", () => {
    const { store, reloader, edit } = setup();
    edit("POSITION_WIDTH=abc", 2_000_000_001);
    reloader.check();
    expect(store.currentConfig().width).toBe(1);
  });

  it("lets a new .env edit override an older Telegram change", async () => {
    const { store, reloader, edit } = setup();
    await store.set("width", "3");
    edit("POSITION_WIDTH=7", 2_000_000_002);
    reloader.check();
    expect(store.currentConfig().width).toBe(7);
  });
});
