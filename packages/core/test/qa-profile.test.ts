import assert from "node:assert/strict";
import { test } from "node:test";

import {
  analyzeQuality,
  createQualityProfiler,
  defineConfig,
  QualityCheckBindingError,
} from "../src/index.ts";

void test("配置验证抛错后仍可读取中断的性能证据，原异常保持一致", async () => {
  const profiler = createQualityProfiler();
  assert.throws(() => profiler.report());
  // 非法配置通过正式入口触发早期验证，不依赖内部计时实现。
  const config = null as unknown as Parameters<typeof analyzeQuality>[0];
  let original: unknown;
  try {
    await analyzeQuality(config);
  } catch (error) {
    original = error;
  }
  await assert.rejects(analyzeQuality(config, { profiler }), {
    name: (original as Error).name,
    message: (original as Error).message,
  });
  const evidence = profiler.report();
  assert.equal(evidence.status, "interrupted");
  assert.ok(Number.isFinite(evidence.totalMs));
  assert.ok(evidence.totalMs >= 0);
  assert.deepEqual(JSON.parse(JSON.stringify(evidence)), evidence);
});

import { createMemoScope, type MemoScope } from "@lioni/memo";

import { defineTestQualityCheck } from "./quality-check-fixture.ts";
import {
  schemaFromExamples,
  sourceSchemaFromExamples,
  fixtureTranslationIdentity,
} from "./source-schema.ts";

const complete = () => ({
  status: "complete" as const,
  diagnostics: [],
  issues: [],
  coverage: {
    selected: 1,
    evaluated: 1,
    notApplicable: 0,
    incomplete: 0,
    failed: 0,
  },
});

function configFor(compute: (memo: MemoScope) => void) {
  const source = { source: "Save" };
  const translation = { id: "save", text: "保存" };
  return defineConfig({
    source: {
      schema: sourceSchemaFromExamples(source),
      read: () => ({
        scopes: [
          {
            range: "en.json",
            enumeration: "complete",
            records: [{ value: source, bodyAvailability: "available" }],
          },
        ],
      }),
    },
    keyOf: () => "save",
    translations: {
      languages: ["zh-CN"],
      keyOf: fixtureTranslationIdentity,
      schema: schemaFromExamples(translation),
      contentSchema: schemaFromExamples(""),
      contentOf: ({ text }) => text,
      read: () => ({
        scopes: [
          {
            range: "zh-CN.json",
            enumeration: "complete",
            covers: ["save"],
            records: [{ value: translation, bodyAvailability: "available" }],
          },
        ],
      }),
      matches: () => true,
    },
    quality: {
      checks: ["first", "second"].map((id) =>
        defineTestQualityCheck<typeof source, typeof translation, string>({
          id,
          configuration: {},
          check: ({ memo }) => {
            compute(memo);
            return complete();
          },
        }),
      ),
    },
  });
}

void test("完整运行只输出结构化证据，缓存命中仍记录准备且不重复执行规则", async () => {
  let calls = 0;
  const base = configFor(() => {
    calls++;
  });
  const entries = new Map();
  const config = {
    ...base,
    quality: {
      ...base.quality,
      resultCache: {
        get: async (key: string) => entries.get(key),
        set: async (key: string, value: unknown) => {
          entries.set(key, value);
        },
      },
    },
  };
  const cold = createQualityProfiler();
  const first = await analyzeQuality(config, { profiler: cold });
  assert.equal(cold.report().status, "completed");
  assert.equal(calls, 2);
  const warm = createQualityProfiler({ slowestCandidates: 0 });
  const second = await analyzeQuality(config, { profiler: warm });
  assert.deepEqual(second, first);
  assert.equal(calls, 2);
  const evidence = warm.report();
  assert.equal(evidence.checks.length, 2);
  for (const check of evidence.checks) {
    assert.equal(check.candidateCount, 1);
    assert.equal(check.executedRules, 0);
    assert.equal(check.cache.reads.hit, 1);
    assert.deepEqual(check.slowestCandidates, []);
    assert.ok(
      check.timings.some(
        (timing) => timing.stage === "prepareInput" && timing.calls === 1,
      ),
    );
  }
  await assert.rejects(analyzeQuality(config, { profiler: cold }), TypeError);
  assert.equal(calls, 2);
});

