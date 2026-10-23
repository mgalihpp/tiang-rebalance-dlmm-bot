import { readFileSync } from "node:fs";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import type { WalletSource } from "./config.js";

const fromBytes = (bytes: Uint8Array, source: string): Keypair => {
  if (bytes.length === 64) return Keypair.fromSecretKey(bytes);
  if (bytes.length === 32) return Keypair.fromSeed(bytes);
  throw new Error(
    `${source} must decode to 32 bytes (seed) or 64 bytes (secret key), got ${bytes.length}`,
  );
};

const fromJson = (raw: string, source: string): Keypair => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${source} starts with "[" but is not valid JSON`);
  }
  if (!Array.isArray(parsed) || !parsed.every((n) => typeof n === "number")) {
    throw new Error(`${source} must be a JSON array of numbers`);
  }
  return fromBytes(Uint8Array.from(parsed as number[]), source);
};

const fromBase58 = (raw: string, source: string): Keypair => {
  try {
    return fromBytes(bs58.decode(raw), source);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${source} must be a JSON array or a base58 string (Phantom/Backpack export). ${detail}`,
    );
  }
};

const decode = (raw: string, source: string): Keypair => {
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) return fromJson(trimmed, source);
  return fromBase58(trimmed, source);
};

export const loadKeypair = (source: WalletSource): Keypair => {
  if (source.kind === "file") {
    return decode(readFileSync(source.path, "utf8"), source.path);
  }
  return decode(source.secret, "WALLET_SECRET_KEY");
};
