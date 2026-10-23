import DLMM from "@meteora-ag/dlmm";
import { NATIVE_MINT, getAssociatedTokenAddress, getMint } from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  binId,
  lamports,
  tokenAmount,
  type PositionView,
  type Snapshot,
  type TokenMeta,
} from "../domain/types.js";

export type Chain = {
  readonly connection: Connection;
  readonly pool: DLMM;
  readonly owner: PublicKey;
  readonly tokenX: PublicKey;
  readonly tokenY: PublicKey;
  readonly decimalsX: number;
  readonly decimalsY: number;
  readonly tokenXMeta: TokenMeta;
  readonly tokenYMeta: TokenMeta;
  readonly wrappedSolSide: "x" | "y" | null;
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const meta = (mint: PublicKey, decimals: number): TokenMeta => {
  const address = mint.toBase58();
  return { mint: address, decimals, symbol: address.slice(0, 4) };
};

export const makeChain = async (
  rpcUrl: string,
  poolAddress: string,
  owner: PublicKey,
): Promise<Chain> => {
  const connection = new Connection(rpcUrl, "confirmed");
  let pool: DLMM;
  try {
    pool = await DLMM.create(connection, new PublicKey(poolAddress), { cluster: "mainnet-beta" });
  } catch (error) {
    throw new Error(`cannot load DLMM pool ${poolAddress}: ${errorMessage(error)}`);
  }

  const tokenX = pool.lbPair.tokenXMint;
  const tokenY = pool.lbPair.tokenYMint;
  const [mintX, mintY] = await Promise.all([
    getMint(connection, tokenX),
    getMint(connection, tokenY),
  ]);
  const wrappedSolSide: "x" | "y" | null = tokenX.equals(NATIVE_MINT)
    ? "x"
    : tokenY.equals(NATIVE_MINT)
      ? "y"
      : null;

  return {
    connection,
    pool,
    owner,
    tokenX,
    tokenY,
    decimalsX: mintX.decimals,
    decimalsY: mintY.decimals,
    tokenXMeta: meta(tokenX, mintX.decimals),
    tokenYMeta: meta(tokenY, mintY.decimals),
    wrappedSolSide,
  };
};

const isMissingAccount = (error: unknown): boolean => {
  const message = errorMessage(error).toLowerCase();
  const name = error instanceof Error ? error.name.toLowerCase() : "";
  return (
    name.includes("tokenaccountnotfound") ||
    message.includes("could not find account") ||
    message.includes("account not found")
  );
};

export const tokenBalance = async (
  connection: Connection,
  mint: PublicKey,
  owner: PublicKey,
): Promise<bigint> => {
  const ata = await getAssociatedTokenAddress(mint, owner);
  try {
    const balance = await connection.getTokenAccountBalance(ata, "confirmed");
    return BigInt(balance.value.amount);
  } catch (error) {
    if (isMissingAccount(error)) return 0n;
    throw error;
  }
};

const toPositionView = (position: {
  publicKey: PublicKey;
  positionData: {
    lowerBinId: number;
    upperBinId: number;
    feeX: { toString(): string };
    feeY: { toString(): string };
  };
}): PositionView => ({
  address: position.publicKey.toBase58(),
  lowerBinId: binId(position.positionData.lowerBinId),
  upperBinId: binId(position.positionData.upperBinId),
  feeX: tokenAmount(BigInt(position.positionData.feeX.toString())),
  feeY: tokenAmount(BigInt(position.positionData.feeY.toString())),
});

export const observe = async (chain: Chain): Promise<Snapshot> => {
  await chain.pool.refetchStates();

  const [{ activeBin, userPositions }, slot, sol, x, y] = await Promise.all([
    chain.pool.getPositionsByUserAndLbPair(chain.owner),
    chain.connection.getSlot("confirmed"),
    chain.connection.getBalance(chain.owner, "confirmed"),
    tokenBalance(chain.connection, chain.tokenX, chain.owner),
    tokenBalance(chain.connection, chain.tokenY, chain.owner),
  ]);

  const activeBinId = binId(Number(activeBin.binId));

  return {
    at: Date.now(),
    slot,
    pool: {
      address: chain.pool.pubkey.toBase58(),
      activeBin: activeBinId,
      binStep: Number(chain.pool.lbPair.binStep),
      pricePerToken: Number(activeBin.pricePerToken),
      tokenX: chain.tokenXMeta,
      tokenY: chain.tokenYMeta,
      depositsEnabled: Number(chain.pool.lbPair.status) === 0 && !chain.pool.isSwapDisabled(chain.owner),
      wrappedSolSide: chain.wrappedSolSide,
    },
    positions: userPositions.map(toPositionView),
    wallet: {
      x: tokenAmount(x),
      y: tokenAmount(y),
      sol: lamports(BigInt(sol)),
    },
  };
};
