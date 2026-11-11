import assert from "node:assert/strict";
import { test } from "node:test";

import {
  analyzeQuality,
  createQualityException,
  defineChecker,
  defineConfig,
  type QualityCheckDefinition,
  type QualityCheckOutcome,
  type QualityExceptionStore,
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
  exceptionStore?: QualityExceptionStore,
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
      ...(exceptionStore === undefined ? {} : { exceptionStore }),
    },
  });
}

const complete = {
  status: "complete",
  diagnostics: [],
  issues: [],
  coverage: {
    selected: 1,
    evaluated: 1,
    notApplicable: 0,
    incomplete: 0,
    failed: 0,
  },
} satisfies QualityCheckOutcome;

void test("按最终输入指纹为无诊断的 not-applicable 执行应用例外", async () => {
  const checker = defineChecker.withTypes<Unit, Translation, string, never>()({
    id: "scope-specific-check",
    version: "scope-specific-v1",
    inputSchema: schemaFromExamples(""),
    prepare: ({ candidate }) => ({
      status: "ready",
      input: candidate.content,
    }),
    check(input) {
      assert.equal(input, "Bonjour");
      return {
        status: "not-applicable",
        diagnostics: [],
        issues: [],
        coverage: {
          selected: 1,
          evaluated: 0,
          notApplicable: 1,
          incomplete: 0,
          failed: 0,
        },
      };
    },
  });
  const first = await analyzeQuality(configFor([checker]), { candidates });
  const execution = first.checks[0]?.executions[0];
  assert.ok(execution?.inputFingerprint);
  const exception = createQualityException({
    id: "allow-scope-specific",
    reason: "该检查结果不适用于此候选。",
    execution,
  });
  const store: QualityExceptionStore = {
    async load() {
      return [exception];
    },
    async upsert() {},
  };

  const result = await analyzeQuality(configFor([checker], store), {
    candidates,
  });

  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.exceptionApplicability, [
    {
      exceptionId: "allow-scope-specific",
      checkId: "scope-specific-check",
      sourceKey: "hello",
      language: "fr",
      executionId: 0,
      candidateIndex: 0,
      status: "applicable",
    },
  ]);
});

void test("区分未配置检查、空候选与不适用结果，并拒绝重复 ID", async () => {
  let checkCalls = 0;
  const checker = defineChecker.withTypes<Unit, Translation, string, never>()({
    id: "scope-check",
    version: "scope-check-v1",
    inputSchema: schemaFromExamples(""),
    prepare: ({ candidate }) => ({
      status: "ready",
      input: candidate.content,
    }),
    check() {
      checkCalls += 1;
      return {
        status: "not-applicable",
        diagnostics: [],
        issues: [],
        coverage: {
          selected: 1,
          evaluated: 0,
          notApplicable: 1,
          incomplete: 0,
          failed: 0,
        },
      };
    },
  });

  const noChecks = await analyzeQuality(configFor([]));
  const noCandidates = await analyzeQuality(configFor([checker]), {
    candidates: [],
  });
  const notApplicable = await analyzeQuality(configFor([checker]), {
    candidates,
  });

  assert.deepEqual(noChecks.checks, []);
  assert.equal(noChecks.checkScope.configuredCount, 0);
  assert.equal(noCandidates.checks[0]?.executions.length, 0);
  assert.equal(checkCalls, 1);
  assert.equal(notApplicable.checks[0]?.status, "not-applicable");
  await assert.rejects(analyzeQuality(configFor([checker, checker])), {
    message: "QA 检查项 id scope-check 重复。",
  });
});

void test("例外豁免匹配执行的全部诊断并保留证据", async () => {
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
    prepare: ({ candidate }) => ({
      status: "ready",
      input: candidate.content,
    }),
    check(): QualityCheckOutcome {
      return { ...complete, diagnostics: [sourceDiagnostic, targetDiagnostic] };
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
    prepare: ({ candidate }) => ({
      status: "ready",
      input: candidate.content,
    }),
    check(): QualityCheckOutcome {
      return {
        ...complete,
        diagnostics: [{ ...sourceDiagnostic, message: "独立检查仍需复核。" }],
      };
    },
  });
  const checks: readonly Checker[] = [review, independent];
  const first = await analyzeQuality(configFor(checks), { candidates });
  const execution = first.checks[0]?.executions[0];
  assert.ok(execution?.inputFingerprint);
  const exception = createQualityException({
    id: "allow-reviewed-copy",
    reason: "该候选已经由维护者确认。",
    execution,
  });
  const store: QualityExceptionStore = {
    async load() {
      return [exception];
    },
    async upsert() {},
  };

  const result = await analyzeQuality(configFor(checks, store), { candidates });

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
          status: "excepted",
          exceptionId: "allow-reviewed-copy",
          reason: "该候选已经由维护者确认。",
        },
        evidence: ["source marker"],
      },
      {
        checkId: "example-rule",
        handling: {
          status: "excepted",
          exceptionId: "allow-reviewed-copy",
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
  assert.equal(result.exceptionApplicability[0]?.status, "applicable");
});
