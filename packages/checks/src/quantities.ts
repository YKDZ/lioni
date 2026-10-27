export type QuantityBranch = {
  readonly values: readonly string[];
};

export type QuantityBranchIssue = {
  readonly targetBranchIndex: number;
  readonly missing: readonly string[];
  readonly extra: readonly string[];
};

/** 按集合比较数量事实，并为每个目标分支选择差异最少的源分支。 */
export function compareQuantityBranches(input: {
  readonly source: readonly QuantityBranch[];
  readonly target: readonly QuantityBranch[];
}): readonly QuantityBranchIssue[] {
  const issues: QuantityBranchIssue[] = [];

  for (const [targetBranchIndex, targetBranch] of input.target.entries()) {
    const targetValues = new Set(targetBranch.values);
    let best:
      | {
          readonly missing: readonly string[];
          readonly extra: readonly string[];
          readonly score: number;
        }
      | undefined;

    for (const sourceBranch of input.source) {
      const sourceValues = new Set(sourceBranch.values);
      const missing = [...sourceValues].filter(
        (value) => !targetValues.has(value),
      );
      const extra = sourceValues.size
        ? [...targetValues].filter((value) => !sourceValues.has(value))
        : [];
      const score = missing.length + extra.length;

      if (best === undefined || score < best.score)
        best = { missing, extra, score };
    }

    if (best && (best.missing.length || best.extra.length))
      issues.push({
        targetBranchIndex,
        missing: best.missing,
        extra: best.extra,
      });
  }

  return issues;
}
