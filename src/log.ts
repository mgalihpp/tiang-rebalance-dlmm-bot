export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type Logger = {
  readonly debug: (message: string, fields?: Record<string, unknown>) => void;
  readonly info: (message: string, fields?: Record<string, unknown>) => void;
  readonly warn: (message: string, fields?: Record<string, unknown>) => void;
  readonly error: (message: string, fields?: Record<string, unknown>) => void;
};

export const makeLogger = (level: LogLevel, sink: (line: string) => void = console.log): Logger => {
  const min = ORDER[level];
  const emit = (lvl: LogLevel, message: string, fields?: Record<string, unknown>): void => {
    if (ORDER[lvl] < min) return;
    const record: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level: lvl,
      message,
      ...fields,
    };
    sink(JSON.stringify(record));
  };
  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
  };
};
