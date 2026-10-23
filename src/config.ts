import type { Width } from "./domain/bins.js";

export type WalletSource =
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "inline"; readonly secret: string };

export type Config = {
  readonly rpcUrl: string;
  readonly wsUrl: string | null;
  readonly poolAddress: string;
  readonly wallet: WalletSource;
  readonly width: Width;
  readonly slippagePercent: number;
  readonly maxDeployX: bigint | null;
  readonly maxDeployY: bigint | null;
  readonly minSolReserve: bigint;
  readonly priorityFeeMicroLamports: bigint;
  readonly maxPriorityFeeMicroLamports: bigint;
  readonly pollIntervalMs: number;
  readonly dwellTicks: number;
  readonly maxRebalancesPerHour: number;
  readonly minRebalanceIntervalMs: number;
  readonly maxSnapshotAgeMs: number;
  readonly dryRun: boolean;
  readonly live: boolean;
  readonly stateDir: string;
  readonly logLevel: "debug" | "info" | "warn" | "error";
};

export type ConfigError = { readonly field: string; readonly message: string };

export type ParseResult =
  | { readonly _tag: "ok"; readonly config: Config }
  | { readonly _tag: "err"; readonly errors: readonly ConfigError[] };

export type Env = Readonly<Record<string, string | undefined>>;

const readString = (env: Env, key: string): string | null => {
  const raw = env[key];
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
};

const readBigInt = (env: Env, key: string, fallback: bigint | null): bigint | null | ConfigError => {
  const raw = readString(env, key);
  if (raw === null) return fallback;
  try {
    const value = BigInt(raw);
    if (value < 0n) return { field: key, message: "must be >= 0" };
    return value;
  } catch {
    return { field: key, message: `not an integer: ${raw}` };
  }
};

const readInt = (
  env: Env,
  key: string,
  fallback: number,
  bounds: { min: number; max: number },
): number | ConfigError => {
  const raw = readString(env, key);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) return { field: key, message: `not an integer: ${raw}` };
  if (value < bounds.min || value > bounds.max) {
    return { field: key, message: `must be between ${bounds.min} and ${bounds.max}` };
  }
  return value;
};

const readFloat = (
  env: Env,
  key: string,
  fallback: number,
  bounds: { min: number; max: number },
): number | ConfigError => {
  const raw = readString(env, key);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return { field: key, message: `not a number: ${raw}` };
  if (value < bounds.min || value > bounds.max) {
    return { field: key, message: `must be between ${bounds.min} and ${bounds.max}` };
  }
  return value;
};

const readBool = (env: Env, key: string, fallback: boolean): boolean | ConfigError => {
  const raw = readString(env, key);
  if (raw === null) return fallback;
  const value = raw.toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return { field: key, message: `not a boolean: ${raw}` };
};

const readEnum = <T extends string>(
  env: Env,
  key: string,
  allowed: readonly T[],
  fallback: T,
): T | ConfigError => {
  const raw = readString(env, key);
  if (raw === null) return fallback;
  const value = raw.toLowerCase();
  if ((allowed as readonly string[]).includes(value)) return value as T;
  return { field: key, message: `must be one of ${allowed.join(", ")}` };
};

const isConfigError = (v: unknown): v is ConfigError =>
  typeof v === "object" && v !== null && "field" in v && "message" in v;

export const deriveWsUrl = (rpcUrl: string): string | null => {
  try {
    const url = new URL(rpcUrl);
    if (url.protocol === "https:") url.protocol = "wss:";
    else if (url.protocol === "http:") url.protocol = "ws:";
    else return null;
    return url.toString();
  } catch {
    return null;
  }
};

