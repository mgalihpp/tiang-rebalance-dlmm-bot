import { describe, expect, it } from "vitest";
import { decide, type Policy } from "../src/domain/decide.js";
import { targetRange } from "../src/domain/bins.js";
import {
  binId,
  lamports,
  tokenAmount,
  type History,
  type PositionView,
  type Snapshot,
} from "../src/domain/types.js";

const NOW = 1_700_000_000_000;

const policy: Policy = {
  width: 1,
  maxDeployX: null,
  maxDeployY: null,
  minSolReserve: 50_000_000n,
  maxRebalancesPerHour: 20,
  minRebalanceIntervalMs: 60_000,
  maxSnapshotAgeMs: 30_000,
};

const history: History = { rebalancesInLastHour: 0, lastRebalanceAt: null, completedRebalances: 0 };

const position = (lower: number, upper: number): PositionView => ({
  address: `pos-${lower}-${upper}`,
  lowerBinId: binId(lower),
  upperBinId: binId(upper),
  feeX: tokenAmount(0n),
  feeY: tokenAmount(0n),
});

const snapshot = (over: {
  active?: number;
  positions?: readonly PositionView[];
  x?: bigint;
  y?: bigint;
  sol?: bigint;
  at?: number;
  depositsEnabled?: boolean;
  wrappedSolSide?: "x" | "y" | null;
  pricePerToken?: number;
}): Snapshot => ({
  at: over.at ?? NOW,
  slot: 1,
  pool: {
    address: "pool",
    activeBin: binId(over.active ?? 100),
    binStep: 100,
    tokenX: { mint: "x", decimals: 9, symbol: "X" },
    tokenY: { mint: "y", decimals: 6, symbol: "Y" },
    pricePerToken: over.pricePerToken ?? 1,
    depositsEnabled: over.depositsEnabled ?? true,
    wrappedSolSide: over.wrappedSolSide ?? null,
  },
  positions: over.positions ?? [],
  wallet: {
    x: tokenAmount(over.x ?? 1_000_000_000n),
    y: tokenAmount(over.y ?? 1_000_000_000n),
    sol: lamports(over.sol ?? 1_000_000_000n),
  },
});

const run = (s: Snapshot, over: Partial<{ h: History; dwell: boolean; p: Policy; now: number }> = {}) =>
  decide({
    snapshot: s,
    policy: over.p ?? policy,
    history: over.h ?? history,
    now: over.now ?? NOW,
    dwellSatisfied: over.dwell ?? true,
  });

describe("targetRange", () => {
  it("width 1 is the active bin alone", () => {
    expect(targetRange(binId(100), 1)).toEqual({ lower: 100, upper: 100 });
  });

  it("width 2 is the active bin plus one above", () => {
    expect(targetRange(binId(100), 2)).toEqual({ lower: 100, upper: 101 });
  });

  it("puts a single-sided Y position in the active bin and the one below", () => {
    expect(targetRange(binId(100), 2, "y")).toEqual({ lower: 99, upper: 100 });
  });

  it("keeps a single-sided X position in the active bin and the one above", () => {
    expect(targetRange(binId(100), 2, "x")).toEqual({ lower: 100, upper: 101 });
  });

  it("puts a width 3 X position in the active bin and the two above", () => {
    expect(targetRange(binId(100), 3, "x")).toEqual({ lower: 100, upper: 102 });
  });

  it("puts a width 3 Y position in the active bin and the two below", () => {
    expect(targetRange(binId(100), 3, "y")).toEqual({ lower: 98, upper: 100 });
  });
});

