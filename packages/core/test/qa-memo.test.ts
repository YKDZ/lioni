import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createMemoScope,
  MemoScopeClosedError,
  type MemoScope,
} from "@lioni/memo";

import {
  analyzeQuality,
  createQualityProfiler,
  defineConfig,
  QualityCheckBindingError,
  QualityDataReaderContractError,
  StandardSchemaContractError,
  type QualityDataReader,
  type SemanticEditCandidate,
} from "../src/index.ts";
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

void test("配置不执行计算，同次 QA 共享范围，运行结束关闭且下一次重新计算", async () => {
  let calls = 0;
  const observed: MemoScope[] = [];
  const operation = (text: string) => ({ text, ordinal: ++calls });
  const config = configFor((memo) => {
    observed.push(memo);
    memo.memo(operation)("Save");
  });
  assert.equal(calls, 0);
  const first = await analyzeQuality(config);
  assert.equal(first.status, "complete");
  assert.equal(calls, 1);
  assert.equal(observed[0], observed[1]);
  assert.throws(() => observed[0]!.memo(operation), MemoScopeClosedError);
  await analyzeQuality(config);
  assert.equal(calls, 2);
  assert.notEqual(observed[0], observed[2]);
  assert.equal(JSON.stringify(first).includes('"memo"'), false);
  await analyzeQuality(config, { candidates: [] });
  assert.equal(calls, 2);
});

void test("同次检查资料可显式共享，借入长期 memo 也会在下次运行刷新", async () => {
  let reads = 0;
  const observed: unknown[] = [];
  const memo = createMemoScope();
  const loadPolicy = () => ({ revision: ++reads });
  let candidateBuilds = 0;
  const base = configFor(() => {});
  const checks = ["first", "second"].map((id) =>
    defineTestQualityCheck({
      id,
      configuration: {},
      loadDependencies: ({ qualityData }: { qualityData: QualityDataReader }) =>
        qualityData.read(loadPolicy),
      check(input) {
        observed.push(input.dependencies);
        return complete();
      },
    }),
  );
  const config = {
    ...base,
    quality: {
      checks,
      async buildCandidates({
        defaultCandidates,
        qualityData,
      }: {
        readonly defaultCandidates: readonly SemanticEditCandidate<string>[];
        readonly qualityData: QualityDataReader;
      }) {
        candidateBuilds += 1;
        await qualityData.read(loadPolicy);
        return defaultCandidates;
      },
    },
  };

  try {
    await analyzeQuality(config, { memo });
    assert.equal(reads, 1);
    assert.equal(candidateBuilds, 1);
    assert.deepEqual(observed, [{ revision: 1 }, { revision: 1 }]);

    await analyzeQuality(config, { memo });
    assert.equal(reads, 2);
    assert.equal(candidateBuilds, 2);
    assert.deepEqual(observed, [
      { revision: 1 },
      { revision: 1 },
      { revision: 2 },
      { revision: 2 },
    ]);
  } finally {
    memo.dispose();
  }
});

