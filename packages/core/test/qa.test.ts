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
  const evaluatedWithDebug = await runQa(configFor([checker]), {
    candidates,
    includeCleanExecutions: true,
  });

  assert.deepEqual(noChecks.checks, []);
  assert.equal(noChecks.checkScope.configuredCount, 0);
  assert.equal(noCandidates.checks[0]?.executions.length, 0);
  assert.equal(checkCalls, 2);
  assert.deepEqual(evaluated.checks[0]?.coverage, {
    selected: 1,
    evaluated: 1,
  });
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

void test("全量 QA 成批报告五类失效豁免并按语言、零对象与零规则范围正确核验", async () => {
  type MultiUnit = { readonly key: string; readonly source: string };
  type MultiTranslation = { readonly id: string; readonly text: string };
  type MultiChecker = QualityCheckDefinition<
    MultiUnit,
    MultiTranslation,
    QualityObject,
    string,
    never
  >;

  let versionedRuleVersion = "v1";
  let sourceUnits: MultiUnit[] = [
    { key: "k-valid", source: "Valid" },
    { key: "k-removed", source: "Removed" },
    { key: "k-fp", source: "Old" },
    { key: "k-clean", source: "Clean" },
    { key: "k-null", source: "Null" },
  ];
  let translationsByLang: Record<string, MultiTranslation[]> = {
    fr: [
      { id: "k-valid", text: "Valide" },
      { id: "k-removed", text: "Supprime" },
      { id: "k-fp", text: "Ancien" },
      { id: "k-clean", text: "Propre" },
    ],
    de: [
      { id: "k-valid", text: "Gueltig" },
      { id: "k-removed", text: "Entfernt" },
      { id: "k-fp", text: "Alt" },
      { id: "k-clean", text: "Sauber" },
      { id: "k-null", text: "Null" },
    ],
    es: [{ id: "k-valid", text: "Valido" }],
  };
  let configuredLanguages: string[] = ["fr", "de", "es"];
  let suppressions: ReturnType<typeof createQaSuppression>[] = [];
  let storeWrites = 0;
  let forceIncompleteRead = false;
  let forceCheckerThrow = false;
  let cleanProducesDiagnostic = true;

  const store: QaSuppressionStore = {
    async load() {
      return suppressions;
    },
    async upsert(value) {
      storeWrites += 1;
      suppressions = [...suppressions, value];
    },
  };

  const makeNullableSchema = () => ({
    "~standard": {
      version: 1 as const,
      vendor: "test",
      validate(value: unknown) {
        if (value === null || typeof value === "string") return { value };
        return { issues: [{ message: "must be string or null" }] };
      },
      types: {
        input: "" as string | null,
        output: "" as string | null,
      },
    },
  });

  const makeRule = (id: string, version = "v1"): MultiChecker =>
    defineChecker.withTypes<MultiUnit, MultiTranslation, string, never>()({
      id,
      version,
      inputSchema: makeNullableSchema(),
      prepare({ sourceUnit, candidate, association }) {
        if (forceCheckerThrow) throw new Error("规则执行异常");
        if (id === "missing-nullable") {
          return candidate === null
            ? `${association.sourceKey}:${association.language}`
            : null;
        }
        return `${association.sourceKey}:${sourceUnit.unit.source}:${candidate?.content ?? ""}`;
      },
      check(input) {
        if (input === null) return [];
        if (id === "clean-rule" && !cleanProducesDiagnostic) return [];
        const [key = "any"] = input.split(":");
        return [
          {
            severity: "error",
            object: { kind: "translation-unit", key },
            location: { language: null, range: null },
            message: `${id}:${input}`,
            evidence: [],
          },
        ];
      },
    });

  const buildConfig = (
    checks: readonly MultiChecker[],
    groups?: Record<string, readonly string[]>,
  ) =>
    defineConfig({
      source: {
        schema: sourceSchemaFromExamples(
          sourceUnits[0] ?? { key: "k", source: "s" },
        ),
        read: () => ({
          scopes: [
            {
              range: "source.json",
              enumeration: "complete",
              records: sourceUnits.map((value) => ({
                value,
                bodyAvailability: "available",
              })),
            },
          ],
        }),
      },
      keyOf: ({ key }) => key,
      translations: {
        languages: configuredLanguages,
        schema: schemaFromExamples({ id: "k", text: "t" }),
        contentSchema: schemaFromExamples(""),
        contentOf: ({ text }) => text,
        keyOf: fixtureTranslationKey,
        read: (language) => ({
          scopes: [
            {
              range: `${language}.json`,
              covers: sourceUnits.map(({ key }) => key),
              enumeration: forceIncompleteRead ? "partial" : "complete",
              records: (translationsByLang[language] ?? []).map((value) => ({
                value,
                bodyAvailability: "available",
              })),
            },
          ],
        }),
      },
      quality: {
        checks,
        ...(groups === undefined ? {} : { groups }),
        suppressionStore: store,
      },
    });

  // 1. 先在初始基线上为各场景建立豁免记录
  const initialChecks = [
    makeRule("keep-rule"),
    makeRule("removed-rule"),
    makeRule("clean-rule"),
    makeRule("missing-nullable"),
    makeRule("versioned-rule", versionedRuleVersion),
  ];
  const baseline = await runQa(buildConfig(initialChecks));
  const findExec = (checkId: string, sourceKey: string, language: string) => {
    const found = baseline.checks
      .find((check) => check.checkId === checkId)
      ?.executions.find(
        (item) => item.sourceKey === sourceKey && item.language === language,
      );
    assert.ok(found);
    return found;
  };
  suppressions = [
    createQaSuppression({
      id: "valid-fr",
      reason: "有效记录",
      execution: findExec("keep-rule", "k-valid", "fr"),
    }),
    createQaSuppression({
      id: "stale-de-removed-key",
      reason: "德语失效记录",
      execution: findExec("keep-rule", "k-removed", "de"),
    }),
    createQaSuppression({
      id: "stale-removed-lang",
      reason: "语言将被移除",
      execution: findExec("keep-rule", "k-valid", "es"),
    }),
    createQaSuppression({
      id: "stale-removed-check",
      reason: "检查项将被移除",
      execution: findExec("removed-rule", "k-valid", "fr"),
    }),
    createQaSuppression({
      id: "stale-fp-fr",
      reason: "输入指纹将改变",
      execution: findExec("keep-rule", "k-fp", "fr"),
    }),
    createQaSuppression({
      id: "stale-version-fr",
      reason: "实现版本将改变",
      execution: findExec("versioned-rule", "k-valid", "fr"),
    }),
    createQaSuppression({
      id: "stale-clean-fr",
      reason: "同指纹下将不再产出诊断",
      execution: findExec("clean-rule", "k-clean", "fr"),
    }),
    createQaSuppression({
      id: "stale-nullable-fr",
      reason: "补齐译文后 prepare 返回 null",
      execution: findExec("missing-nullable", "k-null", "fr"),
    }),
  ];

  // 2. 模拟资源与配置变更：移除 es、k-removed、removed-rule；修改 k-fp 译文；升级 versioned-rule 版本；clean-rule 变无诊断；k-null 补齐译文
  configuredLanguages = ["fr", "de"];
  sourceUnits = sourceUnits.filter(({ key }) => key !== "k-removed");
  translationsByLang = {
    fr: [
      { id: "k-valid", text: "Valide" },
      { id: "k-fp", text: "Nouveau" },
      { id: "k-clean", text: "Propre" },
      { id: "k-null", text: "Traduit" },
    ],
    de: [
      { id: "k-valid", text: "Gueltig" },
      { id: "k-fp", text: "Alt" },
      { id: "k-clean", text: "Sauber" },
      { id: "k-null", text: "Null" },
    ],
  };
  cleanProducesDiagnostic = false;
  versionedRuleVersion = "v2";
  const currentChecks = [
    makeRule("keep-rule"),
    makeRule("clean-rule"),
    makeRule("missing-nullable"),
    makeRule("versioned-rule", versionedRuleVersion),
  ];
  const currentGroups = {
    all: ["keep-rule", "clean-rule", "missing-nullable", "versioned-rule"],
  };

  // 3. 局部与草稿运行跳过失效核验并省略进度，同时继续应用有效豁免
  const partialByCheck = await runQa(
    buildConfig(currentChecks, currentGroups),
    {
      checkIds: ["keep-rule"],
    },
  );
  assert.equal(partialByCheck.progress, undefined);
  assert.equal(
    partialByCheck.diagnostics.find(
      ({ checkId, object }) =>
        checkId === "keep-rule" && object.key === "k-valid",
    )?.handling.status,
    "suppressed",
  );

  const partialByCandidates = await runQa(buildConfig(currentChecks), {
    selectCandidates: (items) =>
      items.filter(
        ({ sourceKey, language }) =>
          sourceKey === "k-valid" && language === "fr",
      ),
  });
  assert.equal(partialByCandidates.progress, undefined);

  const draft = await runQa(buildConfig(currentChecks), {
    candidates: [{ sourceKey: "k-valid", language: "fr", content: "Valide" }],
  });
  assert.equal(draft.progress, undefined);
  assert.equal(
    draft.diagnostics.find(({ checkId }) => checkId === "keep-rule")?.handling
      .status,
    "suppressed",
  );

  // 4. 仅完整检查 de：只核验 de 记录，不报 fr 或已移除语言 es 的失效记录
  const staleDeSuppression = suppressions.find(
    ({ id }) => id === "stale-de-removed-key",
  )!;
  suppressions = suppressions.filter(({ id }) => id !== "stale-de-removed-key");
  const deOnly = await runQa(buildConfig(currentChecks), {
    languages: ["de"],
  });
  assert.equal(deOnly.progress?.length, 1);
  assert.equal(deOnly.progress?.[0]?.language, "de");
  // 恢复 de 失效记录后，仅查 de 时会报出该记录，仍不报 fr/es 失效记录
  suppressions = [...suppressions, staleDeSuppression];
  await assert.rejects(
    runQa(buildConfig(currentChecks), { languages: ["de"] }),
    (error: Error) => {
      assert.match(
        error.message,
        /stale-de-removed-key（keep-rule，k-removed，de）：原文键已不存在/u,
      );
      assert.doesNotMatch(error.message, /stale-fp-fr/u);
      assert.doesNotMatch(error.message, /stale-removed-lang/u);
      return true;
    },
  );

  // 5. 全项目运行一次成批报出全部失效记录和原因（含等价的显式全部 checkIds / groups）
  for (const selection of [
    {},
    {
      checkIds: [
        "keep-rule",
        "clean-rule",
        "missing-nullable",
        "versioned-rule",
      ],
    },
    { groups: ["all"] },
  ] as const) {
    await assert.rejects(
      runQa(buildConfig(currentChecks, currentGroups), selection),
      (error: Error) => {
        assert.match(error.message, /stale-de-removed-key.*原文键已不存在/u);
        assert.match(error.message, /stale-removed-lang.*目标语言已不存在/u);
        assert.match(error.message, /stale-removed-check.*检查项已不存在/u);
        assert.match(error.message, /stale-fp-fr.*检查输入指纹已改变/u);
        assert.match(error.message, /stale-version-fr.*检查实现版本已改变/u);
        assert.match(
          error.message,
          /stale-clean-fr.*当前依据下没有可豁免的诊断/u,
        );
        assert.match(error.message, /stale-nullable-fr.*检查输入指纹已改变/u);
        assert.doesNotMatch(error.message, /valid-fr/u);
        return true;
      },
    );
  }

  // 6. 读取或检查执行失败时报告实际错误，不误报豁免失效且不改动宿主豁免记录
  const snapshotBeforeError = [...suppressions];
  forceIncompleteRead = true;
  await assert.rejects(runQa(buildConfig(currentChecks)), /译文 fr读取不完整/u);
  forceIncompleteRead = false;
  forceCheckerThrow = true;
  await assert.rejects(runQa(buildConfig(currentChecks)), /规则执行异常/u);
  forceCheckerThrow = false;
  assert.deepEqual(suppressions, snapshotBeforeError);
  assert.equal(storeWrites, 0);

  // 7. 零规则与零对象（空项目）也不能掩盖已有失效豁免；清理后重跑成功
  await assert.rejects(
    runQa(buildConfig([])),
    /valid-fr（keep-rule，k-valid，fr）：检查项已不存在/u,
  );
  const savedUnits = sourceUnits;
  const savedTranslations = translationsByLang;
  sourceUnits = [];
  translationsByLang = { fr: [], de: [] };
  await assert.rejects(
    runQa(buildConfig(currentChecks)),
    /valid-fr（keep-rule，k-valid，fr）：原文键已不存在/u,
  );
  // 手动清理后重新运行成功
  suppressions = [];
  const emptySuccess = await runQa(buildConfig(currentChecks));
  assert.deepEqual(emptySuccess.progress, [
    { language: "fr", completed: 0, total: 0 },
    { language: "de", completed: 0, total: 0 },
  ]);

  sourceUnits = savedUnits;
  translationsByLang = savedTranslations;
  const zeroChecksSuccess = await runQa(buildConfig([]));
  assert.deepEqual(zeroChecksSuccess.progress, [
    { language: "fr", completed: 4, total: 4, percentage: 100 },
    { language: "de", completed: 4, total: 4, percentage: 100 },
  ]);
});