describe("decide", () => {
  it("opens at the active bin when flat and funded", () => {
    const d = run(snapshot({ active: 100 }));
    expect(d._tag).toBe("Open");
    if (d._tag === "Open") {
      expect(d.range).toEqual({ lower: 100, upper: 100 });
      expect(d.depositY).toBe(1_000_000_000n);
    }
  });

  it("opens a two-bin Y-only position below and through the active bin", () => {
    const d = run(snapshot({ active: 100, x: 0n, y: 1_000_000_000n }), {
      p: { ...policy, width: 2 },
    });
    expect(d._tag).toBe("Open");
    if (d._tag === "Open") expect(d.range).toEqual({ lower: 99, upper: 100 });
  });

  it("opens a three-bin Y-only position below and through the active bin", () => {
    const d = run(snapshot({ active: 100, x: 0n, y: 1_000_000_000n }), {
      p: { ...policy, width: 3 },
    });
    expect(d._tag).toBe("Open");
    if (d._tag === "Open") expect(d.range).toEqual({ lower: 98, upper: 100 });
  });

  it("opens a three-bin X-only position from the active bin upward", () => {
    const d = run(snapshot({ active: 100, x: 1_000_000_000n, y: 0n }), {
      p: { ...policy, width: 3 },
    });
    expect(d._tag).toBe("Open");
    if (d._tag === "Open") {
      expect(d.range).toEqual({ lower: 100, upper: 102 });
      expect(d.depositX).toBe(1_000_000_000n);
      expect(d.depositY).toBe(0n);
      expect(d.singleSidedX).toBe(false);
    }
  });

  it("opens single-sided X when only X is funded", () => {
    const d = run(snapshot({ y: 0n }));
    expect(d._tag).toBe("Open");
    if (d._tag === "Open") expect(d.singleSidedX).toBe(true);
  });

  it("chooses only the higher-value X side when both tokens are funded", () => {
    const d = run(
      snapshot({ x: 100_000_000_000n, y: 10_000_000n, pricePerToken: 0.5 }),
      { p: { ...policy, width: 2 } },
    );
    expect(d._tag).toBe("Open");
    if (d._tag === "Open") {
      expect(d.depositX).toBe(100_000_000_000n);
      expect(d.depositY).toBe(0n);
      expect(d.range).toEqual({ lower: 100, upper: 101 });
    }
  });

  it("chooses only the higher-value Y side when both tokens are funded", () => {
    const d = run(
      snapshot({ x: 1_000_000n, y: 10_000_000n, pricePerToken: 0.5 }),
      { p: { ...policy, width: 2 } },
    );
    expect(d._tag).toBe("Open");
    if (d._tag === "Open") {
      expect(d.depositX).toBe(0n);
      expect(d.depositY).toBe(10_000_000n);
      expect(d.range).toEqual({ lower: 99, upper: 100 });
    }
  });

  it("idles while the position is in range", () => {
    expect(run(snapshot({ active: 100, positions: [position(99, 101)] }))._tag).toBe("Idle");
  });

  it("rebalances as soon as the active bin leaves the range", () => {
    const d = run(snapshot({ active: 102, positions: [position(100, 101)] }));
    expect(d._tag).toBe("Rebalance");
  });

  it("rebalances below the range too", () => {
    expect(run(snapshot({ active: 98, positions: [position(100, 101)] }))._tag).toBe("Rebalance");
  });

  it("closes duplicates one at a time and keeps the nearest", () => {
    const d = run(
      snapshot({ active: 100, positions: [position(100, 100), position(140, 141)] }),
    );
    expect(d._tag).toBe("Close");
    if (d._tag === "Close") expect(d.position.address).toBe("pos-140-141");
  });

  it("keeps an open position in range even when SOL is under the reserve", () => {
    const d = run(snapshot({ positions: [position(100, 100)], sol: 1n }));
    expect(d).toEqual({ _tag: "Idle", reason: "in-range" });
  });

  it("still rebalances an open position when SOL is under the reserve", () => {
    const d = run(snapshot({ active: 102, positions: [position(100, 101)], sol: 1n }));
    expect(d._tag).toBe("Rebalance");
  });

  it("halts on the reserve only when no position is open", () => {
    const d = run(snapshot({ sol: 1n }));
    expect(d).toEqual({ _tag: "Halt", reason: "sol-reserve" });
  });

  it("halts on a stale snapshot", () => {
    const d = run(snapshot({ at: NOW - 60_000 }));
    expect(d).toEqual({ _tag: "Halt", reason: "stale-chain" });
  });

  it("halts when the hourly rebalance cap is reached", () => {
    const d = run(snapshot({}), {
      h: { rebalancesInLastHour: 20, lastRebalanceAt: NOW - 120_000, completedRebalances: 40 },
    });
    expect(d).toEqual({ _tag: "Halt", reason: "thrash" });
  });

  it("waits out the cooldown before opening", () => {
    const d = run(snapshot({}), {
      h: { rebalancesInLastHour: 1, lastRebalanceAt: NOW - 1_000, completedRebalances: 1 },
    });
    expect(d).toEqual({ _tag: "Idle", reason: "cooldown" });
  });

  it("waits for dwell before opening", () => {
    expect(run(snapshot({}), { dwell: false })).toEqual({ _tag: "Idle", reason: "dwell" });
  });

  it("does not open when the pool blocks deposits", () => {
    expect(run(snapshot({ depositsEnabled: false }))).toEqual({
      _tag: "Idle",
      reason: "deposits-disabled",
    });
  });

  it("can still close out of range when deposits are disabled", () => {
    const d = run(snapshot({ active: 200, positions: [position(100, 101)], depositsEnabled: false }));
    expect(d._tag).toBe("Rebalance");
  });

  it("idles with no inventory", () => {
    expect(run(snapshot({ x: 0n, y: 0n }))).toEqual({ _tag: "Idle", reason: "no-inventory" });
  });

  it("caps the deposit at the configured maximum", () => {
    const d = run(snapshot({ y: 5_000_000n }), { p: { ...policy, maxDeployY: 2_000_000n } });
    expect(d._tag).toBe("Open");
    if (d._tag === "Open") expect(d.depositY).toBe(2_000_000n);
  });

  it("counts native SOL as Y when the pool's Y mint is wrapped SOL", () => {
    const d = run(snapshot({ x: 0n, y: 0n, sol: 1_000_000_000n, wrappedSolSide: "y" }));
    expect(d._tag).toBe("Open");
    if (d._tag === "Open") {
      expect(d.depositY).toBe(950_000_000n);
      expect(d.depositX).toBe(0n);
    }
  });

  it("counts native SOL as X when the pool's X mint is wrapped SOL", () => {
    const d = run(snapshot({ x: 0n, y: 0n, sol: 1_000_000_000n, wrappedSolSide: "x" }));
    expect(d._tag).toBe("Open");
    if (d._tag === "Open") {
      expect(d.depositX).toBe(950_000_000n);
      expect(d.depositY).toBe(0n);
      expect(d.singleSidedX).toBe(true);
    }
  });

  it("takes the wrapped side from native SOL even when wrapped SOL is already held", () => {
    const d = run(
      snapshot({ x: 0n, y: 400_000_000n, sol: 1_000_000_000n, wrappedSolSide: "y" }),
    );
    if (d._tag === "Open") expect(d.depositY).toBe(950_000_000n);
  });
});