void test("共享读取资料可嵌入各项输入并复用同一项纯计算", async () => {
  type SharedTerms = {
    readonly revision: number;
    readonly entries: readonly { readonly text: string }[];
  };
  let reads = 0;
  let compiles = 0;
  const originals: SharedTerms[] = [];
  const compiledInputs: SharedTerms[] = [];
  const checkerInputs: SharedTerms[] = [];
  const checkerDependencies: {
    readonly language: string;
    readonly terms: SharedTerms;
  }[] = [];
  const loadTerms = () => {
    const terms = { revision: ++reads, entries: [{ text: "Save" }] };
    originals.push(terms);
    return terms;
  };
  const compile = (terms: SharedTerms) => {
    compiles += 1;
    compiledInputs.push(terms);
    return {};
  };
  const base = configFor(() => {});
  const checks = ["first", "second"].map((id) =>
    defineTestQualityCheck({
      id,
      configuration: {},
      loadDependencies: async ({ qualityData }) => ({
        language: "zh-CN",
        terms: await qualityData.read(loadTerms),
      }),
      check({ dependencies, memo }) {
        const preparedDependencies = dependencies as {
          readonly language: string;
          readonly terms: SharedTerms;
        };
        const terms = preparedDependencies.terms;
        checkerDependencies.push(preparedDependencies);
        checkerInputs.push(terms);
        memo.memo(compile)(terms);
        return complete();
      },
    }),
  );
  const config = {
    ...base,
    quality: {
      checks,
      async buildCandidates({
        defaultCandidates,
        memo,
        qualityData,
      }: {
        readonly defaultCandidates: readonly SemanticEditCandidate<string>[];
        readonly memo: MemoScope;
        readonly qualityData: QualityDataReader;
      }) {
        const terms = await qualityData.read(loadTerms);
        memo.memo(compile)(terms);
        return defaultCandidates;
      },
    },
  };

  await analyzeQuality(config);

  assert.equal(reads, 1);
  assert.equal(compiles, 1);
  const fixedTerms = compiledInputs[0];
  assert.ok(fixedTerms);
  assert.notStrictEqual(fixedTerms, originals[0]);
  assert.notStrictEqual(fixedTerms.entries, originals[0]?.entries);
  assert.notStrictEqual(fixedTerms.entries[0], originals[0]?.entries[0]);
  assert.strictEqual(fixedTerms, checkerInputs[0]);
  assert.strictEqual(fixedTerms, checkerInputs[1]);
  assert.equal(checkerDependencies[0]?.language, "zh-CN");
  assert.notStrictEqual(checkerDependencies[0], checkerDependencies[1]);
  assert.strictEqual(
    checkerDependencies[0]?.terms,
    checkerDependencies[1]?.terms,
  );
  assert.ok(Object.isFrozen(fixedTerms));
  assert.ok(Object.isFrozen(fixedTerms.entries));
  assert.ok(Object.isFrozen(fixedTerms.entries[0]));

  await analyzeQuality(config);

  const refreshedTerms = compiledInputs[1];
  assert.equal(reads, 2);
  assert.equal(compiles, 2);
  assert.ok(refreshedTerms);
  assert.notStrictEqual(refreshedTerms, fixedTerms);
  assert.strictEqual(refreshedTerms, checkerInputs[2]);
  assert.strictEqual(refreshedTerms, checkerInputs[3]);
});

void test("默认指纹只纳入当前检查项的动态资料", async () => {
  let revision = 1;
  const base = configFor(() => {});
  const checks = [
    defineTestQualityCheck({
      id: "stable-input",
      configuration: {},
      check: complete,
    }),
    defineTestQualityCheck({
      id: "changing-input",
      configuration: {},
      loadDependencies: () => ({ revision }),
      check: complete,
    }),
  ];
  const config = { ...base, quality: { checks } };

  const first = await analyzeQuality(config);
  revision += 1;
  const second = await analyzeQuality(config);

  assert.equal(
    first.checks[0]?.executions[0]?.inputFingerprint,
    second.checks[0]?.executions[0]?.inputFingerprint,
  );
  assert.notEqual(
    first.checks[1]?.executions[0]?.inputFingerprint,
    second.checks[1]?.executions[0]?.inputFingerprint,
  );
});

void test("共享资料失败只读取一次并隔离到相关检查，独立检查仍执行", async () => {
  const base = configFor(() => {});
  const sharedFailure = new TypeError("共享策略不可用");
  let reads = 0;
  let independentRuns = 0;
  const loadShared = (_key: string) => {
    reads += 1;
    throw sharedFailure;
  };
  const config = {
    ...base,
    quality: {
      checks: [
        ...["first", "second"].map((id) =>
          defineTestQualityCheck({
            id,
            configuration: {},
            loadDependencies: ({ qualityData }) =>
              qualityData.read(loadShared, "policy"),
            check() {
              throw new Error("资料失败后不得执行规则");
            },
          }),
        ),
        defineTestQualityCheck({
          id: "ordinary-type-error",
          configuration: {},
          loadDependencies() {
            throw new TypeError("普通宿主读取失败");
          },
          check() {
            throw new Error("读取失败后不得执行规则");
          },
        }),
        defineTestQualityCheck({
          id: "independent",
          configuration: {},
          loadDependencies: () => ({ available: true }),
          check() {
            independentRuns += 1;
            return complete();
          },
        }),
      ],
    },
  };
  const profiler = createQualityProfiler();

  const result = await analyzeQuality(config, { profiler });

  assert.equal(reads, 1);
  assert.equal(independentRuns, 1);
  assert.equal(result.status, "failed");
  assert.deepEqual(
    result.checks.map(({ checkId, status }) => [checkId, status]),
    [
      ["first", "failed"],
      ["second", "failed"],
      ["ordinary-type-error", "failed"],
      ["independent", "complete"],
    ],
  );
  assert.equal(result.checks[0]?.issues[0]?.message, sharedFailure.message);
  assert.equal(Object.hasOwn(result.checks[0] ?? {}, "dependencies"), false);
  assert.deepEqual(result.checks[3]?.dependencies, { available: true });
  const profile = profiler.report();
  for (const check of profile.checks.slice(0, 3)) {
    assert.equal(
      check.timings.find(({ stage }) => stage === "dependencies")?.calls,
      1,
    );
  }
});

