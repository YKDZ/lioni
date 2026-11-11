import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  analyzeQuality,
  defineChecker,
  defineConfig,
  type CacheableQualityCheckOutcome,
  type QualityCheckResultCache,
} from "../src/index.ts";
import {
  schemaFromExamples,
  sourceSchemaFromExamples,
} from "./source-schema.ts";

type Unit = { readonly id: string; readonly source: string };
type Translation = { readonly id: string; readonly text: string };

const unit: Unit = { id: "save", source: "Save" };
const translation: Translation = { id: "save", text: "Enregistrer" };

const oldOutcome: CacheableQualityCheckOutcome = {
  status: "complete",
  diagnostics: [
    {
      severity: "error",
      object: { kind: "translation-unit", key: "save", language: "fr" },
      location: { language: "fr", range: "fr.json" },
      message: "结果来自旧检查输入契约。",
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

void describe("QA 输入指纹升级", () => {
  void it("旧契约缓存不命中并使用当前规则的原始结果", async () => {
    // 该键由 v1 正式 QA 流程为相同检查身份和项目事实生成。
    const legacyCacheKey =
      "sha256:46503d79956e6b309fe75113a1e0d3b6fd9f7d4138da7a9e81404b8add40f8af";
    const entries = new Map([[legacyCacheKey, oldOutcome]]);
    const requestedKeys: string[] = [];
    const cache: QualityCheckResultCache = {
      async get(key) {
        requestedKeys.push(key);
        return entries.get(key);
      },
      async set(key, outcome) {
        entries.set(key, outcome);
      },
    };
    let checkCount = 0;
    const checker = defineChecker.withTypes<Unit, Translation, string>()({
      id: "legacy-cache-check",
      version: "legacy-cache-fixture-v1",
      inputSchema: schemaFromExamples({ source: "", content: "" }),
      prepare({ candidate, sourceUnit }) {
        return {
          status: "ready",
          input: {
            source: sourceUnit.unit.source,
            content: candidate.content,
          },
        };
      },
      check() {
        checkCount += 1;
        return {
          ...oldOutcome,
          diagnostics: oldOutcome.diagnostics.map((diagnostic) => ({
            ...diagnostic,
            message: "结果由当前检查输入契约重新计算。",
          })),
        };
      },
    });
    const config = defineConfig({
      source: {
        schema: sourceSchemaFromExamples(unit),
        read: () => ({
          scopes: [
            {
              range: "source.json",
              enumeration: "complete",
              records: [{ value: unit, bodyAvailability: "available" }],
            },
          ],
        }),
      },
      keyOf: ({ id }) => id,
      translations: {
        languages: ["fr"],
        schema: schemaFromExamples(translation),
        contentSchema: schemaFromExamples(""),
        contentOf: ({ text }) => text,
        keyOf: ({ id }) => id,
        read: () => ({
          scopes: [
            {
              range: "fr.json",
              covers: ["save"],
              enumeration: "complete",
              records: [{ value: translation, bodyAvailability: "available" }],
            },
          ],
        }),
      },
      quality: { checks: [checker], resultCache: cache },
    });

    const result = await analyzeQuality(config);

    assert.equal(checkCount, 1);
    assert.equal(
      result.checks[0]?.diagnostics[0]?.message,
      "结果由当前检查输入契约重新计算。",
    );
    assert.equal(requestedKeys.length, 1);
    assert.notEqual(requestedKeys[0], legacyCacheKey);
  });
});
