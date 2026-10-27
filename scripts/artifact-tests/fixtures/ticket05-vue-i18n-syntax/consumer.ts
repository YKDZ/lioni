import assert from "node:assert/strict";

import { analyzeQuality } from "@lioni/core";

import config from "./lioni.config.ts";
import variableConfig from "./variable.config.ts";

const result = await analyzeQuality(config);
assert.equal(result.status, "complete");
assert.deepEqual(
  result.checks.map((check) => ({
    id: resultCheckId(check),
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
assert.deepEqual(source?.location.range, { file: "source.json" });
assert.deepEqual(source?.location.span, { start: 7, end: 7 });
assert.equal(target?.severity, "error");
assert.equal(target?.location.language, "fr");
assert.deepEqual(target?.location.span, { start: 6, end: 6 });

const variableResult = await analyzeQuality(variableConfig);
assert.equal(variableResult.status, "complete");
assert.deepEqual(
  variableResult.checks.map((check) => ({
    id: resultCheckId(check),
    status: check.status,
  })),
  [{ id: "vue-i18n/variable-correspondence", status: "complete" }],
);
assert.equal(variableResult.diagnostics.length, 1);
assert.equal(
  diagnosticId(variableResult.diagnostics[0]),
  "vue-i18n/variable-correspondence",
);
assert.equal(variableResult.diagnostics[0]?.severity, "error");

function diagnosticId(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  if ("checkId" in value && typeof value.checkId === "string")
    return value.checkId;
  if ("ruleId" in value && typeof value.ruleId === "string")
    return value.ruleId;
  return undefined;
}

function resultCheckId(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  if ("checkId" in value && typeof value.checkId === "string")
    return value.checkId;
  if ("id" in value && typeof value.id === "string") return value.id;
  return undefined;
}