void test("无效读取函数作为读取器契约错误中止 QA", async () => {
  const base = configFor(() => {});
  let checkRuns = 0;
  const badCheck = defineTestQualityCheck({
    id: "invalid-reader",
    configuration: {},
    loadDependencies: ({ qualityData }) => qualityData.read(undefined as never),
    check() {
      checkRuns += 1;
      return complete();
    },
  });
  const config = { ...base, quality: { checks: [badCheck] } };

  await assert.rejects(analyzeQuality(config), (error: unknown) => {
    assert.ok(error instanceof QualityDataReaderContractError);
    assert.ok(error instanceof TypeError);
    assert.equal(error.name, "QualityDataReaderContractError");
    assert.equal(error.message, "qualityData.read 的读取函数必须是函数。");
    return true;
  });
  assert.equal(checkRuns, 0);
});

void test("共享资料嵌入 loader 自有非 JSON 值时仍按契约错误中止", async () => {
  const base = configFor(() => {});
  const loadTerms = () => ({ entries: [{ text: "Save" }] });
  const check = defineTestQualityCheck({
    id: "invalid-shared-output",
    configuration: {},
    loadDependencies: async ({ qualityData }) => ({
      terms: await qualityData.read(loadTerms),
      unsupported: new Map(),
    }),
    check: complete,
  });
  const config = { ...base, quality: { checks: [check] } };

  await assert.rejects(analyzeQuality(config), (error: unknown) => {
    assert.ok(error instanceof StandardSchemaContractError);
    assert.equal(error.kind, "invalid-json");
    assert.equal(
      error.valueDescription,
      "QA 检查项 invalid-shared-output 的检查资料.unsupported",
    );
    return true;
  });
});

