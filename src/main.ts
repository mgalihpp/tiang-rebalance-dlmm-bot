import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { Cause, Effect, Ref } from "effect";
import { parseConfig, type Config } from "./config.js";
import { decide, type Policy } from "./domain/decide.js";
import type { Decision } from "./domain/types.js";
import { makeChain, observe } from "./chain/snapshot.js";
import { act, type ActContext } from "./chain/act.js";
import { appendJournal, haltPath, isHalted, readHistory } from "./journal.js";
import { makeLogger } from "./log.js";
import { loadKeypair } from "./wallet.js";
import { makeTelegramNotifier, makeTelegramSettingsController, type TelegramAlert } from "./telegram.js";
import { makeSettingsStore, type RuntimeSettings } from "./settings.js";

const policyOf = (config: Config): Policy => ({
  width: config.width,
  maxDeployX: config.maxDeployX,
  maxDeployY: config.maxDeployY,
  minSolReserve: config.minSolReserve,
  maxRebalancesPerHour: config.maxRebalancesPerHour,
  minRebalanceIntervalMs: config.minRebalanceIntervalMs,
  maxSnapshotAgeMs: config.maxSnapshotAgeMs,
});

const configForRuntime = (config: Config, runtime: RuntimeSettings): Config => {
  const { mode, ...values } = runtime;
  return {
    ...config,
    ...values,
    dryRun: mode === "dry-run",
    live: mode === "live",
  };
};

const serializableSnapshot = (snapshot: Awaited<ReturnType<typeof observe>>): unknown => ({
  at: new Date(snapshot.at).toISOString(),
  slot: snapshot.slot,
  pool: {
    ...snapshot.pool,
    activeBin: snapshot.pool.activeBin,
  },
  wallet: {
    x: snapshot.wallet.x.toString(),
    y: snapshot.wallet.y.toString(),
    sol: snapshot.wallet.sol.toString(),
  },
  positions: snapshot.positions.map((p) => ({
    address: p.address,
    lowerBinId: p.lowerBinId,
    upperBinId: p.upperBinId,
    feeX: p.feeX.toString(),
    feeY: p.feeY.toString(),
  })),
});

const describeDecision = (decision: Decision): Record<string, unknown> => {
  switch (decision._tag) {
    case "Open":
      return {
        decision: decision._tag,
        range: [decision.range.lower, decision.range.upper],
        depositX: decision.depositX.toString(),
        depositY: decision.depositY.toString(),
        depositSide: decision.depositX > 0n ? "X" : "Y",
      };
    case "Rebalance":
      return {
        decision: decision._tag,
        position: decision.position.address,
        activeBin: decision.activeBin,
      };
    case "Close":
      return { decision: decision._tag, position: decision.position.address, reason: decision.reason };
    case "Idle":
    case "Halt":
      return { decision: decision._tag, reason: decision.reason };
  }
};

