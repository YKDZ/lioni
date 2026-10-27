import assert from "node:assert/strict";
import test from "node:test";

import { compareQuantityBranches } from "@lioni/checks";

await test("每个目标分支匹配任一源分支，并报告最佳匹配的集合差异", () => {
  assert.deepEqual(
    compareQuantityBranches({
      source: [{ values: ["1", "2"] }, { values: ["4"] }],
      target: [{ values: ["4"] }, { values: ["1", "3"] }],
    }),
    [{ targetBranchIndex: 1, missing: ["2"], extra: ["3"] }],
  );
});

await test("数量按集合比较，空源数量不把译文数量判作多余", () => {
  assert.deepEqual(
    compareQuantityBranches({
      source: [{ values: ["1", "1"] }],
      target: [{ values: ["1", "1", "1"] }],
    }),
    [],
  );
  assert.deepEqual(
    compareQuantityBranches({
      source: [{ values: [] }],
      target: [{ values: ["8", "9"] }],
    }),
    [],
  );
});

await test("分别报告各目标分支缺少源数量的情况", () => {
  assert.deepEqual(
    compareQuantityBranches({
      source: [{ values: ["3", "7"] }],
      target: [{ values: ["3"] }, { values: ["7"] }],
    }),
    [
      { targetBranchIndex: 0, missing: ["7"], extra: [] },
      { targetBranchIndex: 1, missing: ["3"], extra: [] },
    ],
  );
});
