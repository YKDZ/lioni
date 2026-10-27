import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  analyzeQuality,
  bindQualityCheck,
  createQualityException,
  defineConfig,
  type CacheableQualityCheckOutcome,
  type JsonValue,
  type QualityCheckDefinition,
  type QualityCheckOutcome,
  type QualityCheckResultCache,
  type QualityException,
  type QualityExceptionStore,
  type QualityObject,
  type SemanticEditCandidate,
  type StandardSchemaV1,
  StandardSchemaContractError,
} from "../src/index.ts";
import { defineTestQualityCheck } from "./quality-check-fixture.ts";
import {
  jsonValueSchema,
  schemaFromExamples,
  sourceSchemaFromExamples,
  fixtureTranslationIdentity,
} from "./source-schema.ts";

type Unit = { readonly source: string };
type Translation = { readonly id: string; readonly text: string };

const unit: Unit = { source: "Hello" };
const translation: Translation = { id: "message:hello", text: "Bonjour" };
const candidate: SemanticEditCandidate<JsonValue> = {
  sourceKey: "message:hello",
  language: "fr",
  content: "Bonjour",
};

void describe("QA 结果缓存", () => {
  void it("缓存命中时仍使用最新例外并关联本次执行", async () => {
    let checkCount = 0;
    const check = reviewCheck(() => {
      checkCount += 1;
    });
    const cache = createMemoryCache();
    let currentExceptions: readonly QualityException[] = [];
    const exceptionStore: QualityExceptionStore = {
      async load() {
        return currentExceptions;
      },
      async upsert(exception) {
        currentExceptions = [
          ...currentExceptions.filter(({ id }) => id !== exception.id),
          exception,
        ];
      },
    };
    const config = createTestConfig(check, { cache, exceptionStore });

    const first = await analyzeQuality(config);
    assert.equal(first.diagnostics[0]?.handling.status, "active");
    const execution = first.checks[0]?.executions[0];
    assert.ok(execution);
    const exception = createQualityException({
      id: "approved-review",
      reason: "原理由",
      execution,
    });

    currentExceptions = [exception];
    const shiftedConfig = createTestConfig(check, {
      cache,
      exceptionStore,
      precedingChecks: [
        reviewCheck(() => {}, "prior-review-v1", {}, "prior-review"),
      ],
    });
    const excepted = await analyzeQuality(shiftedConfig);
    const exceptedDiagnostic = excepted.diagnostics.find(
      ({ checkId }) => checkId === "message-review",
    );
    assert.equal(exceptedDiagnostic?.executionId, 1);
    assert.deepEqual(exceptedDiagnostic?.handling, {
      status: "excepted",
      exceptionId: "approved-review",
      reason: "原理由",
    });

    currentExceptions = [{ ...exception, reason: "更新后的理由" }];
    const updated = await analyzeQuality(shiftedConfig);
    assert.deepEqual(
      updated.diagnostics.find(({ checkId }) => checkId === "message-review")
        ?.handling,
      {
        status: "excepted",
        exceptionId: "approved-review",
        reason: "更新后的理由",
      },
    );

    currentExceptions = [];
    const removed = await analyzeQuality(shiftedConfig);
    const removedDiagnostic = removed.diagnostics.find(
      ({ checkId }) => checkId === "message-review",
    );
    assert.equal(removedDiagnostic?.executionId, 1);
    assert.deepEqual(removedDiagnostic?.handling, { status: "active" });
    assert.equal(checkCount, 1);
  });

  void it("只缓存 complete 与 not-applicable 原始结果", async () => {
    const scenarios = [
      { status: "complete", cached: true },
      { status: "not-applicable", cached: true },
      { status: "incomplete", cached: false },
      { status: "failed", cached: false },
    ] as const;

    for (const scenario of scenarios) {
      let checkCount = 0;
      const check = defineTestQualityCheck<Unit, Translation, JsonValue>({
        id: `outcome-${scenario.status}`,
        configuration: {},
        check() {
          checkCount += 1;
          return outcomeFor(scenario.status);
        },
      });
      const config = createTestConfig(check, { cache: createMemoryCache() });

      const first = await analyzeQuality(config);
      const second = await analyzeQuality(config);

      assert.equal(first.status, scenario.status);
      assert.equal(second.status, scenario.status);
      assert.equal(checkCount, scenario.cached ? 1 : 2);
      if (scenario.status === "complete") {
        assert.equal(first.diagnostics[0]?.severity, "error");
        assert.equal(second.diagnostics[0]?.severity, "error");
      }
    }
  });

  void it("把结构损坏的自定义缓存结果视为未命中", async () => {
    const validOutcome = reviewOutcome();
    const finding = validOutcome.diagnostics[0];
    assert.ok(finding);
    const invalidOutcomes: readonly { name: string; outcome: unknown }[] = [
      {
        name: "诊断缺少必要字段",
        outcome: { ...validOutcome, diagnostics: [{}] },
      },
      {
        name: "诊断证据缺少必要字段",
        outcome: {
          ...validOutcome,
          diagnostics: [{ ...finding, evidence: [{}] }],
        },
      },
      {
        name: "诊断位置缺少范围",
        outcome: {
          ...validOutcome,
          diagnostics: [{ ...finding, location: { language: "fr" } }],
        },
      },
      {
        name: "检查问题缺少必要字段",
        outcome: { ...validOutcome, issues: [{}] },
      },
    ];

    for (const scenario of invalidOutcomes) {
      let checkCount = 0;
      const cache: QualityCheckResultCache = {
        async get() {
          return scenario.outcome as CacheableQualityCheckOutcome;
        },
        async set() {},
      };
      const result = await analyzeQuality(
        createTestConfig(
          reviewCheck(() => {
            checkCount += 1;
          }),
          { cache },
        ),
      );

      assert.equal(checkCount, 1, scenario.name);
      assert.equal(result.diagnostics[0]?.severity, "error", scenario.name);
      assert.equal(
        result.diagnostics[0]?.message,
        "请复核译文。",
        scenario.name,
      );
      assert.deepEqual(
        result.diagnostics[0]?.location,
        { language: "fr", range: "fr.json" },
        scenario.name,
      );
      assert.deepEqual(result.diagnostics[0]?.evidence, [], scenario.name);
      assert.deepEqual(result.checks[0]?.issues, [], scenario.name);
    }
  });

  void it("命中时仍重新选择、投影并校验，契约错误不会被缓存吞掉", async () => {
    const counts = { select: 0, project: 0, schema: 0, check: 0 };
    let rejectProjectedInput = false;
    let cacheReads = 0;
    const cache = createMemoryCache(() => {
      cacheReads += 1;
    });
    const config = createTestConfig(
      preparedReviewCheck(counts, () => rejectProjectedInput),
      { cache },
    );

    await analyzeQuality(config);
    await analyzeQuality(config);

    assert.deepEqual(counts, { select: 2, project: 2, schema: 2, check: 1 });
    assert.equal(cacheReads, 2);

    rejectProjectedInput = true;
    await assert.rejects(analyzeQuality(config), StandardSchemaContractError);
    assert.deepEqual(counts, { select: 3, project: 3, schema: 3, check: 1 });
    assert.equal(cacheReads, 2);
  });

  void it("候选、最终配置或实现版本变化时重新计算", async () => {
    let checkCount = 0;
    const cache = createMemoryCache();
    const createCheck = (version: string, policy: string) =>
      reviewCheck(
        () => {
          checkCount += 1;
        },
        version,
        { policy },
      );
    const originalConfig = createTestConfig(
      createCheck("review-v1", "strict"),
      {
        cache,
      },
    );

    await analyzeQuality(originalConfig);
    await analyzeQuality(originalConfig);
    assert.equal(checkCount, 1);

    await analyzeQuality(originalConfig, {
      candidates: [{ ...candidate, content: "Salut" }],
    });
    assert.equal(checkCount, 2);

    await analyzeQuality(
      createTestConfig(createCheck("review-v1", "relaxed"), { cache }),
    );
    assert.equal(checkCount, 3);

    await analyzeQuality(
      createTestConfig(createCheck("review-v2", "relaxed"), { cache }),
    );
    assert.equal(checkCount, 4);
  });

  void it("同键同语言的重复候选仍按候选身份分别缓存", async () => {
    let checkCount = 0;
    const cache = createMemoryCache();
    const config = createTestConfig(
      reviewCheck(() => {
        checkCount += 1;
      }),
      { cache },
    );
    const candidates = [candidate, candidate];

    const first = await analyzeQuality(config, { candidates });
    const second = await analyzeQuality(config, { candidates });

    assert.equal(checkCount, 2);
    assert.deepEqual(
      second.checks[0]?.executions.map(({ candidateIndex }) => candidateIndex),
      [0, 1],
    );
    assert.deepEqual(
      second.diagnostics.map(({ executionId }) => executionId),
      first.diagnostics.map(({ executionId }) => executionId),
    );
  });

  void it("缓存读写失败时继续执行检查", async () => {
    let checkCount = 0;
    const cache: QualityCheckResultCache = {
      async get() {
        throw new Error("缓存读取失败");
      },
      async set() {
        throw new Error("缓存写入失败");
      },
    };
    const result = await analyzeQuality(
      createTestConfig(
        reviewCheck(() => {
          checkCount += 1;
        }),
        { cache },
      ),
    );

    assert.equal(result.status, "complete");
    assert.equal(result.diagnostics.length, 1);
    assert.equal(checkCount, 1);
  });

  void it("未装配缓存时每次分析都重新执行检查", async () => {
    let checkCount = 0;
    const config = createTestConfig(
      reviewCheck(() => {
        checkCount += 1;
      }),
    );

    await analyzeQuality(config);
    await analyzeQuality(config);

    assert.equal(checkCount, 2);
  });
});

