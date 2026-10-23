import { StrategyType } from "@meteora-ag/dlmm";
import { Keypair, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { targetRange } from "../domain/bins.js";
import { deployableAmounts } from "../domain/decide.js";
import type { Config } from "../config.js";
import type { Decision, PositionView, Range, Snapshot, TokenAmount } from "../domain/types.js";
import { appendJournal } from "../journal.js";
import { observe, type Chain } from "./snapshot.js";
import { sendTx, type SendContext } from "./send.js";

export type ActContext = SendContext & {
  readonly chain: Chain;
  readonly config: Config;
  readonly stateDir: string;
};

export type ActResult =
  | { readonly _tag: "opened"; readonly position: PublicKey }
  | { readonly _tag: "closed"; readonly position: PublicKey }
  | { readonly _tag: "rebalanced"; readonly from: PublicKey; readonly to: PublicKey | null }
  | { readonly _tag: "dry-run"; readonly decision: Decision["_tag"] }
  | { readonly _tag: "nothing" };

const positionStillExists = async (ctx: ActContext, address: string): Promise<boolean> => {
  const snapshot = await observe(ctx.chain);
  return snapshot.positions.some((p) => p.address === address);
};

const closeExact = async (ctx: ActContext, position: PositionView): Promise<readonly string[]> => {
  const address = position.address;
  const signatures: string[] = [];
  try {
    const transactions = await ctx.chain.pool.removeLiquidity({
      user: ctx.owner.publicKey,
      position: new PublicKey(address),
      fromBinId: position.lowerBinId,
      toBinId: position.upperBinId,
      bps: new BN(10_000),
      shouldClaimAndClose: true,
    });

    for (const [index, tx] of transactions.entries()) {
      const outcome = await sendTx(ctx, tx, [ctx.owner], `close:${address}:${index}`);
      if (outcome._tag === "sent") signatures.push(outcome.signature);
    }
  } catch (error) {
    if (ctx.dryRun) throw error;
    const stillThere = await positionStillExists(ctx, address);
    if (stillThere) throw error;
    ctx.log.warn("close failed but the position is gone; treating as closed", { address });
  }

  if (!ctx.dryRun) {
    await ctx.chain.pool.refetchStates();
    ctx.log.info("position closed", { address, signatures });
  }
  return signatures;
};

const openAt = async (
  ctx: ActContext,
  range: Range,
  depositX: TokenAmount,
  depositY: TokenAmount,
  singleSidedX: boolean,
): Promise<{ position: PublicKey; signature: string | null }> => {
  const positionKeypair = Keypair.generate();
  let signature: string | null = null;
  const existing = await ctx.chain.connection.getAccountInfo(positionKeypair.publicKey);
  if (existing !== null) {
    throw new Error(`fresh position key already exists: ${positionKeypair.publicKey.toBase58()}`);
  }

  const tx = await ctx.chain.pool.initializePositionAndAddLiquidityByStrategy({
    positionPubKey: positionKeypair.publicKey,
    user: ctx.owner.publicKey,
    totalXAmount: new BN(depositX.toString()),
    totalYAmount: new BN(depositY.toString()),
    strategy: {
      minBinId: range.lower,
      maxBinId: range.upper,
      strategyType: StrategyType.Spot,
      singleSidedX,
    },
    slippage: ctx.config.slippagePercent,
  });

  try {
    const outcome = await sendTx(ctx, tx, [ctx.owner, positionKeypair], `open:${range.lower}-${range.upper}`);
    if (outcome._tag === "sent") signature = outcome.signature;
  } catch (error) {
    if (ctx.dryRun) throw error;
    const snapshot = await observe(ctx.chain);
    const landed = snapshot.positions.some((p) => p.address === positionKeypair.publicKey.toBase58());
    if (!landed) throw error;
    ctx.log.warn("open reported failure but the position exists; continuing", {
      position: positionKeypair.publicKey.toBase58(),
    });
  }

  if (!ctx.dryRun) {
    await ctx.chain.pool.refetchStates();
  }
  return { position: positionKeypair.publicKey, signature };
};

const openFromSnapshot = async (
  ctx: ActContext,
  snapshot: Snapshot,
): Promise<{ position: PublicKey; signature: string | null } | null> => {
  const plan = deployableAmounts(snapshot.wallet, ctx.config, snapshot.pool);
  if (plan.depositX === 0n && plan.depositY === 0n) return null;
  const singleSided =
    plan.depositY > 0n && plan.depositX === 0n
      ? "y"
      : plan.depositX > 0n && plan.depositY === 0n
        ? "x"
        : null;
  return openAt(
    ctx,
    targetRange(snapshot.pool.activeBin, ctx.config.width, singleSided),
    plan.depositX,
    plan.depositY,
    plan.singleSidedX,
  );
};

export const act = async (ctx: ActContext, decision: Decision): Promise<ActResult> => {
  switch (decision._tag) {
    case "Idle":
    case "Halt":
      return { _tag: "nothing" };

    case "Open": {
      const { position, signature } = await openAt(
        ctx,
        decision.range,
        decision.depositX,
        decision.depositY,
        decision.singleSidedX,
      );
      if (ctx.dryRun) return { _tag: "dry-run", decision: "Open" };
      appendJournal(ctx.stateDir, {
        ts: Date.now(),
        kind: "open",
        position: position.toBase58(),
        lower: decision.range.lower,
        upper: decision.range.upper,
        signature,
      });
      return { _tag: "opened", position };
    }

    case "Close": {
      const signatures = await closeExact(ctx, decision.position);
      if (ctx.dryRun) return { _tag: "dry-run", decision: "Close" };
      appendJournal(ctx.stateDir, {
        ts: Date.now(),
        kind: "close",
        position: decision.position.address,
        signatures,
      });
      return { _tag: "closed", position: new PublicKey(decision.position.address) };
    }

    case "Rebalance": {
      const from = new PublicKey(decision.position.address);
      const closeSignatures = await closeExact(ctx, decision.position);
      if (ctx.dryRun) return { _tag: "dry-run", decision: "Rebalance" };

      const fresh = await observe(ctx.chain);
      if (fresh.positions.length > 0) {
        throw new Error(
          `close reported success but ${fresh.positions.length} position(s) remain for this pool`,
        );
      }

      const reopened = await openFromSnapshot(ctx, fresh);
      appendJournal(ctx.stateDir, {
        ts: Date.now(),
        kind: "rebalance",
        from: from.toBase58(),
        to: reopened?.position.toBase58() ?? null,
        closeSignatures,
        openSignature: reopened?.signature ?? null,
      });
      if (reopened === null) {
        ctx.log.warn("rebalance closed the position but found nothing to redeploy");
      } else {
        ctx.log.info("position rebalanced", {
          from: from.toBase58(),
          to: reopened.position.toBase58(),
          activeBin: fresh.pool.activeBin,
        });
      }
      return { _tag: "rebalanced", from, to: reopened?.position ?? null };
    }
  }
};
