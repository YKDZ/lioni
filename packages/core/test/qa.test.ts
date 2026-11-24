import assert from "node:assert/strict";
import { test } from "node:test";

import {
  runQa,
  createQaSuppression,
  decideQualityReport,
  defineChecker,
  defineConfig,
  formatQualityReport,
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
  const evaluatedWithDebug = await runQa(configFor([checker]), {
    candidates,
    includeCleanExecutions: true,
  });

  assert.deepEqual(noChecks.checks, []);
  assert.deepEqual(noChecks.checkScope, {
    configuredCount: 0,
    selectedIds: [],
    evaluatedCount: 0,
  });
  assert.equal(noCandidates.checks[0]?.executions.length, 0);
  assert.equal(noCandidates.checkScope.evaluatedCount, 0);
  assert.equal(checkCalls, 2);
  assert.deepEqual(evaluated.checks[0]?.coverage, {
    selected: 1,
    evaluated: 1,
  });
  assert.equal(evaluated.checkScope.evaluatedCount, 1);
  assert.deepEqual(evaluated.checks[0]?.executions, []);
  assert.equal(evaluatedWithDebug.checks[0]?.executions.length, 1);
  assert.ok(evaluatedWithDebug.checks[0]?.executions[0]?.inputFingerprint);
  await assert.rejects(runQa(configFor([checker, checker])), {
    message: "QA 检查项 id scope-check 重复。",
  });
});

