import { Keypair, PublicKey, SystemProgram, Transaction, Connection } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import { sendTx } from "../src/chain/send.js";

describe("sendTx", () => {
  it("refreshes an SDK-provided blockhash after simulation and before sending", async () => {
    const owner = Keypair.generate();
    const freshBlockhash = Keypair.generate().publicKey.toBase58();
    const connection = new Connection("http://127.0.0.1:8899");
    const simulate = vi.spyOn(connection, "simulateTransaction").mockResolvedValue({
      context: { slot: 1 },
      value: { err: null, logs: [], accounts: null, unitsConsumed: 1, returnData: null },
    });
    const getLatestBlockhash = vi.spyOn(connection, "getLatestBlockhash").mockResolvedValue({
      blockhash: freshBlockhash,
      lastValidBlockHeight: 200,
    });
    const send = vi.spyOn(connection, "sendRawTransaction").mockResolvedValue("signature");
    const status = vi.spyOn(connection, "getSignatureStatuses").mockResolvedValue({
      context: { slot: 2 },
      value: [{ slot: 2, confirmations: 1, err: null, confirmationStatus: "confirmed", status: { Ok: null } }],
    });
    vi.spyOn(connection, "getBlockHeight").mockResolvedValue(150);

    const tx = new Transaction({
      feePayer: owner.publicKey,
    }).add(
      SystemProgram.transfer({
        fromPubkey: owner.publicKey,
        toPubkey: Keypair.generate().publicKey,
        lamports: 1,
      }),
    );
    tx.recentBlockhash = PublicKey.default.toBase58();
    tx.lastValidBlockHeight = 100;

    await sendTx(
      {
        connection,
        owner,
        dryRun: false,
        priorityFeeMicroLamports: 1n,
        maxPriorityFeeMicroLamports: 100n,
        log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      },
      tx,
      [owner],
      "test",
    );

    expect(getLatestBlockhash).toHaveBeenCalledOnce();
    expect(simulate.mock.invocationCallOrder[0]).toBeLessThan(getLatestBlockhash.mock.invocationCallOrder[0]);
    expect(getLatestBlockhash.mock.invocationCallOrder[0]).toBeLessThan(send.mock.invocationCallOrder[0]);
    expect(send.mock.invocationCallOrder[0]).toBeLessThan(status.mock.invocationCallOrder[0]);
    expect(tx.recentBlockhash).toBe(freshBlockhash);
    expect(tx.lastValidBlockHeight).toBe(200);
  });

  it("fetches a fresh blockhash after simulation on the expired-transaction retry", async () => {
    const owner = Keypair.generate();
    const firstBlockhash = Keypair.generate().publicKey.toBase58();
    const retryBlockhash = Keypair.generate().publicKey.toBase58();
    const connection = new Connection("http://127.0.0.1:8899");
    const simulate = vi.spyOn(connection, "simulateTransaction").mockResolvedValue({
      context: { slot: 1 },
      value: { err: null, logs: [], accounts: null, unitsConsumed: 1, returnData: null },
    });
    const getLatestBlockhash = vi.spyOn(connection, "getLatestBlockhash")
      .mockResolvedValueOnce({ blockhash: firstBlockhash, lastValidBlockHeight: 200 })
      .mockResolvedValueOnce({ blockhash: retryBlockhash, lastValidBlockHeight: 300 });
    const send = vi.spyOn(connection, "sendRawTransaction")
      .mockResolvedValueOnce("expired-signature")
      .mockResolvedValueOnce("confirmed-signature");
    const status = vi.spyOn(connection, "getSignatureStatuses")
      .mockResolvedValueOnce({ context: { slot: 1 }, value: [null] })
      .mockResolvedValueOnce({ context: { slot: 1 }, value: [null] })
      .mockResolvedValueOnce({
        context: { slot: 2 },
        value: [{ slot: 2, confirmations: 1, err: null, confirmationStatus: "confirmed", status: { Ok: null } }],
      });
    vi.spyOn(connection, "getBlockHeight")
      .mockResolvedValueOnce(201)
      .mockResolvedValueOnce(301);
    const tx = new Transaction({ feePayer: owner.publicKey }).add(
      SystemProgram.transfer({
        fromPubkey: owner.publicKey,
        toPubkey: Keypair.generate().publicKey,
        lamports: 1,
      }),
    );
    tx.recentBlockhash = PublicKey.default.toBase58();
    tx.lastValidBlockHeight = 100;

    await sendTx(
      {
        connection,
        owner,
        dryRun: false,
        priorityFeeMicroLamports: 1n,
        maxPriorityFeeMicroLamports: 100n,
        log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      },
      tx,
      [owner],
      "test",
    );

    expect(simulate).toHaveBeenCalledTimes(2);
    expect(getLatestBlockhash).toHaveBeenCalledTimes(2);
    expect(simulate.mock.invocationCallOrder[1]).toBeLessThan(getLatestBlockhash.mock.invocationCallOrder[1]);
    expect(getLatestBlockhash.mock.invocationCallOrder[1]).toBeLessThan(send.mock.invocationCallOrder[1]);
    expect(send.mock.invocationCallOrder[1]).toBeLessThan(status.mock.invocationCallOrder[2]);
    expect(tx.recentBlockhash).toBe(retryBlockhash);
    expect(tx.lastValidBlockHeight).toBe(300);
  });

  it("rebroadcasts the same signed transaction while its blockhash remains valid", async () => {
    const owner = Keypair.generate();
    const connection = new Connection("http://127.0.0.1:8899");
    vi.spyOn(connection, "simulateTransaction").mockResolvedValue({
      context: { slot: 1 },
      value: { err: null, logs: [], accounts: null, unitsConsumed: 1, returnData: null },
    });
    vi.spyOn(connection, "getLatestBlockhash").mockResolvedValue({
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 200,
    });
    const send = vi.spyOn(connection, "sendRawTransaction").mockResolvedValue("signature");
    const status = vi.spyOn(connection, "getSignatureStatuses")
      .mockResolvedValueOnce({ context: { slot: 1 }, value: [null] })
      .mockResolvedValueOnce({
        context: { slot: 2 },
        value: [{ slot: 2, confirmations: 1, err: null, confirmationStatus: "confirmed", status: { Ok: null } }],
      });
    vi.spyOn(connection, "getBlockHeight").mockResolvedValue(150);
    const tx = new Transaction({ feePayer: owner.publicKey }).add(
      SystemProgram.transfer({
        fromPubkey: owner.publicKey,
        toPubkey: Keypair.generate().publicKey,
        lamports: 1,
      }),
    );
    tx.recentBlockhash = PublicKey.default.toBase58();
    tx.lastValidBlockHeight = 100;
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await sendTx(
      { connection, owner, dryRun: false, priorityFeeMicroLamports: 1n, maxPriorityFeeMicroLamports: 100n, log },
      tx,
      [owner],
      "test",
    );

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]?.[0]).toEqual(send.mock.calls[1]?.[0]);
    expect(send.mock.calls[1]?.[1]).toEqual({
      skipPreflight: true,
      maxRetries: 0,
      preflightCommitment: "confirmed",
    });
    expect(status).toHaveBeenCalledTimes(2);
  });
});
