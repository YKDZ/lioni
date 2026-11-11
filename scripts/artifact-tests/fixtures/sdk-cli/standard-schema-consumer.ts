import assert from "node:assert/strict";

import {
  analyzeQuality,
  defineChecker,
  defineConfig,
  readFacts,
  type StandardSchemaV1,
} from "@lioni/lioni";
import { z } from "zod";

type Unit = { source: string; context: { file: string } };
// 专门验证非 Zod、异步的标准协议接入；普通业务夹具由其宿主选择 Zod。
const sourceSchema: StandardSchemaV1<Unit> = {
  "~standard": {
    version: 1,
    vendor: "consumer-protocol",
    async validate(value) {
      if (
        typeof value === "object" &&
        value !== null &&
        "source" in value &&
        typeof value.source === "string" &&
        "context" in value &&
        typeof value.context === "object" &&
        value.context !== null &&
        "file" in value.context &&
        typeof value.context.file === "string"
      )
        return { value: value as Unit };
      return { issues: [{ path: ["source"], message: "原文单元格式无效。" }] };
    },
  },
};
const input = { source: "Save", context: { file: "messages.ts" } };
const config = defineConfig({
  source: {
    schema: sourceSchema,
    read: () => ({
      scopes: [
        {
          range: "source",
          enumeration: "complete",
          records: [{ value: input, bodyAvailability: "available" }],
        },
      ],
    }),
  },
  keyOf: ({ source }) => source,
});
const facts = await readFacts(config);
assert.deepEqual(facts.source.units[0]?.unit, input);

const checker = defineChecker.withTypes<Unit, Unit, string>()({
  id: "action-copy",
  version: "1",
  inputSchema: z.object({
    key: z.string(),
    language: z.string(),
    file: z.string(),
    text: z.string(),
    expected: z.string(),
  }),
  load() {
    const index: ReadonlyMap<string, string> = new Map([
      ["Save", "Enregistrer"],
    ]);
    return { lookup: (key: string) => index.get(key), index };
  },
  prepare({ candidate, sourceUnit, loaded }) {
    const expected = loaded.lookup(candidate.sourceKey);
    if (expected === undefined) return { status: "not-applicable" };
    return {
      status: "ready",
      input: {
        key: candidate.sourceKey,
        language: candidate.language,
        file: sourceUnit.unit.context.file,
        text: candidate.content,
        expected,
      },
    };
  },
  check({ key, language, file, text, expected }) {
    return {
      status: "complete",
      diagnostics:
        text === expected
          ? []
          : [
              {
                severity: "warning",
                object: { kind: "translation-unit", key, language },
                location: { language, range: file },
                message: `请使用 ${expected}。`,
                evidence: [],
              },
            ],
      issues: [],
      coverage: {
        selected: 1,
        evaluated: 1,
        notApplicable: 0,
        incomplete: 0,
        failed: 0,
      },
    };
  },
});

const qaConfig = defineConfig({
  source: config.source,
  keyOf: config.keyOf,
  translations: {
    languages: ["fr"],
    schema: sourceSchema,
    contentSchema: z.string(),
    keyOf: () => "Save",
    contentOf: ({ source }) => source,
    read: () => ({ scopes: [] }),
  },
  quality: { checks: [checker] },
});
const result = await analyzeQuality(qaConfig, {
  checkIds: ["action-copy"],
  candidates: [{ sourceKey: "Save", language: "fr", content: "Sauver" }],
});
assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
assert.equal(result.diagnostics[0]?.message, "请使用 Enregistrer。");
assert.equal(result.diagnostics[0]?.location.range, "messages.ts");
assert.equal(Object.hasOwn(result.checks[0] ?? {}, "configuration"), false);
assert.equal(Object.hasOwn(result.checks[0] ?? {}, "dependencies"), false);
assert.deepEqual(
  Object.keys(result.checks[0]?.executions[0]?.fingerprintSummary ?? {}).sort(),
  ["inputFingerprint", "version"],
);
