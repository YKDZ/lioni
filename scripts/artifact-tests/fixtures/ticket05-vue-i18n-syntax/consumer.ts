import assert from "node:assert/strict";

import { analyzeQuality } from "@lioni/core";

import config from "./lioni.config.ts";

const result = await analyzeQuality(config);
assert.equal(result.status, "complete");
assert.deepEqual(
  result.checks.map((check) => ({
    id: checkId(check),
    status: check.status,
  })),
  [
    { id: "vue-i18n/source-syntax", status: "complete" },
    { id: "vue-i18n/target-syntax", status: "complete" },
  ],
);
assert.equal(result.diagnostics.length, 2);
const source = result.diagnostics.find(
  (diagnostic) => diagnosticId(diagnostic) === "vue-i18n/source-syntax",
);
const target = result.diagnostics.find(
  (diagnostic) => diagnosticId(diagnostic) === "vue-i18n/target-syntax",
);
assert.equal(source?.severity, "error");
assert.equal(source?.location.language, null);
assert.deepEqual(source?.location.range, {
  file: "source.json",
  span: { start: 7, end: 7 },
});
assert.equal(target?.severity, "error");
assert.equal(target?.location.language, "fr");
assert.deepEqual(target?.location.span, { start: 6, end: 6 });

function diagnosticId(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  if ("checkId" in value && typeof value.checkId === "string")
    return value.checkId;
  if ("ruleId" in value && typeof value.ruleId === "string")
    return value.ruleId;
  return undefined;
}

function checkId(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  if ("checkId" in value && typeof value.checkId === "string")
    return value.checkId;
  if ("id" in value && typeof value.id === "string") return value.id;
  return undefined;
}
