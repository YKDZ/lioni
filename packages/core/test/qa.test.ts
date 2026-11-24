import assert from "node:assert/strict";
import { test } from "node:test";

import {
  runQa,
  createQaSuppression,
  defineChecker,
  defineConfig,
  type QualityCheckDefinition,
  type QualityFinding,
  type QaSuppressionStore,
  type QualityObject,
} from "../src/index.ts";
import {
  fixtureTranslationKey,
  schemaFromExamples,
  sourceSchemaFromExamples,
} from "./source-schema.ts";

type Unit = { readonly source: string };
type Translation = { readonly id: string; readonly text: string };
type Checker = QualityCheckDefinition<
  Unit,
  Translation,
  QualityObject,
  string,
  never
>;

const unit = { source: "Hello" };
const translation = { id: "hello", text: "Bonjour" };
const candidates = [{ sourceKey: "hello", language: "fr", content: "Bonjour" }];

function configFor(
  checks: readonly Checker[],
  suppressionStore?: QaSuppressionStore,
) {
  return defineConfig({
    source: {
      schema: sourceSchemaFromExamples(unit),
      read: () => ({
        scopes: [
          {
            range: "messages.json",
            enumeration: "complete",
            records: [{ value: unit, bodyAvailability: "available" }],
          },
        ],
      }),
    },
    keyOf: () => "hello",
    translations: {
      languages: ["fr"],
      schema: schemaFromExamples(translation),
      contentSchema: schemaFromExamples(""),
      contentOf: ({ text }) => text,
      keyOf: fixtureTranslationKey,
      read: () => ({
        scopes: [
          {
            range: "messages.fr.json",
            covers: ["hello"],
            enumeration: "complete",
            records: [{ value: translation, bodyAvailability: "available" }],
          },
        ],
      }),
    },
    quality: {
      checks,
      ...(suppressionStore === undefined ? {} : { suppressionStore }),
    },
  });
}

void test("区分未配置检查、空候选与无诊断结果，并拒绝重复 ID", async () => {
  let checkCalls = 0;
  const checker = defineChecker.withTypes<Unit, Translation, string, never>()({
    id: "scope-check",
    version: "scope-check-v1",
    inputSchema: schemaFromExamples(""),
    prepare: ({ candidate }) => candidate?.content ?? "",
    check() {
      checkCalls += 1;
      return [];
    },
  });

  const noChecks = await runQa(configFor([]));
  const noCandidates = await runQa(configFor([checker]), {
    candidates: [],
  });
  const evaluated = await runQa(configFor([checker]), {
    candidates,
  });

  assert.deepEqual(noChecks.checks, []);
  assert.equal(noChecks.checkScope.configuredCount, 0);
  assert.equal(noCandidates.checks[0]?.executions.length, 0);
  assert.equal(checkCalls, 1);
  assert.equal(evaluated.checks[0]?.status, "complete");
  await assert.rejects(runQa(configFor([checker, checker])), {
    message: "QA 检查项 id scope-check 重复。",
  });
});

void test("豁免匹配执行的全部诊断并保留证据", async () => {
  const makeDiagnostic = (value: string) => ({
    severity: "error" as const,
    object: { kind: "translation-unit", key: "hello", language: "fr" },
    location: { language: "fr", range: "messages.fr.json", key: "hello" },
    message: `候选需要复核：${value}`,
    evidence: [
      {
        role: "input" as const,
        object: { kind: "translation-unit", key: "hello", language: "fr" },
        location: { language: "fr", range: "messages.fr.json", key: "hello" },
        value,
      },
    ],
  });
  const sourceDiagnostic = makeDiagnostic("source marker");
  const targetDiagnostic = makeDiagnostic("target marker");
  const review = defineChecker.withTypes<Unit, Translation, string, never>()({
    id: "example-rule",
    version: "example-rule-v1",
    inputSchema: schemaFromExamples(""),
    prepare: ({ candidate }) => candidate?.content ?? "",
    check(): ReadonlyArray<QualityFinding> {
      return [sourceDiagnostic, targetDiagnostic];
    },
  });
  const independent = defineChecker.withTypes<
    Unit,
    Translation,
    string,
    never
  >()({
    id: "other-rule",
    version: "other-rule-v1",
    inputSchema: schemaFromExamples(""),
    prepare: ({ candidate }) => candidate?.content ?? "",
    check(): ReadonlyArray<QualityFinding> {
      return [{ ...sourceDiagnostic, message: "独立检查仍需复核。" }];
    },
  });
  const checks: readonly Checker[] = [review, independent];
  const first = await runQa(configFor(checks), { candidates });
  const execution = first.checks[0]?.executions[0];
  assert.ok(execution?.inputFingerprint);
  const suppression = createQaSuppression({
    id: "allow-reviewed-copy",
    reason: "该候选已经由维护者确认。",
    execution,
  });
  const store: QaSuppressionStore = {
    async load() {
      return [suppression];
    },
    async upsert() {},
  };

  const result = await runQa(configFor(checks, store), { candidates });

  assert.deepEqual(
    result.diagnostics.map(({ checkId, handling, evidence }) => ({
      checkId,
      handling,
      evidence: evidence.map(({ value }) => value),
    })),
    [
      {
        checkId: "example-rule",
        handling: {
          status: "suppressed",
          suppressionId: "allow-reviewed-copy",
          reason: "该候选已经由维护者确认。",
        },
        evidence: ["source marker"],
      },
      {
        checkId: "example-rule",
        handling: {
          status: "suppressed",
          suppressionId: "allow-reviewed-copy",
          reason: "该候选已经由维护者确认。",
        },
        evidence: ["target marker"],
      },
      {
        checkId: "other-rule",
        handling: { status: "active" },
        evidence: ["source marker"],
      },
    ],
  );
});
