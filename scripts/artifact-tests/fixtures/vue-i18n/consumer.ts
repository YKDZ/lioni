import assert from "node:assert/strict";

import { analyzeQuality } from "@lioni/lioni";

import { createConfig } from "./lioni.config.ts";

const cases = [
  { target: "你好 {name}", expected: undefined },
  { target: "你好 {person}", expected: "vue-i18n/variable-correspondence" },
  { target: "无效 }", expected: "vue-i18n/target-syntax" },
];
const summaries = [];
for (const { target, expected } of cases) {
  const result = await analyzeQuality(createConfig(target));
  const diagnostics = result.diagnostics.map(({ checkId }) => checkId).sort();
  if (expected === undefined) {
    assert.equal(result.status, "complete");
    assert.deepEqual(diagnostics, []);
  } else {
    assert.ok(diagnostics.includes(expected));
  }
  summaries.push({ target, status: result.status, diagnostics });
}
process.stdout.write(JSON.stringify(summaries));
