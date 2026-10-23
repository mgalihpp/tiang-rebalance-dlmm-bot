import { describe, expect, it } from "vitest";
import { distanceOutside, isInRange, makeRange, rangeWidth } from "../src/domain/bins.js";
import { binId } from "../src/domain/types.js";

describe("bins", () => {
  it("refuses an inverted range", () => {
    expect(() => makeRange(binId(5), binId(4))).toThrow(RangeError);
  });

  it("treats bounds as inclusive", () => {
    const range = makeRange(binId(-10), binId(-9));
    expect(isInRange(range, binId(-10))).toBe(true);
    expect(isInRange(range, binId(-9))).toBe(true);
    expect(isInRange(range, binId(-11))).toBe(false);
    expect(isInRange(range, binId(-8))).toBe(false);
  });

  it("counts the bins in the range", () => {
    expect(rangeWidth(makeRange(binId(100), binId(101)))).toBe(2);
    expect(rangeWidth(makeRange(binId(100), binId(100)))).toBe(1);
  });

  it("measures how far the active bin drifted", () => {
    const range = makeRange(binId(100), binId(101));
    expect(distanceOutside(range, binId(104))).toBe(3);
    expect(distanceOutside(range, binId(99))).toBe(1);
    expect(distanceOutside(range, binId(100))).toBe(0);
  });
});
