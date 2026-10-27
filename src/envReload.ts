import { readFileSync, statSync } from "node:fs";
import { parse } from "dotenv";
import { parseConfig, type Config, type Env } from "./config.js";
import type { Logger } from "./log.js";

// Fields that are wired into long-lived objects at startup (RPC connection, wallet,
// Telegram poller, logger), so a changed .env value only takes effect after a restart.
const restartFields = ["rpcUrl", "wsUrl", "poolAddress", "wallet", "stateDir", "logLevel", "telegram"] as const;

const readFile = (path: string): Record<string, string> | null => {
  try {
    return parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
};

const mtimeOf = (path: string): number | null => {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
};

export type EnvReloader = Readonly<{ check(): void }>;

export const makeEnvReloader = (
  path: string,
  initialEnv: Env,
  initial: Config,
  apply: (next: Config) => readonly string[],
  log: Logger,
): EnvReloader => {
  // Variables set in the shell win over the file, same as dotenv. Anything the
  // startup file load put in the environment is treated as file owned.
  const startupFile = readFile(path) ?? {};
  const fileOwned = new Set(Object.keys(startupFile).filter((key) => initialEnv[key] === startupFile[key]));
  let lastMtime = mtimeOf(path);
  let current = initial;

  const check = (): void => {
    const mtime = mtimeOf(path);
    if (mtime === null || mtime === lastMtime) return;
    lastMtime = mtime;
    const file = readFile(path);
    if (file === null) {
      log.warn(".env could not be read; keeping the current config");
      return;
    }
    const env: Record<string, string | undefined> = { ...initialEnv };
    for (const key of fileOwned) delete env[key];
    const next = new Set<string>();
    for (const [key, value] of Object.entries(file)) {
      if (key in env && !fileOwned.has(key)) continue;
      env[key] = value;
      next.add(key);
    }
    const parsed = parseConfig(env);
    if (parsed._tag === "err") {
      log.warn(".env changed but is invalid; keeping the current config", {
        errors: parsed.errors.map((e) => `${e.field}: ${e.message}`),
      });
      return;
    }
    fileOwned.clear();
    for (const key of next) fileOwned.add(key);
    const needsRestart = restartFields.filter((field) => JSON.stringify(current[field]) !== JSON.stringify(parsed.config[field]));
    const changed = apply(parsed.config);
    current = parsed.config;
    log.info(".env reloaded", { applied: changed });
    if (needsRestart.length > 0) {
      log.warn("some .env changes need a restart to take effect", { fields: needsRestart });
    }
  };
  return { check };
};
