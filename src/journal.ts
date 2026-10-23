import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { History } from "./domain/types.js";

export type JournalEntry =
  | { readonly ts: number; readonly kind: "decision"; readonly decision: string; readonly detail: string }
  | { readonly ts: number; readonly kind: "open"; readonly position: string; readonly lower: number; readonly upper: number; readonly signature: string | null }
  | { readonly ts: number; readonly kind: "close"; readonly position: string; readonly signatures: readonly string[] }
  | { readonly ts: number; readonly kind: "rebalance"; readonly from: string; readonly to: string | null; readonly closeSignatures: readonly string[]; readonly openSignature: string | null }
  | { readonly ts: number; readonly kind: "halt"; readonly reason: string }
  | { readonly ts: number; readonly kind: "error"; readonly message: string };

export const JOURNAL_FILE = "journal.jsonl";
export const HALT_FILE = "HALT";

export const journalPath = (stateDir: string): string => join(stateDir, JOURNAL_FILE);

export const appendJournal = (stateDir: string, entry: JournalEntry): void => {
  mkdirSync(stateDir, { recursive: true });
  appendFileSync(journalPath(stateDir), `${JSON.stringify(entry)}\n`, "utf8");
};

export const readHistory = (stateDir: string, now: number): History => {
  const path = journalPath(stateDir);
  if (!existsSync(path)) {
    return { rebalancesInLastHour: 0, lastRebalanceAt: null, completedRebalances: 0 };
  }
  const hourAgo = now - 3_600_000;
  let rebalancesInLastHour = 0;
  let completedRebalances = 0;
  let lastRebalanceAt: number | null = null;

  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const entry = parsed as { kind?: unknown; ts?: unknown };
    if (entry.kind !== "rebalance" || typeof entry.ts !== "number") continue;
    completedRebalances += 1;
    if (lastRebalanceAt === null || entry.ts > lastRebalanceAt) lastRebalanceAt = entry.ts;
    if (entry.ts >= hourAgo) rebalancesInLastHour += 1;
  }

  return { rebalancesInLastHour, lastRebalanceAt, completedRebalances };
};

export const haltPath = (stateDir: string): string => join(stateDir, HALT_FILE);

export const isHalted = (stateDir: string): boolean => existsSync(haltPath(stateDir));