void test("直接配置检查器并按运行读取资料，筛选不裁剪事实且空选择保持为空", async () => {
  const source = { source: "Save" };
  const translation = { id: "save", text: "保存" };
  let dependencyReads = 0;
  let sourceReads = 0;
  let candidateBuilds = 0;
  const observed: unknown[] = [];
  const observedContexts: unknown[] = [];
  const dependencySourceKeys: string[][] = [];
  const checker = defineTestQualityCheck<
    typeof source,
    typeof translation,
    string
  >({
    id: "candidate-observer",
    configuration: {},
    async loadDependencies({ facts, memo }) {
      dependencyReads += 1;
      assert.equal(sourceReads, dependencyReads);
      dependencySourceKeys.push(facts.source.units.map(({ key }) => key));
      await Promise.resolve();
      memo.memo(() => "loaded")();
      return { run: dependencyReads };
    },
    check: ({ candidate, facts, relationships }) => {
      observed.push(candidate.content);
      observedContexts.push({
        translationRecords: facts.translations.records.map(
          ({ content }) => content,
        ),
        relationships,
      });
      return complete();
    },
  });
  const config = defineConfig({
    source: {
      schema: sourceSchemaFromExamples(source),
      read: () => {
        sourceReads += 1;
        return {
          scopes: [
            {
              range: "en.json",
              enumeration: "complete",
              records: [
                { value: source, bodyAvailability: "available" as const },
              ],
            },
          ],
        };
      },
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
            records: [
              { value: translation, bodyAvailability: "available" as const },
            ],
          },
        ],
      }),
      matches: () => true,
    },
    quality: {
      checks: [checker],
      buildCandidates({ defaultCandidates }) {
        candidateBuilds += 1;
        return defaultCandidates;
      },
      relationships: [
        {
          kind: "translation-family",
          key: "catalog",
          members: [{ key: "save", language: "zh-CN" }],
        },
      ],
    },
  });

  assert.equal(dependencyReads, 0);
  const first = await analyzeQuality(config);
  assert.equal(first.status, "complete");
  assert.equal(dependencyReads, 1);
  assert.equal(candidateBuilds, 1);
  assert.deepEqual(first.candidates, [
    { sourceKey: "save", language: "zh-CN", content: "保存" },
  ]);
  assert.deepEqual(first.checks[0]?.dependencies, { run: 1 });

  const second = await analyzeQuality(config, {
    candidates: [
      { sourceKey: "external", language: "zh-CN", content: "外部候选 A" },
      { sourceKey: "external", language: "zh-CN", content: "外部候选 B" },
    ],
    selectCandidates: (candidates) => candidates.slice(1),
  });
  assert.equal(dependencyReads, 2);
  assert.equal(candidateBuilds, 1);
  assert.deepEqual(second.candidates, [
    { sourceKey: "external", language: "zh-CN", content: "外部候选 B" },
  ]);
  assert.deepEqual(second.checks[0]?.dependencies, { run: 2 });
  assert.equal(second.factCoverage.associations[0]?.candidateSelected, false);
  const third = await analyzeQuality(config, {
    selectCandidates: () => [],
  });
  assert.equal(dependencyReads, 2);
  assert.equal(candidateBuilds, 2);
  assert.deepEqual(third.candidates, []);
  assert.equal(third.status, "not-run");
  assert.equal(third.checks[0]?.status, "not-run");
  assert.deepEqual(observed, ["保存", "外部候选 B"]);
  assert.deepEqual(observedContexts, [
    {
      translationRecords: ["保存"],
      relationships: [
        {
          kind: "translation-family",
          key: "catalog",
          members: [{ key: "save", language: "zh-CN" }],
        },
      ],
    },
    {
      translationRecords: ["保存"],
      relationships: [
        {
          kind: "translation-family",
          key: "catalog",
          members: [{ key: "save", language: "zh-CN" }],
        },
      ],
    },
  ]);
  assert.equal(second.factCoverage.translations.length, 1);
  assert.deepEqual(dependencySourceKeys, [["save"], ["save"]]);
  assert.equal(third.factCoverage.associations[0]?.candidateSelected, false);
});

void test("调用方范围可以跨运行复用，core 不取得关闭权", async () => {
  const memo = createMemoScope();
  let calls = 0;
  const operation = () => ++calls;
  const config = configFor((borrowed) => {
    assert.equal(borrowed, memo);
    borrowed.memo(operation)();
  });
  await analyzeQuality(config, { memo });
  await analyzeQuality(config, { memo });
  assert.equal(memo.memo(operation)(), 1);
  assert.equal(calls, 1);
  memo.dispose();
});

void test("显式候选沿用正式 QA 共享范围并在返回后关闭自有范围", async () => {
  let calls = 0;
  const observed: MemoScope[] = [];
  const operation = (text: string) => ({ text, ordinal: ++calls });
  const config = configFor((memo) => {
    observed.push(memo);
    memo.memo(operation)("Save");
  });
  const candidate = {
    sourceKey: "save",
    language: "zh-CN",
    content: "保存",
  };

  const result = await analyzeQuality(config, { candidates: [candidate] });

  assert.equal(result.status, "complete");
  assert.equal(calls, 1);
  assert.equal(observed[0], observed[1]);
  assert.throws(() => observed[0]!.memo(operation), MemoScopeClosedError);
});

void test("检查失败和绑定异常均释放自有范围，借用范围仍归宿主管理", async () => {
  for (const reason of [
    new Error("分析失败"),
    new QualityCheckBindingError("first", "projection", new Error("投影失败")),
  ]) {
    let observed: MemoScope | undefined;
    const config = configFor((memo) => {
      observed = memo;
      throw reason;
    });
    if (reason instanceof QualityCheckBindingError)
      await assert.rejects(analyzeQuality(config), (error) => error === reason);
    else assert.equal((await analyzeQuality(config)).status, "failed");
    assert.ok(observed);
    assert.throws(() => observed!.memo(() => 1), MemoScopeClosedError);
  }
  const memo = createMemoScope();
  const reason = new QualityCheckBindingError(
    "first",
    "projection",
    new Error("投影失败"),
  );
  await assert.rejects(
    analyzeQuality(
      configFor(() => {
        throw reason;
      }),
      { memo },
    ),
    (error) => error === reason,
  );
  assert.equal(memo.memo(() => 1)(), 1);
  memo.dispose();
});