export const parseConfig = (env: Env): ParseResult => {
  const errors: ConfigError[] = [];
  const collect = <T>(value: T | ConfigError): T | null => {
    if (isConfigError(value)) {
      errors.push(value);
      return null;
    }
    return value;
  };

  const rpcUrl = readString(env, "RPC_URL") ?? "https://api.mainnet-beta.solana.com";
  const wsUrl = readString(env, "WS_URL") ?? deriveWsUrl(rpcUrl);

  const poolAddress = readString(env, "POOL_ADDRESS");
  if (poolAddress === null) errors.push({ field: "POOL_ADDRESS", message: "required" });

  const keypairPath = readString(env, "WALLET_KEYPAIR_PATH");
  const inlineSecret = readString(env, "WALLET_SECRET_KEY");
  let wallet: WalletSource | null = null;
  if (inlineSecret !== null) wallet = { kind: "inline", secret: inlineSecret };
  else if (keypairPath !== null) wallet = { kind: "file", path: keypairPath };
  else errors.push({ field: "WALLET_KEYPAIR_PATH", message: "required (or WALLET_SECRET_KEY)" });

  const width = collect(readEnum(env, "POSITION_WIDTH", ["1", "2"] as const, "1"));
  const slippagePercent = collect(readFloat(env, "SLIPPAGE_PERCENT", 1, { min: 0.01, max: 10 }));
  const maxDeployX = collect(readBigInt(env, "MAX_DEPLOY_X", null));
  const maxDeployY = collect(readBigInt(env, "MAX_DEPLOY_Y", null));
  const minSolReserveSol = collect(readFloat(env, "MIN_SOL_RESERVE_SOL", 0.05, { min: 0, max: 1000 }));
  const priorityFeeMicroLamports = collect(
    readBigInt(env, "PRIORITY_FEE_MICRO_LAMPORTS", 50_000n),
  );
  const maxPriorityFeeMicroLamports = collect(
    readBigInt(env, "MAX_PRIORITY_FEE_MICRO_LAMPORTS", 2_000_000n),
  );
  const pollIntervalMs = collect(readInt(env, "POLL_INTERVAL_MS", 4_000, { min: 500, max: 120_000 }));
  const dwellTicks = collect(readInt(env, "DWELL_TICKS", 2, { min: 1, max: 60 }));
  const maxRebalancesPerHour = collect(
    readInt(env, "MAX_REBALANCES_PER_HOUR", 20, { min: 1, max: 10_000 }),
  );
  const minRebalanceIntervalMs = collect(
    readInt(env, "MIN_REBALANCE_INTERVAL_MS", 60_000, { min: 0, max: 86_400_000 }),
  );
  const maxSnapshotAgeMs = collect(
    readInt(env, "MAX_SNAPSHOT_AGE_MS", 30_000, { min: 1_000, max: 600_000 }),
  );
  const dryRun = collect(readBool(env, "DRY_RUN", true));
  const live = collect(readBool(env, "LIVE", false));
  const stateDir = readString(env, "STATE_DIR") ?? "./state";
  const logLevel = collect(
    readEnum(env, "LOG_LEVEL", ["debug", "info", "warn", "error"] as const, "info"),
  );

  if (poolAddress !== null && poolAddress.length < 32) {
    errors.push({ field: "POOL_ADDRESS", message: "does not look like a base58 pubkey" });
  }
  if (priorityFeeMicroLamports !== null && maxPriorityFeeMicroLamports !== null) {
    if (priorityFeeMicroLamports > maxPriorityFeeMicroLamports) {
      errors.push({
        field: "PRIORITY_FEE_MICRO_LAMPORTS",
        message: "exceeds MAX_PRIORITY_FEE_MICRO_LAMPORTS",
      });
    }
  }
  if (live && dryRun) {
    errors.push({
      field: "LIVE",
      message: "LIVE=true with DRY_RUN=true sends nothing; set DRY_RUN=false to trade",
    });
  }
  if (errors.length > 0) return { _tag: "err", errors };

  return {
    _tag: "ok",
    config: {
      rpcUrl,
      wsUrl,
      poolAddress: poolAddress as string,
      wallet: wallet as WalletSource,
      width: Number(width) as Width,
      slippagePercent: slippagePercent as number,
      maxDeployX,
      maxDeployY,
      minSolReserve: BigInt(Math.round((minSolReserveSol as number) * 1e9)),
      priorityFeeMicroLamports: priorityFeeMicroLamports as bigint,
      maxPriorityFeeMicroLamports: maxPriorityFeeMicroLamports as bigint,
      pollIntervalMs: pollIntervalMs as number,
      dwellTicks: dwellTicks as number,
      maxRebalancesPerHour: maxRebalancesPerHour as number,
      minRebalanceIntervalMs: minRebalanceIntervalMs as number,
      maxSnapshotAgeMs: maxSnapshotAgeMs as number,
      dryRun: dryRun as boolean,
      live: live as boolean,
      stateDir,
      logLevel: logLevel as Config["logLevel"],
    },
  };
};
