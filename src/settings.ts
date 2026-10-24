import { mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.js";
import type { Logger } from "./log.js";

export type RuntimeSettings = Readonly<Pick<Config,
  "width" | "slippagePercent" | "maxDeployX" | "maxDeployY" | "minSolReserve" |
  "priorityFeeMicroLamports" | "maxPriorityFeeMicroLamports" | "pollIntervalMs" |
  "dwellTicks" | "maxRebalancesPerHour" | "minRebalanceIntervalMs" | "maxSnapshotAgeMs"> & {
    mode: "dry-run" | "live";
  }>;

export type SettingKey = keyof RuntimeSettings | "poolAddress" | "walletKeypairPath" | "logLevel" | "telegramTimeoutMs";
export type SettingsSnapshot = Readonly<{
  runtime: RuntimeSettings;
  restart: Readonly<{ poolAddress: string; walletKeypairPath: string; logLevel: Config["logLevel"]; telegramTimeoutMs: number }>;
  pendingRestart: readonly SettingKey[];
}>;
export type SettingsUpdateResult =
  | { readonly ok: true; readonly snapshot: SettingsSnapshot }
  | { readonly ok: false; readonly message: string; readonly confirmationRequired?: true };
export type SettingsStore = Readonly<{
  currentConfig(): Config;
  snapshot(): SettingsSnapshot;
  set(key: SettingKey, rawValue: string, confirmLive?: boolean): Promise<SettingsUpdateResult>;
  reset(): Promise<void>;
}>;

const runtimeKeys = ["width", "slippagePercent", "maxDeployX", "maxDeployY", "minSolReserve", "priorityFeeMicroLamports", "maxPriorityFeeMicroLamports", "pollIntervalMs", "dwellTicks", "maxRebalancesPerHour", "minRebalanceIntervalMs", "maxSnapshotAgeMs", "mode"] as const;
const restartKeys = ["poolAddress", "walletKeypairPath", "logLevel", "telegramTimeoutMs"] as const;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const safeError = (error: unknown): string => error instanceof Error ? error.name : "unknown error";

export const makeSettingsStore = (config: Config, log: Logger): SettingsStore => {
  const path = join(config.stateDir, "runtime-settings.json");
  const base = config;
  const initialRestart = {
    poolAddress: config.poolAddress,
    walletKeypairPath: config.wallet.kind === "file" ? config.wallet.path : "environment wallet",
    logLevel: config.logLevel,
    telegramTimeoutMs: config.telegram.enabled ? config.telegram.timeoutMs : 3_000,
  };
  let values: Record<string, unknown> = {};
  try {
    const data: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (isRecord(data) && data.version === 1 && Number.isInteger(data.pollIntervalMs) && typeof data.pollIntervalMs === "number" && data.pollIntervalMs >= 500 && data.pollIntervalMs <= 120_000) {
      values = { pollIntervalMs: data.pollIntervalMs };
    } else if (isRecord(data) && data.version === 2 && isRecord(data.values)) {
      values = validateStored(data.values, base);
    } else log.warn("Runtime settings file is invalid; using configured defaults");
  } catch (error) {
    if (!(isRecord(error) && error.code === "ENOENT")) log.warn("Runtime settings could not be read; using configured defaults", { error: safeError(error) });
  }

  const makeConfig = (): Config => {
    const v = values;
    const mode = typeof v.mode === "string" ? v.mode : base.live && !base.dryRun ? "live" : "dry-run";
    const restart = { ...initialRestart, ...v };
    const wallet = typeof restart.walletKeypairPath === "string" && restart.walletKeypairPath !== "environment wallet"
      ? { kind: "file" as const, path: restart.walletKeypairPath }
      : base.wallet;
    const telegram = base.telegram.enabled
      ? { ...base.telegram, timeoutMs: typeof restart.telegramTimeoutMs === "number" ? restart.telegramTimeoutMs : base.telegram.timeoutMs }
      : base.telegram;
    return {
      ...base,
      width: typeof v.width === "number" ? v.width as Config["width"] : base.width,
      slippagePercent: numberValue(v, "slippagePercent", base.slippagePercent),
      maxDeployX: bigintValue(v.maxDeployX, base.maxDeployX), maxDeployY: bigintValue(v.maxDeployY, base.maxDeployY),
      minSolReserve: bigintOnly(v.minSolReserve, base.minSolReserve),
      priorityFeeMicroLamports: bigintOnly(v.priorityFeeMicroLamports, base.priorityFeeMicroLamports),
      maxPriorityFeeMicroLamports: bigintOnly(v.maxPriorityFeeMicroLamports, base.maxPriorityFeeMicroLamports),
      pollIntervalMs: numberValue(v, "pollIntervalMs", base.pollIntervalMs), dwellTicks: numberValue(v, "dwellTicks", base.dwellTicks),
      maxRebalancesPerHour: numberValue(v, "maxRebalancesPerHour", base.maxRebalancesPerHour),
      minRebalanceIntervalMs: numberValue(v, "minRebalanceIntervalMs", base.minRebalanceIntervalMs),
      maxSnapshotAgeMs: numberValue(v, "maxSnapshotAgeMs", base.maxSnapshotAgeMs),
      live: mode === "live", dryRun: mode !== "live", poolAddress: typeof restart.poolAddress === "string" ? restart.poolAddress : base.poolAddress,
      wallet, logLevel: isLogLevel(restart.logLevel) ? restart.logLevel : base.logLevel, telegram,
    };
  };
  const snapshot = (): SettingsSnapshot => {
    const c = makeConfig();
    const runtime: RuntimeSettings = {
      width: c.width, slippagePercent: c.slippagePercent, maxDeployX: c.maxDeployX, maxDeployY: c.maxDeployY,
      minSolReserve: c.minSolReserve, priorityFeeMicroLamports: c.priorityFeeMicroLamports,
      maxPriorityFeeMicroLamports: c.maxPriorityFeeMicroLamports, pollIntervalMs: c.pollIntervalMs, dwellTicks: c.dwellTicks,
      maxRebalancesPerHour: c.maxRebalancesPerHour, minRebalanceIntervalMs: c.minRebalanceIntervalMs,
      maxSnapshotAgeMs: c.maxSnapshotAgeMs, mode: c.live && !c.dryRun ? "live" : "dry-run",
    };
    const restart = { ...initialRestart, ...values };
    const pendingRestart = restartKeys.filter((key) => restart[key] !== initialRestart[key]);
    return { runtime, restart: restart as SettingsSnapshot["restart"], pendingRestart };
  };
  const set = async (key: SettingKey, rawValue: string, confirmLive = false): Promise<SettingsUpdateResult> => {
    const parsed = parseSetting(key, rawValue, makeConfig());
    if (!parsed.ok) return { ok: false, message: parsed.message };
    if (key === "mode" && parsed.value === "live" && !confirmLive) return { ok: false, message: "Live trading can move funds. Confirm separately to enable live mode.", confirmationRequired: true };
    const next = { ...values, [key]: parsed.value };
    const current = makeConfig();
    const priority = key === "priorityFeeMicroLamports" ? parsed.value as bigint : current.priorityFeeMicroLamports;
    const maximum = key === "maxPriorityFeeMicroLamports" ? parsed.value as bigint : current.maxPriorityFeeMicroLamports;
    if (priority > maximum) return { ok: false, message: "Priority fee must be less than or equal to the maximum priority fee." };
    try {
      mkdirSync(config.stateDir, { recursive: true });
      const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
      try {
        writeFileSync(temp, `${JSON.stringify({ version: 2, values: serialize(next) }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
        renameSync(temp, path);
      } catch (error) {
        try { unlinkSync(temp); } catch { }
        throw error;
      }
      values = next;
      return { ok: true, snapshot: snapshot() };
    } catch (error) {
      log.warn("Runtime setting could not be saved", { error: safeError(error) });
      return { ok: false, message: "Could not save this setting. The current value is unchanged." };
    }
  };
  return { currentConfig: makeConfig, snapshot, set, reset: async () => {
    mkdirSync(config.stateDir, { recursive: true });
    const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temp, "{\"version\":2,\"values\":{}}\n", { encoding: "utf8", flag: "wx" });
    renameSync(temp, path);
    values = {};
  } };
};

const numberValue = (values: Record<string, unknown>, key: string, fallback: number): number => typeof values[key] === "number" ? values[key] as number : fallback;
const bigintValue = (value: unknown, fallback: bigint | null): bigint | null => typeof value === "bigint" ? value : typeof value === "string" ? BigInt(value) : fallback;
const bigintOnly = (value: unknown, fallback: bigint): bigint => typeof value === "bigint" ? value : typeof value === "string" ? BigInt(value) : fallback;
const isLogLevel = (value: unknown): value is Config["logLevel"] => value === "debug" || value === "info" || value === "warn" || value === "error";
const serialize = (values: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(values).map(([key, value]) => [key, typeof value === "bigint" ? value.toString() : value]));

const validateStored = (stored: Record<string, unknown>, config: Config): Record<string, unknown> => {
  if (Object.keys(stored).some((key) => ![...runtimeKeys, ...restartKeys].includes(key as SettingKey))) throw new Error("invalid settings");
  const parsed: Record<string, unknown> = {};
  for (const key of [...runtimeKeys, ...restartKeys]) {
    if (!(key in stored)) continue;
    const raw = stored[key];
    if (raw === null && (key === "maxDeployX" || key === "maxDeployY")) {
      parsed[key] = null;
      continue;
    }
    const result = parseSetting(key, typeof raw === "string" ? raw : String(raw), config);
    if (!result.ok) throw new Error("invalid settings");
    parsed[key] = result.value;
  }
  if (parsed.priorityFeeMicroLamports !== undefined && parsed.maxPriorityFeeMicroLamports !== undefined && BigInt(String(parsed.priorityFeeMicroLamports)) > BigInt(String(parsed.maxPriorityFeeMicroLamports))) throw new Error("invalid settings");
  return parsed;
};

type SettingParse = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly message: string };
const parseSetting = (key: SettingKey, raw: string, config: Config): SettingParse => {
  const value = raw.trim();
  const int = (min: number, max: number): number | string => {
    const n = Number(value);
    return Number.isInteger(n) && n >= min && n <= max ? n : `Enter a whole number from ${min} to ${max}.`;
  };
  const amount = (): bigint | null | string => {
    if (value.toLowerCase() === "unlimited" && (key === "maxDeployX" || key === "maxDeployY")) return null;
    if (value.toLowerCase() === "unlimited") return "Enter a nonnegative integer amount.";
    if (!/^(0|[1-9]\d*)$/.test(value)) return "Enter a nonnegative integer amount, or unlimited for a deployment cap.";
    try { return BigInt(value); } catch { return "Enter a nonnegative integer amount."; }
  };
  const parsed: unknown | string = (() => { switch (key) {
    case "width": return value === "1" || value === "2" || value === "3" ? Number(value) : "Choose width 1, 2, or 3.";
    case "mode": return value === "live" || value === "dry-run" ? value : "Choose dry-run or live.";
    case "slippagePercent": { const n = Number(value); return Number.isFinite(n) && n >= 0.01 && n <= 10 ? n : "Enter a percentage from 0.01 to 10."; }
    case "minSolReserve": {
      if (!/^(0|[1-9]\d*)(\.\d{1,9})?$/.test(value)) return "Enter a SOL amount from 0 to 1000, with up to 9 decimal places.";
      const [whole = "0", fraction = ""] = value.split(".");
      const sol = BigInt(whole) * 1_000_000_000n + BigInt(fraction.padEnd(9, "0") || "0");
      return sol <= 1_000_000_000_000n ? sol : "Enter a SOL amount from 0 to 1000.";
    }
    case "maxDeployX": case "maxDeployY": case "priorityFeeMicroLamports": case "maxPriorityFeeMicroLamports": return amount();
    case "pollIntervalMs": return int(500, 120_000);
    case "dwellTicks": return int(1, 60);
    case "maxRebalancesPerHour": return int(1, 10_000);
    case "minRebalanceIntervalMs": return int(0, 86_400_000);
    case "maxSnapshotAgeMs": return int(1_000, 600_000);
    case "poolAddress": return value.length >= 32 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(value) ? value : "Enter a base58 pool address with at least 32 characters.";
    case "walletKeypairPath": return value.length > 0 && value.length <= 1_024 && !/^\s*(?:\[|[1-9A-HJ-NP-Za-km-z]{32,})/.test(value) ? value : "Enter a keypair file path, not private key material, up to 1024 characters.";
    case "logLevel": return isLogLevel(value) ? value : "Choose debug, info, warn, or error.";
    case "telegramTimeoutMs": return int(500, 30_000);
  } })();
  if (typeof parsed === "string") {
    const validString = parsed === value && (key === "mode" ? parsed === "live" || parsed === "dry-run"
      : key === "poolAddress" ? parsed.length >= 32 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(parsed)
      : key === "walletKeypairPath" ? parsed.length > 0 && parsed.length <= 1_024 && !/^\s*(?:\[|[1-9A-HJ-NP-Za-km-z]{32,})/.test(parsed) && !parsed.startsWith("Enter ")
      : key === "logLevel" ? isLogLevel(parsed)
      : false);
    if (!validString) return { ok: false, message: parsed };
  }
  return { ok: true, value: parsed };
};