void test("普通规则失败完成采集，契约异常保留未完成候选和原异常", async () => {
  const ordinary = new Error("规则失败");
  const profiler = createQualityProfiler();
  const failed = await analyzeQuality(
    configFor(() => {
      throw ordinary;
    }),
    { profiler },
  );
  assert.equal(failed.status, "failed");
  assert.equal(profiler.report().status, "completed");
  assert.equal(
    profiler.report().checks[0]?.slowestCandidates[0]?.status,
    "failed",
  );
  const reason = new QualityCheckBindingError("first", "projection", ordinary);
  const interrupted = createQualityProfiler();
  await assert.rejects(
    analyzeQuality(
      configFor(() => {
        throw reason;
      }),
      { profiler: interrupted },
    ),
    (error) => error === reason,
  );
  const evidence = interrupted.report();
  assert.equal(evidence.status, "interrupted");
  assert.equal(evidence.checks[0]?.slowestCandidates[0]?.completed, false);
  assert.equal(evidence.checks[0]?.executedRules, 1);
  assert.equal(evidence.checks[1]?.candidateCount, 0);
});

void test("每项检查以候选总成本保留慢项，重复键不会合并且只保存定位证据", async (context) => {
  let clock = 0;
  context.mock.method(performance, "now", () => clock);
  let ordinal = 0;
  const config = configFor(() => {
    clock += ++ordinal * 10;
  });
  const profiler = createQualityProfiler({ slowestCandidates: 2 });
  const candidates = Array.from({ length: 4 }, () => ({
    sourceKey: "save",
    language: "zh-CN",
    content: "正文不应进入性能证据",
  }));
  await analyzeQuality(config, { candidates, profiler });
  const evidence = profiler.report();
  for (const check of evidence.checks) {
    assert.equal(check.candidateCount, 4);
    assert.equal(check.executedRules, 4);
    assert.deepEqual(
      check.slowestCandidates.map((item) => item.candidateIndex),
      [3, 2],
    );
    assert.ok(
      check.slowestCandidates[0]!.durationMs >=
        check.slowestCandidates[1]!.durationMs,
    );
  }
  assert.equal(
    JSON.stringify(evidence).includes("正文不应进入性能证据"),
    false,
  );
  assert.ok(evidence.stages.some((stage) => stage.stage === "cleanup"));
  assert.ok(
    evidence.totalMs >=
      evidence.checks.reduce((sum, check) => sum + check.durationMs, 0),
  );
});

void test("缓存读写按接口结果计数，隐藏的存储失败不能被推断", async () => {
  for (const mode of ["miss", "invalid", "error"] as const) {
    const base = configFor(() => {});
    const config = {
      ...base,
      quality: {
        ...base.quality,
        resultCache: {
          async get() {
            if (mode === "error") throw new Error("读取失败");
            return mode === "miss" ? undefined : ({} as never);
          },
          async set() {
            throw new Error("写入失败");
          },
        },
      },
    };
    const profiler = createQualityProfiler();
    await analyzeQuality(config, { profiler });
    for (const check of profiler.report().checks) {
      assert.equal(check.cache.reads[mode], 1);
      assert.equal(check.cache.writes.error, 1);
      assert.equal(check.executedRules, 1);
    }
  }
});

void test("空选择不伪造缓存查询和候选执行，借用 memo 仍归宿主管理", async () => {
  const memo = createMemoScope();
  const profiler = createQualityProfiler();
  await analyzeQuality(
    configFor(() => {}),
    { candidates: [], profiler, memo },
  );
  for (const check of profiler.report().checks) {
    assert.equal(check.candidateCount, 0);
    assert.equal(check.executedRules, 0);
    assert.equal(check.cache.reads.miss, 0);
    assert.deepEqual(check.slowestCandidates, []);
  }
  assert.equal(memo.memo(() => 42)(), 42);
  memo.dispose();
  for (const limit of [-1, 0.5, Infinity, NaN])
    assert.throws(
      () => createQualityProfiler({ slowestCandidates: limit }),
      TypeError,
    );
});