const main = async (): Promise<number> => {
  const parsed = parseConfig(process.env);
  if (parsed._tag === "err") {
    for (const error of parsed.errors) {
      process.stderr.write(`${error.field}: ${error.message}\n`);
    }
    return 1;
  }

  const envConfig = parsed.config;
  const bootstrapLog = makeLogger(envConfig.logLevel);
  const settings = makeSettingsStore(envConfig, bootstrapLog);
  const config = settings.currentConfig();
  const log = config.logLevel === envConfig.logLevel ? bootstrapLog : makeLogger(config.logLevel);
  const telegram = makeTelegramNotifier(config.telegram, log);
  const once = process.argv.includes("--once");
  const probe = process.argv.includes("--probe");

  if (isHalted(config.stateDir) && !probe) {
    log.error("HALT file present; delete it after investigating before restarting", {
      path: haltPath(config.stateDir),
    });
    return 0;
  }

  const owner = (() => {
    try {
      return loadKeypair(config.wallet);
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      return null;
    }
  })();
  if (owner === null) return 1;

  if (config.wallet.kind === "inline") {
    log.warn("secret key comes from the environment; prefer WALLET_KEYPAIR_PATH to limit exposure");
  }

  const chain = await makeChain(config.rpcUrl, config.poolAddress, owner.publicKey);

  if (probe) {
    const snapshot = await observe(chain);
    process.stdout.write(`${JSON.stringify(serializableSnapshot(snapshot), null, 2)}\n`);
    return 0;
  }

  log.info("bot starting", {
    pool: config.poolAddress,
    owner: owner.publicKey.toBase58(),
    width: config.width,
    dryRun: config.dryRun,
    live: config.live,
    tokenX: chain.tokenXMeta.mint,
    tokenY: chain.tokenYMeta.mint,
  });
  await telegram.notify({ _tag: "started", pool: config.poolAddress, dryRun: config.dryRun });

  let stop = false;
  const telegramAbort = new AbortController();
  const telegramSettings = makeTelegramSettingsController(config, log, settings);
  const requestStop = (): void => {
    stop = true;
    telegramAbort.abort();
    log.info("shutdown requested; finishing the current cycle");
  };
  process.on("SIGINT", requestStop);
  process.on("SIGTERM", requestStop);
  if (!once) void telegramSettings.start(telegramAbort.signal);

  const dwellRef = await Effect.runPromise(Ref.make({ binId: -1, ticks: 0 }));

  const runCycle = async (): Promise<{ halt: boolean }> => {
    const cycleConfig = configForRuntime(config, settings.snapshot().runtime);
    const policy = policyOf(cycleConfig);
    const actContext: ActContext = {
      chain,
      config: cycleConfig,
      stateDir: cycleConfig.stateDir,
      connection: chain.connection,
      owner,
      dryRun: cycleConfig.dryRun || !cycleConfig.live,
      priorityFeeMicroLamports: cycleConfig.priorityFeeMicroLamports,
      maxPriorityFeeMicroLamports: cycleConfig.maxPriorityFeeMicroLamports,
      log,
    };
    const snapshot = await observe(chain);
    const dwell = await Effect.runPromise(
      Ref.updateAndGet(dwellRef, (state) =>
        state.binId === snapshot.pool.activeBin
          ? { binId: snapshot.pool.activeBin, ticks: state.ticks + 1 }
          : { binId: snapshot.pool.activeBin, ticks: 1 },
      ),
    );

    const decision = decide({
      snapshot,
      policy,
      history: readHistory(cycleConfig.stateDir, Date.now()),
      now: Date.now(),
      dwellSatisfied: dwell.ticks >= cycleConfig.dwellTicks,
    });

    log.info("decision", { ...describeDecision(decision), activeBin: snapshot.pool.activeBin, slot: snapshot.slot });

    if (decision._tag === "Halt") {
      appendJournal(config.stateDir, { ts: Date.now(), kind: "halt", reason: decision.reason });
      mkdirSync(config.stateDir, { recursive: true });
      writeFileSync(haltPath(config.stateDir), `${new Date().toISOString()} ${decision.reason}\n`, "utf8");
      log.error("halting", { reason: decision.reason });
      await telegram.notify({ _tag: "halt", reason: decision.reason });
      return { halt: true };
    }

    const result = await act(actContext, decision);
    log.info("action complete", { result: result._tag, ...("decision" in result ? { decision: result.decision } : {}) });
    const alert = actionAlert(result);
    if (alert !== null) await telegram.notify(alert);
    return { halt: false };
  };

  if (once) {
    try {
      const result = await Effect.runPromise(
        Effect.tryPromise<{ halt: boolean }, unknown>({ try: runCycle, catch: (error) => error }),
      );
      return result.halt ? 0 : 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error("cycle failed", { error: message });
      await telegram.notify({ _tag: "cycle-error", message });
      return 1;
    }
  }

  const loop: Effect.Effect<void> = Effect.gen(function* () {
    if (stop) return;
    yield* Effect.tryPromise({ try: runCycle, catch: (error) => error }).pipe(
      Effect.catchAllCause((cause) =>
        Effect.promise(async (): Promise<{ halt: boolean }> => {
          const message = Cause.pretty(cause);
          log.error("cycle failed", { cause: message });
          appendJournal(config.stateDir, { ts: Date.now(), kind: "error", message });
          await telegram.notify({ _tag: "cycle-error", message });
          return { halt: false };
        }),
      ),
      Effect.tap((result) =>
        Effect.sync(() => {
          if (result.halt) stop = true;
        }),
      ),
    );
    if (stop) return;
    yield* Effect.sleep(`${settings.snapshot().runtime.pollIntervalMs} millis`);
    yield* Effect.suspend(() => loop);
  });

  await Effect.runPromise(
    loop.pipe(
      Effect.catchAllCause((cause) => Effect.sync(() => log.error("bot stopped", { cause: Cause.pretty(cause) }))),
    ),
  );
  telegramAbort.abort();

  log.info("bot finished");
  return 0;
};

const actionAlert = (result: Awaited<ReturnType<typeof act>>): TelegramAlert | null => {
  switch (result._tag) {
    case "opened":
    case "closed":
    case "rebalanced":
      return { _tag: "action", result };
    case "dry-run":
    case "nothing":
      return null;
  }
};

const exit = await main();
process.exit(exit);
