import { type BinId, type Range, binId } from "./types.js";

export type Width = 1 | 2 | 3;

export const makeRange = (lower: BinId, upper: BinId): Range => {
  if (upper < lower) {
    throw new RangeError(`invalid range: upper ${upper} < lower ${lower}`);
  }
  return { lower, upper };
};

export const targetRange = (
  active: BinId,
  width: Width,
  singleSided: "x" | "y" | null = null,
): Range => {
  if (singleSided === "y") {
    return makeRange(binId(active - width + 1), active);
  }
  return makeRange(active, binId(active + width - 1));
};

export const rangeWidth = (range: Range): number => range.upper - range.lower + 1;

export const isInRange = (range: Range, active: BinId): boolean =>
  active >= range.lower && active <= range.upper;

export const isPositionInRange = (position: { lowerBinId: BinId; upperBinId: BinId }, active: BinId): boolean =>
  isInRange({ lower: position.lowerBinId, upper: position.upperBinId }, active);

export const distanceOutside = (range: Range, active: BinId): number => {
  if (active < range.lower) return range.lower - active;
  if (active > range.upper) return active - range.upper;
  return 0;
};

export const sameRange = (a: Range, b: Range): boolean => a.lower === b.lower && a.upper === b.upper;

export const rangeSizeBins = (position: { lowerBinId: BinId; upperBinId: BinId }): number =>
  position.upperBinId - position.lowerBinId + 1;
