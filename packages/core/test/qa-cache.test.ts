import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  runQa,
  createQaSuppression,
  createQualityProfiler,
  defineChecker,
  defineConfig,
  type CachedQualityFindings,
  type JsonValue,
  type QualityCheckDefinition,
  type QualityFinding,
  type QualityCheckResultCache,
  type QaSuppression,
  type QaSuppressionStore,
  type QualityObject,
  type TranslationCandidate,
  type StandardSchemaV1,
  StandardSchemaContractError,
} from "../src/index.ts";
import { createDirectoryQualityCheckResultCache } from "../src/node/index.ts";
import { defineTestChecker } from "./quality-check-fixture.ts";
import {
  jsonValueSchema,
  schemaFromExamples,
  sourceSchemaFromExamples,
  fixtureTranslationKey,
} from "./source-schema.ts";

type Unit = { readonly source: string };
type Translation = { readonly id: string; readonly text: string };

const unit: Unit = { source: "Hello" };
const translation: Translation = { id: "message:hello", text: "Bonjour" };
const candidate: TranslationCandidate<JsonValue> = {
  sourceKey: "message:hello",
  language: "fr",
  content: "Bonjour",
};

function assertCacheOutcomeIsReadOnly(
  outcome: CachedQualityFindings<
    QualityObject & { readonly extension: { values: string[] } }
  >,
) {
  const finding = outcome[0];
  if (finding === undefined) return;
  // @ts-expect-error 缓存与报告共享的检查对象只能只读消费。
  finding.object.extension.values.push("changed");
}
void assertCacheOutcomeIsReadOnly;

