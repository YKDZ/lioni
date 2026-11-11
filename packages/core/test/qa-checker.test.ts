import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  analyzeQuality,
  defineChecker,
  defineConfig,
  StandardSchemaContractError,
  type CacheableQualityCheckOutcome,
  type QualityCheckOutcome,
  type QualityCheckResultCache,
  type QualityCheckDefinition,
  type StandardSchemaV1,
  type TranslationUnitInput,
} from "../src/index.ts";
import {
  schemaFromExamples,
  sourceSchemaFromExamples,
} from "./source-schema.ts";

const sourceUnits = [
  { source: "原文 A", key: "a" },
  { source: "原文 B", key: "b" },
  { source: "原文 C", key: "c" },
];
const translation = { key: "a", text: "已保存 A" };
const relationship = {
  kind: "family",
  key: "a-b",
  members: [
    { key: "a", language: "fr" },
    { key: "b", language: "fr" },
  ],
};

function config(
  checks: readonly QualityCheckDefinition<TranslationUnitInput, unknown>[],
  resultCache?: QualityCheckResultCache,
) {
  return defineConfig({
    source: {
      schema: sourceSchemaFromExamples({ source: "", key: "" }),
      read: () => ({
        scopes: [
          {
            range: "source",
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
      languages: ["fr"],
      schema: schemaFromExamples(translation),
      contentSchema: schemaFromExamples(""),
      keyOf: ({ key }) => key,
      contentOf: ({ text }) => text,
      read: () => ({
        scopes: [
          {
            range: "translated",
            covers: ["a", "b"],
            enumeration: "complete",
            records: [{ bodyAvailability: "available", value: translation }],
          },
        ],
      }),
    },
    quality: {
      checks,
      relationships: [relationship],
      ...(resultCache === undefined ? {} : { resultCache }),
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

void describe("三阶段自定义检查", () => {
  void it("逐候选交接原始事实、固定关联及完整证据", async () => {
    const visits: unknown[][] = [];
    const checker = defineChecker({
      id: "custom",
      version: "1",
      inputSchema: schemaFromExamples(""),
      async prepare(context) {
        const { candidate, sourceUnit, translation, association, loaded } =
          context;
        assert.equal(loaded, undefined);
        assert.deepEqual(
          context.candidates.map(({ sourceKey }) => sourceKey),
          ["a", "b", "c"],
        );
        assert.deepEqual(context.relationships, [relationship]);
        assert.equal(context.facts.source.units.length, 3);
        visits.push([
          candidate.content,
          sourceUnit.unit.source,
          translation?.translation ?? null,
          association.status,
        ]);
        return { status: "ready", input: candidate.sourceKey };
      },
      check: () => complete,
    });
    const result = await analyzeQuality(config([checker]), {
      candidates: [
        { sourceKey: "a", language: "fr", content: "编辑 A" },
        { sourceKey: "b", language: "fr", content: "新增 B" },
        { sourceKey: "c", language: "fr", content: "新增 C" },
      ],
    });
    assert.equal(result.checks[0]?.coverage.evaluated, 3);
    assert.deepEqual(visits, [
      ["编辑 A", "原文 A", translation, "matched"],
      ["新增 B", "原文 B", null, "missing"],
      ["新增 C", "原文 C", null, "unknown"],
    ]);
  });

  void it("只加载有候选的已选检查，同次共享读取且下次刷新", async () => {
    let reads = 0;
    const readPolicy = () => ({ value: ++reads });
    const loads: string[] = [];
    const evaluated: number[] = [];
    const checks = ["first", "second", "excluded"].map((id) =>
      defineChecker({
        id,
        version: "1",
        inputSchema: schemaFromExamples(0),
        async load({ candidates, facts, relationships, qualityData }) {
          assert.equal(candidates.length, 2);
          assert.equal(facts.source.units.length, 3);
          assert.deepEqual(relationships, [relationship]);
          loads.push(id);
          const { value } = await qualityData.read(readPolicy);
          const index: ReadonlyMap<string, number> = new Map([
            ["a", value],
            ["b", value * 10],
          ]);
          return {
            marker: "runtime-only-checker-context",
            lookup: (key: string) => index.get(key) ?? 0,
          };
        },
        prepare({ candidate, loaded }) {
          return {
            status: "ready",
            input: loaded.lookup(candidate.sourceKey),
          };
        },
        check(input) {
          evaluated.push(input);
          return complete;
        },
      }),
    );
    const qa = config(checks);
    await analyzeQuality(qa, { candidates: [] });
    assert.equal(reads, 0);

    const candidates = [
      { sourceKey: "a", language: "fr", content: "编辑 A" },
      { sourceKey: "b", language: "fr", content: "新增 B" },
    ];
    const options = { candidates, checkIds: ["first", "second"] };
    const first = await analyzeQuality(qa, options);
    assert.deepEqual(loads, ["first", "second"]);
    assert.deepEqual(evaluated, [1, 10, 1, 10]);
    assert.equal(reads, 1);
    const roundTrip = JSON.parse(JSON.stringify(first)) as typeof first;
    assert.deepEqual(roundTrip, first);
    assert.equal(
      JSON.stringify(first).includes("runtime-only-checker-context"),
      false,
    );

    await analyzeQuality(qa, options);
    assert.deepEqual(loads, ["first", "second", "first", "second"]);
    assert.deepEqual(evaluated, [1, 10, 1, 10, 2, 20, 2, 20]);
    assert.equal(reads, 2);
  });

  void it("加载失败覆盖整项，准备和计算失败仅覆盖当前候选", async () => {
    let reads = 0;
    const unavailable = () => {
      reads += 1;
      throw new Error("检查资料不可用");
    };
    const loading = ["load-first", "load-second"].map((id) =>
      defineChecker({
        id,
        version: "1",
        inputSchema: schemaFromExamples(""),
        load: ({ qualityData }) => qualityData.read(unavailable),
        prepare: () => assert.fail("加载失败后不得准备候选"),
        check: () => assert.fail("加载失败后不得执行检查"),
      }),
    );
    const local = defineChecker({
      id: "local",
      version: "1",
      inputSchema: schemaFromExamples(""),
      prepare({ candidate }) {
        if (candidate.sourceKey === "a") throw new TypeError("准备失败");
        return { status: "ready", input: candidate.sourceKey };
      },
      check(key) {
        if (key === "b") throw new Error("计算失败");
        return complete;
      },
    });
    const coverage = defineChecker({
      id: "coverage",
      version: "1",
      inputSchema: schemaFromExamples(""),
      prepare({ candidate }) {
        if (candidate.sourceKey === "a") return { status: "not-applicable" };
        if (candidate.sourceKey === "b")
          return {
            status: "incomplete",
            issue: { code: "noEvidence", message: "缺少依据" },
          };
        return { status: "ready", input: candidate.sourceKey };
      },
      check(key) {
        assert.equal(key, "c");
        return complete;
      },
    });
    const result = await analyzeQuality(config([...loading, local, coverage]), {
      candidates: ["a", "b", "c"].map((sourceKey) => ({
        sourceKey,
        language: "fr",
        content: "编辑",
      })),
    });
    assert.equal(reads, 1);
    assert.equal(result.status, "failed");
    assert.deepEqual(
      result.checks.map(({ executions }) =>
        executions.map(({ status }) => status),
      ),
      [
        ["failed", "failed", "failed"],
        ["failed", "failed", "failed"],
        ["failed", "failed", "complete"],
        ["not-applicable", "incomplete", "complete"],
      ],
    );
    assert.deepEqual(
      result.checks[2]?.issues.map(({ message }) => message),
      ["准备失败", "计算失败"],
    );
    assert.deepEqual(result.checks[3]?.issues, [
      { code: "noEvidence", message: "缺少依据" },
    ]);
  });

  void it("准备或规则返回无效结构时中止检查", async () => {
    const badPreparation = defineChecker({
      id: "invalid-prepare",
      version: "1",
      inputSchema: schemaFromExamples(""),
      prepare: () => ({ status: "ready" }) as never,
      check: () => complete,
    });
    await assert.rejects(analyzeQuality(config([badPreparation])), {
      name: "QualityCheckerContractError",
      stage: "prepare",
    });

    const badOutcome = defineChecker({
      id: "invalid-outcome",
      version: "1",
      inputSchema: schemaFromExamples(""),
      prepare: () => ({ status: "ready", input: "a" }),
      check: () => ({
        ...complete,
        coverage: { ...complete.coverage, evaluated: -1 },
      }),
    });
    await assert.rejects(analyzeQuality(config([badOutcome])), {
      name: "QualityCheckerContractError",
      stage: "check",
    });
  });

  void it("缓存查询与规则使用已固定的同一输入，候选筛选后可复用结果", async () => {
    let original: { payload: { key: string } } | undefined;
    const checked: string[] = [];
    const entries = new Map<string, CacheableQualityCheckOutcome>();
    const cache: QualityCheckResultCache = {
      async get(key) {
        assert.ok(original);
        original.payload.key = "缓存查询期间修改";
        return entries.get(key);
      },
      async set(key, outcome) {
        entries.set(key, outcome);
      },
    };
    const checker = defineChecker({
      id: "fixed-input",
      version: "1",
      inputSchema: schemaFromExamples({ payload: { key: "" } }),
      prepare({ candidate }) {
        original = { payload: { key: candidate.sourceKey } };
        return { status: "ready", input: original };
      },
      check(input) {
        assert.equal(Reflect.set(input.payload, "key", "规则修改"), false);
        checked.push(input.payload.key);
        return complete;
      },
    });
    const qa = config([checker], cache);
    const a = { sourceKey: "a", language: "fr", content: "编辑 A" };
    const b = { sourceKey: "b", language: "fr", content: "新增 B" };
    const first = await analyzeQuality(qa, { candidates: [a, b] });
    const filtered = await analyzeQuality(qa, { candidates: [b] });
    assert.deepEqual(checked, ["a", "b"]);
    const firstB = first.checks[0]?.executions[1];
    const filteredB = filtered.checks[0]?.executions[0];
    assert.ok(firstB?.inputFingerprint);
    assert.equal(filteredB?.inputFingerprint, firstB.inputFingerprint);
    assert.equal(filteredB?.status, "complete");
  });

  void it("拒绝改值、删字段、原地修改及非 JSON 输入", async () => {
    type Input = { text: string; detail: string };
    const scenarios = [
      {
        kind: "output-changed",
        validate: (value: Input) => ({ ...value, text: "改值" }),
      },
      {
        kind: "output-changed",
        validate: (value: Input) => ({ text: value.text }) as Input,
      },
      {
        kind: "input-mutated",
        validate: (value: Input) => {
          value.text = "原地修改";
          return value;
        },
      },
      {
        kind: "invalid-json",
        validate: (value: Input) => value,
        input: new Map() as unknown as Input,
      },
    ];
    for (const { kind, validate, input } of scenarios) {
      const inputSchema: StandardSchemaV1<Input> = {
        "~standard": {
          version: 1,
          vendor: "lioni-test",
          validate: (value) => ({ value: validate(value as Input) }),
        },
      };
      const checker = defineChecker({
        id: "preserving-schema",
        version: "1",
        inputSchema,
        prepare: () => ({
          status: "ready",
          input: input ?? { text: "正文", detail: "细节" },
        }),
        check: () => assert.fail("输入校验失败后不得执行规则"),
      });
      await assert.rejects(analyzeQuality(config([checker])), (error) => {
        assert.ok(error instanceof StandardSchemaContractError);
        assert.equal(error.kind, kind);
        return true;
      });
    }
  });
});
