import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import { loadKeypair } from "../src/wallet.js";

const keypair = Keypair.generate();
const secret64 = Array.from(keypair.secretKey);
const seed32 = Array.from(keypair.secretKey.slice(0, 32));

describe("loadKeypair", () => {
  it("reads a solana keypair file", () => {
    const dir = mkdtempSync(join(tmpdir(), "dlmm-wallet-"));
    const path = join(dir, "wallet.json");
    writeFileSync(path, JSON.stringify(secret64), "utf8");
    expect(loadKeypair({ kind: "file", path }).publicKey.equals(keypair.publicKey)).toBe(true);
  });

  it("reads a base58 secret key, as exported by Phantom", () => {
    const secret = bs58.encode(Uint8Array.from(secret64));
    expect(loadKeypair({ kind: "inline", secret }).publicKey.equals(keypair.publicKey)).toBe(true);
  });

  it("reads a base58 seed and derives the same keypair", () => {
    const secret = bs58.encode(Uint8Array.from(seed32));
    expect(loadKeypair({ kind: "inline", secret }).publicKey.equals(keypair.publicKey)).toBe(true);
  });

  it("reads a json array from the environment", () => {
    const secret = JSON.stringify(secret64);
    expect(loadKeypair({ kind: "inline", secret }).publicKey.equals(keypair.publicKey)).toBe(true);
  });

  it("rejects a key of the wrong length", () => {
    const secret = bs58.encode(Uint8Array.from([1, 2, 3]));
    expect(() => loadKeypair({ kind: "inline", secret })).toThrow(/32 bytes|64 bytes/);
  });

  it("rejects a json array with non numbers", () => {
    expect(() => loadKeypair({ kind: "inline", secret: '["a"]' })).toThrow(/array of numbers/);
  });

  it("reads base58 text from the key file", () => {
    const dir = mkdtempSync(join(tmpdir(), "dlmm-wallet-"));
    const path = join(dir, "wallet.json");
    writeFileSync(path, `${bs58.encode(Uint8Array.from(secret64))}\n`, "utf8");
    expect(loadKeypair({ kind: "file", path }).publicKey.equals(keypair.publicKey)).toBe(true);
  });

  it("reports both accepted formats when the file is neither", () => {
    const dir = mkdtempSync(join(tmpdir(), "dlmm-wallet-"));
    const path = join(dir, "wallet.json");
    writeFileSync(path, "not-a-key", "utf8");
    expect(() => loadKeypair({ kind: "file", path })).toThrow(/base58/);
  });
});
