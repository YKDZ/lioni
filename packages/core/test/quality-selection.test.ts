import assert from "node:assert/strict";
import { test } from "node:test";

import {
  analyzeQuality,
  defineConfig,
  defineQualityCheck,
  formatQualityReport,
  type JsonValue,
  type QualityObject,
  type StandardSchemaV1,
} from "../src/index.ts";
import { defineTestQualityCheck } from "./quality-check-fixture.ts";
import {
  jsonValueSchema,
  schemaFromExamples,
  sourceSchemaFromExamples,
  fixtureTranslationIdentity,
} from "./source-schema.ts";

type Unit = { readonly id: string; readonly source: string };
type Translation = { readonly id: string; readonly text: string };

void test("按分组并集去重并保持配置顺序执行，未归组项不运行", async () => {
  const source = { id: "save", source: "Save" };
  const translation = { id: "save", text: "保存" };
  const executed: string[] = [];
  const loaded: string[] = [];
  const checker = (id: string) =>
    defineTestQualityCheck<Unit, Translation, JsonValue>({
      id,
      configuration: {},
      loadDependencies() {
        loaded.push(id);
        return {};
      },
      check: () => {
        executed.push(id);
        return {
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
        };
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
      keyOf: fixtureTranslationIdentity,
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
      matches: (unit, target) => unit.id === target.id,
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

  const result = await analyzeQuality(config, {
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
  const fullRun = await analyzeQuality(config);
  assert.deepEqual(executed, ["unlisted", "terms", "syntax"]);
  assert.deepEqual(loaded, ["unlisted", "terms", "syntax"]);
  assert.match(formatQualityReport(fullRun), /本次全量 3 项/u);
});

void test("未选检查项的无效配置不会被校验", async () => {
  const source: Unit = { id: "save", source: "Save" };
  const rejectingSchema: StandardSchemaV1<JsonValue, JsonValue> = {
    "~standard": {
      version: 1,
      vendor: "quality-selection-test",
      validate() {
        return { issues: [{ message: "该配置不应被访问。" }] };
      },
    },
  };
  const selected = defineTestQualityCheck<Unit, unknown, JsonValue>({
    id: "selected",
    configuration: {},
    check: () => ({
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
    }),
  });
  const ignored = defineQualityCheck.withTypes<
    Unit,
    unknown,
    typeof rejectingSchema,
    QualityObject,
    JsonValue
  >()({
    id: "ignored",
    version: "v1",
    configurationSchema: rejectingSchema,
    configuration: {},
    check: () => ({
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
    }),
  });
  const config = defineConfig({
    source: {
      schema: sourceSchemaFromExamples<Unit>(source),
      read: () => ({ scopes: [] }),
    },
    keyOf: ({ id }) => id,
    quality: { checks: [selected, ignored] },
  });

  const result = await analyzeQuality(config, { checkIds: ["selected"] });

  assert.deepEqual(
    result.checks.map(({ checkId, status }) => [checkId, status]),
    [["selected", "not-run"]],
  );
});

void test("目录和选择错误在读取例外及项目事实前被拒绝", async () => {
  const source = { id: "save", source: "Save" };
  const makeConfig = (groups: Readonly<Record<string, readonly string[]>>) => {
    let sourceReads = 0;
    let exceptionReads = 0;
    const check = defineTestQualityCheck<Unit, unknown, JsonValue>({
      id: "known",
      configuration: {},
      check: () => ({
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
      }),
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
        exceptionStore: {
          async load() {
            exceptionReads += 1;
            return [];
          },
          async upsert() {},
        },
      },
    });
    return {
      config,
      reads: () => ({ sourceReads, exceptionReads }),
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
    await assert.rejects(analyzeQuality(config, options as never), { message });
    assert.deepEqual(reads(), { sourceReads: 0, exceptionReads: 0 });
  }
});
