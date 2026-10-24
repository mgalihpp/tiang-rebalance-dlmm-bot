import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "./log.js";

export const pollIntervals = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000] as const;
export type RuntimeSettings = { readonly pollIntervalMs: number };

export type RuntimeSettingsStore = {
  readonly getPollIntervalMs: () => RuntimeSettings["pollIntervalMs"];
  readonly setPollIntervalMs: (value: number) => Promise<void>;
};

const isPollInterval = (value: unknown): value is RuntimeSettings["pollIntervalMs"] =>
  typeof value === "number" && (pollIntervals as readonly number[]).includes(value);

export const makeRuntimeSettingsStore = (
  stateDir: string,
  initialPollIntervalMs: number,
  log: Logger,
): RuntimeSettingsStore => {
  const settingsPath = join(stateDir, "runtime-settings.json");
  let pollIntervalMs = Number.isInteger(initialPollIntervalMs) && initialPollIntervalMs >= 500 && initialPollIntervalMs <= 120_000
    ? initialPollIntervalMs
    : 4_000;

  try {
    const stored: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
    if (typeof stored === "object" && stored !== null && "version" in stored && stored.version === 1 &&
      "pollIntervalMs" in stored && isPollInterval(stored.pollIntervalMs)) {
      pollIntervalMs = stored.pollIntervalMs;
    } else {
      log.warn("Telegram settings file is invalid; using configured defaults");
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      log.warn("Telegram settings file could not be read; using configured defaults", {
        error: error instanceof Error ? error.name : "unknown error",
      });
    }
  }

  return {
    getPollIntervalMs: () => pollIntervalMs,
    setPollIntervalMs: async (value) => {
      if (!isPollInterval(value)) throw new Error("unsupported Telegram poll interval");
      mkdirSync(stateDir, { recursive: true });
      const temporaryPath = `${settingsPath}.${process.pid}.tmp`;
      writeFileSync(temporaryPath, `${JSON.stringify({ version: 1, pollIntervalMs: value }, null, 2)}\n`, "utf8");
      renameSync(temporaryPath, settingsPath);
      pollIntervalMs = value;
    },
  };
};
