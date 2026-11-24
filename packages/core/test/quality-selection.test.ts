import assert from "node:assert/strict";
import { test } from "node:test";

import {
  runQa,
  defineChecker,
  defineConfig,
  formatQualityReport,
  type JsonValue,
} from "../src/index.ts";
import { defineTestChecker } from "./quality-check-fixture.ts";
import {
  jsonValueSchema,
  schemaFromExamples,
  sourceSchemaFromExamples,
  fixtureTranslationKey,
} from "./source-schema.ts";

type Unit = { readonly id: string; readonly source: string };
type Translation = { readonly id: string; readonly text: string };

void test("按分组并集去重并保持配置顺序执行，未归组项不运行", async () => {
  const source = { id: "save", source: "Save" };
  const translation = { id: "save", text: "保存" };
  const executed: string[] = [];
  const loaded: string[] = [];
  const checker = (id: string) =>
    defineChecker.withTypes<Unit, Translation, JsonValue>()({
      id,
      version: "selection-v1",
      inputSchema: schemaFromExamples(null),
      load() {
        loaded.push(id);
        return {};
      },
      prepare: () => null,
      check: () => {
        executed.push(id);
        return [];
      },
    });
  const config = defineConfig({
    source: {
      schema: sourceSchemaFromExamples<Unit>(source),
      read: () => ({
        scopes: [
          {
            range: "messages.json",
            enumeration: "complete",
            records: [{ value: source, bodyAvailability: "available" }],
          },
        ],
      }),
    },
    keyOf: ({ id }) => id,
    translations: {
      languages: ["zh-CN"],
      keyOf: fixtureTranslationKey,
      schema: schemaFromExamples<Translation>(translation),
      contentSchema: jsonValueSchema,
      read: () => ({
        scopes: [
          {
            range: "zh-CN.json",
            covers: ["save"],
            enumeration: "complete",
            records: [{ value: translation, bodyAvailability: "available" }],
          },
        ],
      }),

      contentOf: ({ text }) => text,
    },
    quality: {
      checks: [checker("unlisted"), checker("terms"), checker("syntax")],
      groups: {
        quick: ["syntax", "terms"],
        syntaxOnly: ["syntax"],
      },
    },
  });

  const result = await runQa(config, {
    groups: ["syntaxOnly", "quick", "syntaxOnly"],
  });

  assert.deepEqual(executed, ["terms", "syntax"]);
  assert.deepEqual(loaded, ["terms", "syntax"]);
  assert.deepEqual(
    result.checks.map(({ checkId }) => checkId),
    ["terms", "syntax"],
  );
  assert.deepEqual(result.checkScope, {
    configuredCount: 3,
    selectedIds: ["terms", "syntax"],
  });
  assert.match(
    formatQualityReport(result),
    /检查项范围：配置 3 项，本次子集 2 项（terms、syntax）/u,
  );

  executed.length = 0;
  loaded.length = 0;
  const fullRun = await runQa(config);
  assert.deepEqual(executed, ["unlisted", "terms", "syntax"]);
  assert.deepEqual(loaded, ["unlisted", "terms", "syntax"]);
  assert.match(formatQualityReport(fullRun), /本次全量 3 项/u);
  assert.deepEqual(fullRun.progress, [
    { language: "zh-CN", completed: 1, total: 1, percentage: 100 },
  ]);

  assert.equal(result.progress, undefined);

  const explicitAll = await runQa(config, {
    checkIds: ["syntax", "terms", "unlisted"],
  });
  assert.deepEqual(explicitAll.progress, fullRun.progress);
  assert.match(formatQualityReport(explicitAll), /本次全量 3 项/u);

  const groupedAll = await runQa(
    {
      ...config,
      quality: {
        ...config.quality,
        groups: {
          ...config.quality?.groups,
          rest: ["unlisted"],
        },
      },
    },
    { groups: ["quick", "rest"] },
  );
  assert.deepEqual(groupedAll.progress, fullRun.progress);
  assert.match(formatQualityReport(groupedAll), /本次全量 3 项/u);
});

void test("目录和选择错误在读取豁免及项目事实前被拒绝", async () => {
  const source = { id: "save", source: "Save" };
  const makeConfig = (groups: Readonly<Record<string, readonly string[]>>) => {
    let sourceReads = 0;
    let suppressionReads = 0;
    const check = defineTestChecker<Unit, unknown, JsonValue>({
      id: "known",
      check: () => [],
    });
    const config = defineConfig({
      source: {
        schema: sourceSchemaFromExamples<Unit>(source),
        read: () => {
          sourceReads += 1;
          return { scopes: [] };
        },
      },
      keyOf: ({ id }) => id,
      quality: {
        checks: [check],
        groups,
        suppressionStore: {
          async load() {
            suppressionReads += 1;
            return [];
          },
          async upsert() {},
        },
      },
    });
    return {
      config,
      reads: () => ({ sourceReads, suppressionReads }),
    };
  };

  const cases: {
    readonly groups: Readonly<Record<string, readonly string[]>>;
    readonly options?: unknown;
    readonly message: RegExp;
  }[] = [
    {
      groups: { empty: ["missing"] },
      message: /引用了未配置的检查项/u,
    },
    {
      groups: { empty: [] },
      options: { checkIds: ["missing"] },
      message: /未配置质量检查项/u,
    },
    {
      groups: { empty: [] },
      options: { groups: ["missing"] },
      message: /未配置质量检查分组/u,
    },
    {
      groups: { empty: [] },
      options: { checkIds: ["known"], groups: ["empty"] },
      message: /不能同时使用/u,
    },
    {
      groups: { empty: [] },
      options: { checkIds: [] },
      message: /选择不能为空/u,
    },
    {
      groups: { empty: [] },
      options: { groups: [] },
      message: /分组选择不能为空/u,
    },
    {
      groups: { empty: [] },
      options: { groups: ["empty"] },
      message: /选择结果不能为空/u,
    },
  ];

  for (const { groups, options, message } of cases) {
    const { config, reads } = makeConfig(groups);
    await assert.rejects(runQa(config, options as never), { message });
    assert.deepEqual(reads(), { sourceReads: 0, suppressionReads: 0 });
  }
});
