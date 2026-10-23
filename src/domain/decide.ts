import { isPositionInRange, targetRange, type Width } from "./bins.js";
import {
  type BinId,
  type Decision,
  type History,
  type PositionView,
  type PoolView,
  type Snapshot,
  type TokenAmount,
  type WalletView,
  tokenAmount,
} from "./types.js";

export type Policy = {
  readonly width: Width;
  readonly maxDeployX: bigint | null;
  readonly maxDeployY: bigint | null;
  readonly minSolReserve: bigint;
  readonly maxRebalancesPerHour: number;
  readonly minRebalanceIntervalMs: number;
  readonly maxSnapshotAgeMs: number;
};

export type DecideInput = {
  readonly snapshot: Snapshot;
  readonly policy: Policy;
  readonly history: History;
  readonly now: number;
  readonly dwellSatisfied: boolean;
};

const minBig = (a: bigint, b: bigint): bigint => (a < b ? a : b);

const cappedBalance = (balance: bigint, cap: bigint | null): bigint =>
  cap === null ? balance : minBig(balance, cap);

export type Deployable = {
  readonly depositX: TokenAmount;
  readonly depositY: TokenAmount;
  readonly singleSidedX: boolean;
};

export const deployableAmounts = (
  wallet: WalletView,
  policy: Pick<Policy, "width" | "maxDeployX" | "maxDeployY" | "minSolReserve">,
  pool: Pick<PoolView, "wrappedSolSide" | "pricePerToken" | "tokenX" | "tokenY">,
): Deployable => {
  const freeSol = wallet.sol > policy.minSolReserve ? wallet.sol - policy.minSolReserve : 0n;
  const idleX = pool.wrappedSolSide === "x" ? freeSol : wallet.x;
  const idleY = pool.wrappedSolSide === "y" ? freeSol : wallet.y;
  const cappedX = cappedBalance(idleX, policy.maxDeployX);
  const cappedY = cappedBalance(idleY, policy.maxDeployY);
  const xValueInY =
    (Number(cappedX) / 10 ** pool.tokenX.decimals) * pool.pricePerToken;
  const yValue = Number(cappedY) / 10 ** pool.tokenY.decimals;
  const useX = cappedX > 0n && (cappedY === 0n || xValueInY >= yValue);
  const depositX = tokenAmount(useX ? cappedX : 0n);
  const depositY = tokenAmount(useX ? 0n : cappedY);
  return {
    depositX,
    depositY,
    singleSidedX: depositY === 0n && depositX > 0n,
  };
};

const distanceOf = (position: PositionView, active: BinId): number => {
  if (active < position.lowerBinId) return position.lowerBinId - active;
  if (active > position.upperBinId) return active - position.upperBinId;
  return 0;
};

const pickKeeper = (positions: readonly PositionView[], active: BinId): PositionView =>
  [...positions].sort((a, b) => {
    const d = distanceOf(a, active) - distanceOf(b, active);
    if (d !== 0) return d;
    return a.address < b.address ? -1 : a.address > b.address ? 1 : 0;
  })[0] as PositionView;

export const decide = (input: DecideInput): Decision => {
  const { snapshot, policy, history, now, dwellSatisfied } = input;
  const { pool, positions, wallet } = snapshot;

  if (now - snapshot.at > policy.maxSnapshotAgeMs) {
    return { _tag: "Halt", reason: "stale-chain" };
  }

  if (positions.length > 1) {
    const keeper = pickKeeper(positions, pool.activeBin);
    const duplicate = positions.find((p) => p.address !== keeper.address) as PositionView;
    return { _tag: "Close", position: duplicate, reason: "duplicate" };
  }

  const position = positions[0];

  if (position !== undefined) {
    if (isPositionInRange(position, pool.activeBin)) {
      return { _tag: "Idle", reason: "in-range" };
    }
    return { _tag: "Rebalance", position, activeBin: pool.activeBin };
  }

  if (wallet.sol < policy.minSolReserve) {
    return { _tag: "Halt", reason: "sol-reserve" };
  }

  if (history.rebalancesInLastHour >= policy.maxRebalancesPerHour) {
    return { _tag: "Halt", reason: "thrash" };
  }

  const { depositX, depositY, singleSidedX } = deployableAmounts(wallet, policy, pool);

  if (depositX === 0n && depositY === 0n) {
    return { _tag: "Idle", reason: "no-inventory" };
  }

  if (!pool.depositsEnabled) {
    return { _tag: "Idle", reason: "deposits-disabled" };
  }

  if (
    history.lastRebalanceAt !== null &&
    now - history.lastRebalanceAt < policy.minRebalanceIntervalMs
  ) {
    return { _tag: "Idle", reason: "cooldown" };
  }

  if (!dwellSatisfied) {
    return { _tag: "Idle", reason: "dwell" };
  }

  return {
    _tag: "Open",
    range: targetRange(
      pool.activeBin,
      policy.width,
      depositY > 0n && depositX === 0n ? "y" : depositX > 0n && depositY === 0n ? "x" : null,
    ),
    depositX,
    depositY,
    singleSidedX,
  };
};