function createMemoryCache(onRead?: () => void): QualityCheckResultCache {
  const entries = new Map<string, CacheableQualityCheckOutcome>();
  return {
    async get(key) {
      onRead?.();
      return entries.get(key);
    },
    async set(key, outcome) {
      entries.set(key, structuredClone(outcome));
    },
  };
}

type PreparedInput = { readonly source: string; readonly target: JsonValue };

function preparedReviewCheck(
  counts: { select: number; project: number; schema: number; check: number },
  rejectProjectedInput: () => boolean,
): QualityCheckDefinition<Unit, Translation, QualityObject, JsonValue> {
  const projectedInputSchema: StandardSchemaV1<PreparedInput, PreparedInput> = {
    "~standard": {
      version: 1,
      vendor: "qa-cache-test",
      validate(value) {
        counts.schema += 1;
        if (rejectProjectedInput())
          return { issues: [{ message: "检查投影输入无效。" }] };
        if (
          typeof value !== "object" ||
          value === null ||
          Array.isArray(value) ||
          !("source" in value) ||
          typeof value.source !== "string" ||
          !("target" in value)
        )
          return { issues: [{ message: "检查投影输入结构无效。" }] };
        return {
          value: { source: value.source, target: value.target as JsonValue },
        };
      },
    },
  };
  return bindQualityCheck<
    Unit,
    Translation,
    typeof jsonValueSchema,
    typeof projectedInputSchema,
    { readonly content: JsonValue },
    QualityObject,
    JsonValue
  >({
    id: "message-review",
    version: "review-v1",
    configurationSchema: jsonValueSchema,
    configuration: {},
    inputSchema: projectedInputSchema,
    select({ candidate }) {
      counts.select += 1;
      return { status: "selected", subject: { content: candidate.content } };
    },
    project({ subject }) {
      counts.project += 1;
      return {
        status: "ready",
        value: { source: "Hello", target: subject.content },
      };
    },
    check() {
      counts.check += 1;
      return reviewOutcome();
    },
  });
}

