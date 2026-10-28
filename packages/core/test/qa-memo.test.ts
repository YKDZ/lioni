import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createMemoScope,
  MemoScopeClosedError,
  type MemoScope,
} from "@lioni/memo";

import {
  analyzeQuality,
  defineConfig,
  QualityCheckBindingError,
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
      identityOf: fixtureTranslationIdentity,
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

void test("直接配置检查器并按运行读取资料，筛选不裁剪事实且空选择保持为空", async () => {
  const source = { source: "Save" };
  const translation = { id: "save", text: "保存" };
  let dependencyReads = 0;
  let sourceReads = 0;
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
      identityOf: fixtureTranslationIdentity,
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
      relationships: [
        {
          kind: "translation-family",
          key: "catalog",
          members: [{ key: "save", language: "zh-CN" }],
        },
      ],
      async loadDependencies({ facts, memo }) {
        dependencyReads += 1;
        assert.equal(sourceReads, dependencyReads);
        dependencySourceKeys.push(facts.source.units.map(({ key }) => key));
        await Promise.resolve();
        memo.memo(() => "loaded")();
        return { run: dependencyReads };
      },
    },
  });

  assert.equal(dependencyReads, 0);
  const first = await analyzeQuality(config);
  assert.equal(first.status, "complete");
  assert.equal(dependencyReads, 1);
  assert.deepEqual(first.candidates, [
    { sourceKey: "save", language: "zh-CN", content: "保存" },
  ]);
  assert.deepEqual(first.dependencies, { run: 1 });

  const second = await analyzeQuality(config, {
    candidates: [
      { sourceKey: "external", language: "zh-CN", content: "外部候选 A" },
      { sourceKey: "external", language: "zh-CN", content: "外部候选 B" },
    ],
    selectCandidates: (candidates) => candidates.slice(1),
  });
  assert.equal(dependencyReads, 2);
  assert.deepEqual(second.candidates, [
    { sourceKey: "external", language: "zh-CN", content: "外部候选 B" },
  ]);
  assert.deepEqual(second.dependencies, { run: 2 });
  assert.equal(second.factCoverage.associations[0]?.candidateSelected, false);
  const third = await analyzeQuality(config, {
    selectCandidates: () => [],
  });
  assert.equal(dependencyReads, 3);
  assert.deepEqual(third.candidates, []);
  assert.deepEqual(third.dependencies, { run: 3 });
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
  assert.deepEqual(dependencySourceKeys, [["save"], ["save"], ["save"]]);
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