void test("默认裁剪零诊断执行但仍校验全量失效豁免", async () => {
  const cleanChecker = defineChecker.withTypes<
    Unit,
    Translation,
    string,
    never
  >()({
    id: "clean-rule",
    version: "clean-rule-v1",
    inputSchema: schemaFromExamples(""),
    prepare: ({ candidate }) => candidate?.content ?? "",
    check: () => [],
  });
  const baseline = await runQa(configFor([cleanChecker]), {
    includeCleanExecutions: true,
  });
  const cleanExecution = baseline.checks[0]?.executions[0];
  assert.ok(cleanExecution);
  const staleCleanSuppression = createQaSuppression({
    id: "stale-clean",
    reason: "已在默认报告中裁剪零诊断执行。",
    execution: cleanExecution,
  });
  const store: QaSuppressionStore = {
    async load() {
      return [staleCleanSuppression];
    },
    async upsert() {},
  };

  await assert.rejects(
    runQa(configFor([cleanChecker], store)),
    /stale-clean（clean-rule，hello，fr）：当前依据下没有可豁免的诊断/,
  );
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

void test("进度按对象去重统计各严重度，忽略跨消息证据，并正确处理单语与边界范围", async () => {
  const units = [
    { source: "Greeting" },
    { source: "Button" },
    { source: "Brand" },
  ] as const;
  const unitKeys = ["greeting", "button", "brand"] as const;
  const translationsByLang: Readonly<
    Record<string, readonly { readonly id: string; readonly text: string }[]>
  > = {
    fr: [
      { id: "greeting", text: "Bonjour" },
      { id: "button", text: "Ouvrir" },
      { id: "brand", text: "Lioni" },
      { id: "orphan", text: "Orphelin" },
    ],
    de: [
      { id: "greeting", text: "Hallo" },
      { id: "button", text: "Öffnen" },
      { id: "brand", text: "Lioni" },
    ],
  };

  const ruleA = defineChecker.withTypes<Unit, Translation, string, never>()({
    id: "rule-a",
    version: "1",
    inputSchema: schemaFromExamples(""),
    prepare: ({ association }) =>
      `${association.sourceKey}:${association.language}`,
    check(subject): readonly QualityFinding[] {
      const [key = "", language = ""] = subject.split(":");
      if (key === "button") {
        // 同一检查在同一对象上产生 info + warning，并附带指向 brand 的跨消息证据。
        return (["info", "warning"] as const).map((severity) => ({
          severity,
          object: { kind: "translation-unit", key, language },
          location: { language, range: `${language}.json`, key },
          message: `问题 ${severity}`,
          evidence: [
            {
              role: "reference",
              object: { kind: "translation-unit", key: "brand", language },
              location: { language, range: `${language}.json`, key: "brand" },
              value: "Lioni",
            },
          ],
        }));
      }
      if (key === "greeting" && language === "fr") {
        return [
          {
            severity: "info",
            object: { kind: "translation-unit", key, language },
            location: { language, range: `${language}.json`, key },
            message: "仅提示。",
            evidence: [],
          },
        ];
      }
      return [];
    },
  });

  const ruleB = defineChecker.withTypes<Unit, Translation, string, never>()({
    id: "rule-b",
    version: "1",
    inputSchema: schemaFromExamples(""),
    prepare: ({ association }) =>
      `${association.sourceKey}:${association.language}`,
    check(subject): readonly QualityFinding[] {
      const [key = "", language = ""] = subject.split(":");
      if (key === "button" && language === "fr") {
        return [
          {
            severity: "error",
            object: { kind: "translation-unit", key, language },
            location: { language, range: "fr.json", key },
            message: "需要修正错误。",
            evidence: [],
          },
        ];
      }
      return [];
    },
  });

  let currentSuppressions: readonly ReturnType<typeof createQaSuppression>[] =
    [];
  const makeMultiConfig = (
    checks: readonly Checker[],
    sourceList: readonly Unit[] = units,
    keyList: readonly string[] = unitKeys,
  ) =>
    defineConfig({
      source: {
        schema: sourceSchemaFromExamples(unit),
        read: () => ({
          scopes: [
            {
              range: "messages.json",
              enumeration: "complete",
              records: sourceList.map((value) => ({
                value,
                bodyAvailability: "available" as const,
              })),
            },
          ],
        }),
      },
      keyOf: (value) => {
        const index = sourceList.indexOf(value);
        return keyList[index] ?? "unknown";
      },
      translations: {
        languages: ["fr", "de"],
        schema: schemaFromExamples(translation),
        contentSchema: schemaFromExamples(""),
        contentOf: ({ text }) => text,
        keyOf: fixtureTranslationKey,
        read: (language, sourceUnits) => ({
          scopes: [
            {
              range: `${language}.json`,
              covers: sourceUnits.map(({ key }) => key),
              enumeration: "complete",
              records: (translationsByLang[language] ?? []).map((value) => ({
                value,
                bodyAvailability: "available" as const,
              })),
            },
          ],
        }),
      },
      quality: {
        checks,
        suppressionStore: {
          async load() {
            return currentSuppressions;
          },
          async upsert() {},
        },
      },
    });

  // 1. 两个检查项都在 button(fr) 上有诊断只扣 1 项；greeting(fr) 仅 info 扣 1 项；brand(fr) 仅作 evidence 不扣减。
  const full = await runQa(makeMultiConfig([ruleA, ruleB]));
  assert.equal(full.checkScope.evaluatedCount, 2);
  assert.deepEqual(full.progress, [
    { language: "fr", completed: 1, total: 3, percentage: 100 / 3 },
    { language: "de", completed: 2, total: 3, percentage: 200 / 3 },
  ]);
  assert.equal(decideQualityReport(full).passed, false);

  // 2. 仅选 fr 时只计算 fr 完整进度。
  const frOnly = await runQa(makeMultiConfig([ruleA, ruleB]), {
    languages: ["fr"],
  });
  assert.deepEqual(frOnly.progress, [
    { language: "fr", completed: 1, total: 3, percentage: 100 / 3 },
  ]);

  // 3. 豁免 rule-b 后 button(fr) 仍有 rule-a 的 warning/info，因此 fr 仍为 1/3，但门禁通过。
  const ruleBExec = full.checks
    .find(({ checkId }) => checkId === "rule-b")
    ?.executions.find(
      ({ sourceKey, language }) => sourceKey === "button" && language === "fr",
    );
  assert.ok(ruleBExec);
  currentSuppressions = [
    createQaSuppression({
      id: "suppress-rule-b-button",
      reason: "暂留后续处理",
      execution: ruleBExec,
    }),
  ];
  const onlyWarnInfo = await runQa(makeMultiConfig([ruleA, ruleB]), {
    languages: ["fr"],
  });
  assert.deepEqual(onlyWarnInfo.progress, [
    { language: "fr", completed: 1, total: 3, percentage: 100 / 3 },
  ]);
  assert.equal(decideQualityReport(onlyWarnInfo).passed, true);

  // 4. 筛选候选或传 selectCandidates 时省略 progress。
  const filteredCandidates = await runQa(makeMultiConfig([ruleA, ruleB]), {
    selectCandidates: (all) => all.slice(0, 1),
  });
  assert.equal(filteredCandidates.progress, undefined);

  // 5. 完整空项目（另有孤立译文）报告 0/0、省略 percentage、evaluatedCount 为 0 且通过。
  currentSuppressions = [];
  const emptyProject = await runQa(makeMultiConfig([ruleA], [], []), {
    languages: ["fr"],
  });
  assert.deepEqual(emptyProject.progress, [
    { language: "fr", completed: 0, total: 0 },
  ]);
  assert.equal(Object.hasOwn(emptyProject.progress[0]!, "percentage"), false);
  assert.equal(emptyProject.checkScope.evaluatedCount, 0);
  assert.equal(decideQualityReport(emptyProject).passed, true);
  assert.match(formatQualityReport(emptyProject), /运行了 0 项检查/u);

  // 6. 有对象但配置 0 项检查时为 100%、evaluatedCount 为 0、门禁不通过。
  const zeroChecks = await runQa(makeMultiConfig([]), { languages: ["fr"] });
  assert.deepEqual(zeroChecks.progress, [
    { language: "fr", completed: 3, total: 3, percentage: 100 },
  ]);
  assert.equal(zeroChecks.checkScope.evaluatedCount, 0);
  assert.equal(decideQualityReport(zeroChecks).status, "no-checks");
  assert.match(formatQualityReport(zeroChecks), /运行了 0 项检查/u);

  // 7. 有对象且仅有 1 项返回空诊断的规则时为 100%、evaluatedCount 为 1、门禁通过。
  const cleanCheck = defineChecker.withTypes<
    Unit,
    Translation,
    string,
    never
  >()({
    id: "clean-only",
    version: "1",
    inputSchema: schemaFromExamples(""),
    prepare: () => "",
    check: () => [],
  });
  const cleanOnly = await runQa(makeMultiConfig([cleanCheck]), {
    languages: ["fr"],
  });
  assert.deepEqual(cleanOnly.progress, [
    { language: "fr", completed: 3, total: 3, percentage: 100 },
  ]);
  assert.equal(cleanOnly.checkScope.evaluatedCount, 1);
  assert.equal(decideQualityReport(cleanOnly).passed, true);
  assert.match(formatQualityReport(cleanOnly), /运行了 1 项检查/u);
});
