export type MeasurementSummary = {
  readonly median: number | null;
  readonly mad: number | null;
};

export function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = values.toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export function summarizeMeasurements(
  values: readonly number[],
): MeasurementSummary {
  const center = median(values);
  return {
    median: center,
    mad:
      center === null
        ? null
        : median(values.map((value) => Math.abs(value - center))),
  };
}
