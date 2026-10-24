import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeRuntimeSettingsStore } from "../src/settings.js";

const directories: string[] = [];

const makeDirectory = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "dlmm-settings-"));
  directories.push(directory);
  return directory;
};

afterEach(() => {
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});

describe("runtime settings", () => {
  it("persists an allowed poll interval and loads it on restart", async () => {
    const directory = makeDirectory();
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const store = makeRuntimeSettingsStore(directory, 4_000, log);

    await store.setPollIntervalMs(8_000);

    expect(JSON.parse(readFileSync(join(directory, "runtime-settings.json"), "utf8"))).toEqual({
      version: 1,
      pollIntervalMs: 8_000,
    });
    expect(makeRuntimeSettingsStore(directory, 2_000, log).getPollIntervalMs()).toBe(8_000);
  });

  it("rejects values that are not in the Telegram menu", async () => {
    const directory = makeDirectory();
    const store = makeRuntimeSettingsStore(directory, 4_000, {
      debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    });

    await expect(store.setPollIntervalMs(500)).rejects.toThrow("unsupported Telegram poll interval");
    expect(store.getPollIntervalMs()).toBe(4_000);
  });

  it("preserves a valid environment interval that is not a menu choice", () => {
    const directory = makeDirectory();
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    expect(makeRuntimeSettingsStore(directory, 5_000, log).getPollIntervalMs()).toBe(5_000);
  });

  it("uses the configured default when the saved value is invalid", () => {
    const directory = makeDirectory();
    writeFileSync(join(directory, "runtime-settings.json"), JSON.stringify({ version: 1, pollIntervalMs: 500 }));
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    expect(makeRuntimeSettingsStore(directory, 2_000, log).getPollIntervalMs()).toBe(2_000);
    expect(log.warn).toHaveBeenCalledWith("Telegram settings file is invalid; using configured defaults");
  });
});
