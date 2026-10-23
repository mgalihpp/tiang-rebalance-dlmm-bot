import {
  ComputeBudgetProgram,
  VersionedTransaction,
  type Connection,
  type Keypair,
  type Transaction,
} from "@solana/web3.js";
import type { Logger } from "../log.js";

export type SendContext = {
  readonly connection: Connection;
  readonly owner: Keypair;
  readonly dryRun: boolean;
  readonly priorityFeeMicroLamports: bigint;
  readonly maxPriorityFeeMicroLamports: bigint;
  readonly log: Logger;
};

export type SendOutcome =
  | { readonly _tag: "sent"; readonly signature: string }
  | { readonly _tag: "dry-run" };

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const hasComputeBudget = (tx: Transaction): boolean =>
  tx.instructions.some((ix) => ix.programId.equals(ComputeBudgetProgram.programId));

const clampFee = (ctx: SendContext): number => {
  const fee =
    ctx.priorityFeeMicroLamports > ctx.maxPriorityFeeMicroLamports
      ? ctx.maxPriorityFeeMicroLamports
      : ctx.priorityFeeMicroLamports;
  const numeric = Number(fee);
  if (!Number.isSafeInteger(numeric) || numeric < 0) {
    throw new Error(`priority fee out of range: ${fee}`);
  }
  return numeric;
};

const refreshBlockhash = async (ctx: SendContext, tx: Transaction): Promise<void> => {
  const latest = await ctx.connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = latest.blockhash;
  tx.lastValidBlockHeight = latest.lastValidBlockHeight;
};

const simulate = async (ctx: SendContext, tx: Transaction, label: string): Promise<void> => {
  const simulationTx = new VersionedTransaction(tx.compileMessage());
  const result = await ctx.connection.simulateTransaction(simulationTx, {
    sigVerify: false,
    replaceRecentBlockhash: true,
    commitment: "confirmed",
  });
  if (result.value.err !== null) {
    const logs = (result.value.logs ?? []).slice(0, 12).join("\n");
    throw new Error(
      `simulation failed for ${label}: ${JSON.stringify(result.value.err)}\n${logs}`,
    );
  }
};

const sendAndConfirm = async (
  ctx: SendContext,
  tx: Transaction,
  signers: readonly Keypair[],
  label: string,
): Promise<string> => {
  tx.sign(...signers);
  const rawTransaction = tx.serialize();
  const signature = await ctx.connection.sendRawTransaction(rawTransaction, {
    skipPreflight: false,
    maxRetries: 0,
    preflightCommitment: "confirmed",
  });
  ctx.log.debug("transaction sent", { label, signature });

  const blockhash = tx.recentBlockhash;
  const lastValidBlockHeight = tx.lastValidBlockHeight;
  if (blockhash === undefined || lastValidBlockHeight === undefined) {
    throw new Error(`transaction ${signature} for ${label} has no blockhash expiry metadata`);
  }

  while (true) {
    const [statuses, blockHeight] = await Promise.all([
      ctx.connection.getSignatureStatuses([signature]),
      ctx.connection.getBlockHeight("confirmed"),
    ]);
    const status = statuses.value[0];
    if (status?.err !== null && status?.err !== undefined) {
      throw new Error(`transaction ${signature} for ${label} failed: ${JSON.stringify(status.err)}`);
    }
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
      return signature;
    }
    if (blockHeight > lastValidBlockHeight) {
      const history = await ctx.connection.getSignatureStatuses([signature], {
        searchTransactionHistory: true,
      });
      const landed = history.value[0];
      if (landed?.err !== null && landed?.err !== undefined) {
        throw new Error(`transaction ${signature} for ${label} failed: ${JSON.stringify(landed.err)}`);
      }
      if (landed?.confirmationStatus === "confirmed" || landed?.confirmationStatus === "finalized") {
        return signature;
      }
      const expired = new Error(
        `transaction ${signature} for ${label} expired at block height ${blockHeight}; last valid height was ${lastValidBlockHeight}`,
      );
      expired.name = "TransactionExpiredBlockheightExceededError";
      throw expired;
    }

    try {
      await ctx.connection.sendRawTransaction(rawTransaction, {
        skipPreflight: true,
        maxRetries: 0,
        preflightCommitment: "confirmed",
      });
    } catch (error) {
      ctx.log.warn("transaction rebroadcast failed", {
        label,
        error: error instanceof Error ? error.name : "unknown error",
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
};

export const sendTx = async (
  ctx: SendContext,
  tx: Transaction,
  signers: readonly Keypair[],
  label: string,
): Promise<SendOutcome> => {
  if (!tx.recentBlockhash) {
    await refreshBlockhash(ctx, tx);
  }

  if (!hasComputeBudget(tx)) {
    tx.instructions.unshift(
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: clampFee(ctx) }),
    );
  }

  await simulate(ctx, tx, label);

  if (ctx.dryRun) {
    ctx.log.info("dry-run: simulated, not sent", { label });
    return { _tag: "dry-run" };
  }

  try {
    await refreshBlockhash(ctx, tx);
    const signature = await sendAndConfirm(ctx, tx, signers, label);
    return { _tag: "sent", signature };
  } catch (error) {
    const message = errorMessage(error);
    const expired =
      error instanceof Error &&
      (error.name === "TransactionExpiredBlockheightExceededError" ||
        message.includes("block height exceeded"));
    if (!expired) {
      throw new Error(`${label} failed: ${message}`);
    }

    ctx.log.warn("blockhash expired, rebuilding once", { label });
    await simulate(ctx, tx, `${label}:retry`);
    try {
      await refreshBlockhash(ctx, tx);
      const signature = await sendAndConfirm(ctx, tx, signers, `${label}:retry`);
      return { _tag: "sent", signature };
    } catch (retryError) {
      throw new Error(`${label} failed after blockhash refresh: ${errorMessage(retryError)}`);
    }
  }
};
