export type Brand<T, B extends string> = T & { readonly __brand: B };

export type Lamports = Brand<bigint, "Lamports">;
export type TokenAmount = Brand<bigint, "TokenAmount">;
export type BinId = Brand<number, "BinId">;

export const lamports = (n: bigint): Lamports => {
  if (n < 0n) throw new RangeError(`lamports must be >= 0, got ${n}`);
  return n as Lamports;
};

export const tokenAmount = (n: bigint): TokenAmount => {
  if (n < 0n) throw new RangeError(`token amount must be >= 0, got ${n}`);
  return n as TokenAmount;
};

export const binId = (n: number): BinId => {
  if (!Number.isInteger(n)) throw new RangeError(`bin id must be an integer, got ${n}`);
  return n as BinId;
};

export type Range = {
  readonly lower: BinId;
  readonly upper: BinId;
};

export type TokenMeta = {
  readonly mint: string;
  readonly decimals: number;
  readonly symbol: string;
};

export type PoolView = {
  readonly address: string;
  readonly activeBin: BinId;
  readonly binStep: number;
  readonly pricePerToken: number;
  readonly tokenX: TokenMeta;
  readonly tokenY: TokenMeta;
  readonly depositsEnabled: boolean;
  readonly wrappedSolSide: "x" | "y" | null;
};

export type PositionView = {
  readonly address: string;
  readonly lowerBinId: BinId;
  readonly upperBinId: BinId;
  readonly feeX: TokenAmount;
  readonly feeY: TokenAmount;
};

export type WalletView = {
  readonly x: TokenAmount;
  readonly y: TokenAmount;
  readonly sol: Lamports;
};

export type Snapshot = {
  readonly slot: number;
  readonly at: number;
  readonly pool: PoolView;
  readonly positions: readonly PositionView[];
  readonly wallet: WalletView;
};

export type History = {
  readonly rebalancesInLastHour: number;
  readonly lastRebalanceAt: number | null;
  readonly completedRebalances: number;
};

export type IdleReason =
  | "in-range"
  | "cooldown"
  | "dwell"
  | "deposits-disabled"
  | "no-inventory";

export type HaltReason =
  | "sol-reserve"
  | "thrash"
  | "stale-chain";

export type Decision =
  | {
      readonly _tag: "Open";
      readonly range: Range;
      readonly depositX: TokenAmount;
      readonly depositY: TokenAmount;
      readonly singleSidedX: boolean;
    }
  | {
      readonly _tag: "Rebalance";
      readonly position: PositionView;
      readonly activeBin: BinId;
    }
  | {
      readonly _tag: "Close";
      readonly position: PositionView;
      readonly reason: "duplicate";
    }
  | { readonly _tag: "Idle"; readonly reason: IdleReason }
  | { readonly _tag: "Halt"; readonly reason: HaltReason };

export const decisionTag = (d: Decision): Decision["_tag"] => d._tag;
