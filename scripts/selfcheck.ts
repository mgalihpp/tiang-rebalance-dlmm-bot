import "dotenv/config";
import { ComputeBudgetProgram, Keypair, VersionedTransaction } from "@solana/web3.js";
import BN from "bn.js";
import { StrategyType } from "@meteora-ag/dlmm";
import { makeChain, observe } from "../src/chain/snapshot.js";
import { targetRange } from "../src/domain/bins.js";

const poolAddress = process.env.POOL_ADDRESS;
if (poolAddress === undefined) {
  process.stderr.write("POOL_ADDRESS is required\n");
  process.exit(1);
}

const rpcUrl = process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";
const width = process.env.POSITION_WIDTH === "3" ? 3 : process.env.POSITION_WIDTH === "2" ? 2 : 1;
const owner = Keypair.generate();

const chain = await makeChain(rpcUrl, poolAddress, owner.publicKey);
const snapshot = await observe(chain);
const range = targetRange(snapshot.pool.activeBin, width);
const positionKeypair = Keypair.generate();

const tx = await chain.pool.initializePositionAndAddLiquidityByStrategy({
  positionPubKey: positionKeypair.publicKey,
  user: owner.publicKey,
  totalXAmount: new BN(10_000_000),
  totalYAmount: new BN(1_000_000),
  strategy: {
    minBinId: range.lower,
    maxBinId: range.upper,
    strategyType: StrategyType.Spot,
    singleSidedX: false,
  },
  slippage: 1,
});

tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }));

const simulation = await chain.connection.simulateTransaction(
  new VersionedTransaction(tx.compileMessage()),
  { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" },
);

const report = {
  pool: snapshot.pool.address,
  activeBin: snapshot.pool.activeBin,
  binStep: snapshot.pool.binStep,
  range: [range.lower, range.upper],
  blockhash: tx.recentBlockhash !== undefined,
  instructionCount: tx.instructions.length,
  programs: tx.instructions.map((ix) => ix.programId.toBase58()),
  simulationError: simulation.value.err,
  simulationLogs: (simulation.value.logs ?? []).slice(-10),
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