function createTestConfig(
  check: QualityCheckDefinition<Unit, Translation, QualityObject, JsonValue>,
  options: {
    readonly cache?: QualityCheckResultCache;
    readonly exceptionStore?: QualityExceptionStore;
    readonly precedingChecks?: readonly QualityCheckDefinition<
      Unit,
      Translation,
      QualityObject,
      JsonValue
    >[];
  } = {},
) {
  return defineConfig({
    source: {
      schema: sourceSchemaFromExamples(unit),
      read: () => ({
        scopes: [
          {
            range: "source.json",
            enumeration: "complete" as const,
            records: [{ value: unit, bodyAvailability: "available" as const }],
          },
        ],
      }),
    },
    keyOf: () => "message:hello",
    translations: {
      languages: ["fr"],
      identityOf: fixtureTranslationIdentity,
      schema: schemaFromExamples(translation),
      contentSchema: jsonValueSchema,
      contentOf: ({ text }) => text,
      read: (_language, sourceUnits) => ({
        scopes: [
          {
            range: "fr.json",
            covers: sourceUnits.map(({ key }) => key),
            enumeration: "complete" as const,
            records: [
              { value: translation, bodyAvailability: "available" as const },
            ],
          },
        ],
      }),
      matches: () => true,
    },
    qualityChecks: [...(options.precedingChecks ?? []), check],
    ...(options.cache === undefined
      ? {}
      : { qualityCheckResultCache: options.cache }),
    ...(options.exceptionStore === undefined
      ? {}
      : { qualityExceptionStore: options.exceptionStore }),
    createQualityRequest: () => ({ candidates: [candidate], dependencies: {} }),
  });
}

function reviewCheck(
  onCheck: () => void,
  version = "review-v1",
  configuration: JsonValue = {},
  checkId = "message-review",
): QualityCheckDefinition<Unit, Translation, QualityObject, JsonValue> {
  return defineTestQualityCheck<Unit, Translation, JsonValue>({
    id: checkId,
    version,
    configuration,
    check() {
      onCheck();
      return reviewOutcome();
    },
  });
}

function reviewOutcome(): QualityCheckOutcome {
  return {
    status: "complete",
    diagnostics: [
      {
        severity: "error",
        object: {
          kind: "translation-unit",
          key: "message:hello",
          language: "fr",
        },
        location: { language: "fr", range: "fr.json" },
        message: "请复核译文。",
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
}

function outcomeFor(
  status: "complete" | "not-applicable" | "incomplete" | "failed",
): QualityCheckOutcome {
  if (status === "complete") return reviewOutcome();
  return {
    status,
    diagnostics: [],
    issues: [],
    coverage: {
      selected: 1,
      evaluated: 0,
      notApplicable: status === "not-applicable" ? 1 : 0,
      incomplete: status === "incomplete" ? 1 : 0,
      failed: status === "failed" ? 1 : 0,
    },
  };
}
