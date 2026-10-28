import assert from "node:assert/strict";
import test from "node:test";

import { summarizeMeasurements } from "../scripts/evaluation/performance/statistics.ts";

void test("基准统计报告中位数与中位绝对偏差", () => {
  assert.deepEqual(summarizeMeasurements([1, 2, 9, 10, 100]), {
    median: 9,
    mad: 7,
  });
  assert.deepEqual(summarizeMeasurements([]), {
    median: null,
    mad: null,
  });
});