void describe("QA 结果缓存", () => {
  void it("缓存命中时仍使用最新豁免并关联本次执行", async () => {
    let checkCount = 0;
    const check = reviewCheck(() => {
      checkCount += 1;
    });
    const cache = createMemoryCache();
    let currentSuppressions: readonly QaSuppression[] = [];
    const suppressionStore: QaSuppressionStore = {
      async load() {
        return currentSuppressions;
      },
      async upsert(suppression) {
        currentSuppressions = [
          ...currentSuppressions.filter(({ id }) => id !== suppression.id),
          suppression,
        ];
      },
    };
    const config = createTestConfig(check, { cache, suppressionStore });

    const first = await runQa(config);
    assert.equal(first.diagnostics[0]?.handling.status, "active");
    const execution = first.checks[0]?.executions[0];
    assert.ok(execution);
    const suppression = createQaSuppression({
      id: "approved-review",
      reason: "原理由",
      execution,
    });

    currentSuppressions = [suppression];
    const shiftedConfig = createTestConfig(check, {
      cache,
      suppressionStore,
      precedingChecks: [
        reviewCheck(() => {}, "prior-review-v1", "strict", "prior-review"),
      ],
    });
    const suppressed = await runQa(shiftedConfig);
    const suppressedDiagnostic = suppressed.diagnostics.find(
      ({ checkId }) => checkId === "message-review",
    );
    assert.equal(suppressedDiagnostic?.executionId, 1);
    assert.deepEqual(suppressedDiagnostic?.handling, {
      status: "suppressed",
      suppressionId: "approved-review",
      reason: "原理由",
    });

    currentSuppressions = [{ ...suppression, reason: "更新后的理由" }];
    const updated = await runQa(shiftedConfig);
    assert.deepEqual(
      updated.diagnostics.find(({ checkId }) => checkId === "message-review")
        ?.handling,
      {
        status: "suppressed",
        suppressionId: "approved-review",
        reason: "更新后的理由",
      },
    );

    currentSuppressions = [];
    const removed = await runQa(shiftedConfig);
    const removedDiagnostic = removed.diagnostics.find(
      ({ checkId }) => checkId === "message-review",
    );
    assert.equal(removedDiagnostic?.executionId, 1);
    assert.deepEqual(removedDiagnostic?.handling, { status: "active" });
    assert.equal(checkCount, 1);
  });

  void it("合法 JSON 缓存内容被改写时重新计算", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "lioni-qa-cache-"));
    try {
      const cacheDirectory = path.join(directory, "quality-results");
      let checkCount = 0;
      const firstConfig = createTestConfig(
        reviewCheck(() => {
          checkCount += 1;
        }),
        { cache: createDirectoryQualityCheckResultCache(cacheDirectory) },
      );

      const first = await runQa(firstConfig);
      assert.deepEqual(
        first.diagnostics.map(({ checkId, message }) => [checkId, message]),
        [["message-review", "请复核译文。"]],
      );
      const independentConfig = createTestConfig(
        reviewCheck(() => {
          checkCount += 1;
        }),
        { cache: createDirectoryQualityCheckResultCache(cacheDirectory) },
      );
      const warm = await runQa(independentConfig);
      assert.deepEqual(warm.diagnostics, first.diagnostics);
      assert.equal(checkCount, 1);

      const [entryName] = await readdir(cacheDirectory);
      assert.ok(entryName);
      const entryPath = path.join(cacheDirectory, entryName);
      const entry = JSON.parse(await readFile(entryPath, "utf8")) as {
        readonly outcome: Record<string, unknown>;
      };
      await writeFile(
        entryPath,
        JSON.stringify({
          ...entry,
          outcome: [],
        }),
        "utf8",
      );

      const second = await runQa(independentConfig);
      assert.deepEqual(
        {
          checkCount,
          diagnostics: second.diagnostics.map(({ checkId, message }) => [
            checkId,
            message,
          ]),
        },
        {
          checkCount: 2,
          diagnostics: [["message-review", "请复核译文。"]],
        },
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  void it("将规则结果隔离一次后让缓存和报告共享只读数据", async () => {
    const rawOutcome = reviewOutcome();
    const rawFinding = rawOutcome[0];
    assert.ok(rawFinding);
    let checkCount = 0;
    const check = defineTestChecker<Unit, Translation, JsonValue>({
      id: "stable-result",
      check() {
        checkCount += 1;
        return rawOutcome;
      },
    });
    const entries = new Map<string, CachedQualityFindings>();
    const cache: QualityCheckResultCache = {
      async get(key) {
        return entries.get(key);
      },
      async set(key, outcome) {
        entries.set(key, outcome);
      },
    };
    const config = createTestConfig(check, { cache });

    const first = await runQa(config);
    const cachedOutcome = entries.values().next().value;
    assert.ok(cachedOutcome);
    const cachedFinding = cachedOutcome[0];
    const reportedFinding = first.checks[0]?.diagnostics[0];
    assert.ok(cachedFinding);
    assert.ok(reportedFinding);
    assert.notStrictEqual(cachedOutcome, rawOutcome);
    assert.notStrictEqual(cachedFinding, rawFinding);
    assert.strictEqual(reportedFinding.object, cachedFinding.object);
    assert.strictEqual(reportedFinding.location, cachedFinding.location);
    assert.strictEqual(reportedFinding.evidence, cachedFinding.evidence);

    Object.assign(rawFinding, { message: "规则来源已在返回后变化。" });
    assert.equal(cachedFinding.message, "请复核译文。");
    assert.equal(reportedFinding.message, "请复核译文。");

    const profiler = createQualityProfiler();
    const second = await runQa(config, { profiler });
    assert.deepEqual(second, first);
    assert.equal(checkCount, 1);
    const warmedFinding = second.checks[0]?.diagnostics[0];
    const reusedCachedOutcome = entries.values().next().value;
    assert.ok(warmedFinding);
    assert.ok(reusedCachedOutcome);
    const reusedCachedFinding = reusedCachedOutcome[0];
    assert.ok(reusedCachedFinding);
    assert.notStrictEqual(warmedFinding.object, reusedCachedFinding.object);
    assert.notStrictEqual(warmedFinding.location, reusedCachedFinding.location);
    assert.notStrictEqual(warmedFinding.evidence, reusedCachedFinding.evidence);
    assert.equal(
      profiler
        .report()
        .checks[0]?.timings.find(({ stage }) => stage === "snapshot")?.calls,
      1,
    );
  });

  void it("普通规则异常保持 failed 且不进入缓存", async () => {
    let checkCount = 0;
    let cacheWrites = 0;
    const cache: QualityCheckResultCache = {
      async get() {
        return undefined;
      },
      async set() {
        cacheWrites += 1;
      },
    };
    const check = defineTestChecker<Unit, Translation, JsonValue>({
      id: "ordinary-error",
      check() {
        checkCount += 1;
        throw new Error("规则运行失败。");
      },
    });
    const config = createTestConfig(check, { cache });

    const first = await runQa(config);
    const second = await runQa(config);

    assert.equal(first.status, "failed");
    assert.equal(second.status, "failed");
    assert.equal(first.checks[0]?.executions[0]?.error, "规则运行失败。");
    assert.equal(checkCount, 2);
    assert.equal(cacheWrites, 0);
  });

  void it("把结构损坏的自定义缓存结果视为未命中", async () => {
    const validOutcome = reviewOutcome();
    const finding = validOutcome[0];
    assert.ok(finding);
    const invalidOutcomes: readonly { name: string; outcome: unknown }[] = [
      {
        name: "诊断缺少必要字段",
        outcome: [{}],
      },
      {
        name: "诊断证据缺少必要字段",
        outcome: [{ ...finding, evidence: [{}] }],
      },
      {
        name: "诊断位置缺少范围",
        outcome: [{ ...finding, location: { language: "fr" } }],
      },
      {
        name: "质量对象语言不是字符串",
        outcome: [{ ...finding, object: { ...finding.object, language: 42 } }],
      },
      {
        name: "旧版结果包装",
        outcome: { diagnostics: [], status: "complete" },
      },
    ];

    for (const scenario of invalidOutcomes) {
      let checkCount = 0;
      const cache: QualityCheckResultCache = {
        async get() {
          return scenario.outcome as CachedQualityFindings;
        },
        async set() {},
      };
      const result = await runQa(
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
      assert.equal(result.checks[0]?.status, "complete", scenario.name);
    }
  });

  void it("缓存命中时仍准备并校验输入，契约错误不会被缓存吞掉", async () => {
    const counts = { prepare: 0, schema: 0, check: 0 };
    let rejectProjectedInput = false;
    let cacheReads = 0;
    const cache = createMemoryCache(() => {
      cacheReads += 1;
    });
    const config = createTestConfig(
      preparedReviewCheck(counts, () => rejectProjectedInput),
      { cache },
    );

    await runQa(config);
    await runQa(config);

    assert.deepEqual(counts, { prepare: 2, schema: 2, check: 1 });
    assert.equal(cacheReads, 2);

    rejectProjectedInput = true;
    await assert.rejects(runQa(config), StandardSchemaContractError);
    assert.deepEqual(counts, { prepare: 3, schema: 3, check: 1 });
    assert.equal(cacheReads, 2);
  });

  void it("候选输入或实现版本变化时重新计算", async () => {
    let checkCount = 0;
    const cache = createMemoryCache();
    const createCheck = (version: string, policy: string) =>
      reviewCheck(
        () => {
          checkCount += 1;
        },
        version,
        policy,
      );
    const originalConfig = createTestConfig(
      createCheck("review-v1", "strict"),
      {
        cache,
      },
    );

    await runQa(originalConfig);
    await runQa(originalConfig);
    assert.equal(checkCount, 1);

    await runQa(originalConfig, {
      candidates: [{ ...candidate, content: "Salut" }],
    });
    assert.equal(checkCount, 2);

    await runQa(
      createTestConfig(createCheck("review-v1", "relaxed"), { cache }),
    );
    assert.equal(checkCount, 3);

    await runQa(
      createTestConfig(createCheck("review-v2", "relaxed"), { cache }),
    );
    assert.equal(checkCount, 4);
  });

  void it("拒绝重复候选身份", async () => {
    let checkCount = 0;
    const cache = createMemoryCache();
    const config = createTestConfig(
      reviewCheck(() => {
        checkCount += 1;
      }),
      { cache },
    );
    const candidates = [candidate, candidate];

    await assert.rejects(runQa(config, { candidates }), /候选身份.*重复/);

    assert.equal(checkCount, 0);
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
    const result = await runQa(
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

  void it("真实缓存目录不可用时完整 QA 仍返回检查结果", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "lioni-qa-cache-"));
    try {
      const blockedParent = path.join(directory, "not-a-directory");
      await writeFile(blockedParent, "file", "utf8");
      let checkCount = 0;
      const result = await runQa(
        createTestConfig(
          reviewCheck(() => {
            checkCount += 1;
          }),
          {
            cache: createDirectoryQualityCheckResultCache(
              path.join(blockedParent, "quality-results"),
            ),
          },
        ),
      );

      assert.equal(result.status, "complete");
      assert.equal(result.diagnostics[0]?.message, "请复核译文。");
      assert.equal(checkCount, 1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  void it("未装配缓存时每次分析都重新执行检查", async () => {
    let checkCount = 0;
    const config = createTestConfig(
      reviewCheck(() => {
        checkCount += 1;
      }),
    );

    await runQa(config);
    await runQa(config);

    assert.equal(checkCount, 2);
  });
});

function createMemoryCache(onRead?: () => void): QualityCheckResultCache {
  const entries = new Map<string, CachedQualityFindings>();
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
type ReviewInput = { readonly content: JsonValue; readonly policy: string };

function preparedReviewCheck(
  counts: { prepare: number; schema: number; check: number },
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
  return defineChecker.withTypes<Unit, Translation, JsonValue>()({
    id: "message-review",
    version: "review-v1",
    inputSchema: projectedInputSchema,
    prepare({ candidate }) {
      counts.prepare += 1;
      return { source: "Hello", target: candidate?.content ?? null };
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
    readonly suppressionStore?: QaSuppressionStore;
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
      keyOf: fixtureTranslationKey,
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
    },
    quality: {
      checks: [...(options.precedingChecks ?? []), check],
      ...(options.cache === undefined ? {} : { resultCache: options.cache }),
      ...(options.suppressionStore === undefined
        ? {}
        : { suppressionStore: options.suppressionStore }),
    },
  });
}

function reviewCheck(
  onCheck: () => void,
  version = "review-v1",
  policy = "strict",
  checkId = "message-review",
): QualityCheckDefinition<Unit, Translation, QualityObject, JsonValue> {
  const inputSchema = schemaFromExamples<ReviewInput>({
    content: "",
    policy: "",
  });
  return defineChecker.withTypes<Unit, Translation, JsonValue>()({
    id: checkId,
    version,
    inputSchema,
    prepare({ candidate }) {
      return { content: candidate?.content ?? null, policy };
    },
    check() {
      onCheck();
      return reviewOutcome();
    },
  });
}

function reviewOutcome(): ReadonlyArray<QualityFinding> {
  return [
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
  ];
}
