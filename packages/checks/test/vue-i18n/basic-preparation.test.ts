import assert from "node:assert/strict";
import test from "node:test";

import {
  createVueI18nChecks,
  createVueI18nSourceSyntaxChecker,
  createVueI18nTargetSyntaxChecker,
  createVueI18nVariableCorrespondenceChecker,
} from "@lioni/checks";
import { analyzeQuality, defineConfig } from "@lioni/core";
import { z } from "zod";

void test("默认 Vue 语法检查使用字符串候选及现存资源位置", async () => {
  const config = defineConfig({
    source: {
      schema: z.object({ key: z.string(), source: z.string() }),
      read: () => ({
        scopes: [
          {
            range: "en.json",
            enumeration: "complete" as const,
            records: [
              {
                value: { key: "greeting", source: "Hello" },
                bodyAvailability: "available" as const,
              },
            ],
          },
        ],
      }),
    },
    keyOf: (unit) => unit.key,
    translations: {
      languages: ["fr"],
      schema: z.object({ key: z.string(), text: z.string() }),
      contentSchema: z.string(),
      contentOf: (item) => item.text,
      keyOf: (item) => item.key,
      read: () => ({
        scopes: [
          {
            range: "fr.json",
            covers: ["greeting"],
            enumeration: "complete" as const,
            records: [
              {
                value: { key: "greeting", text: "Salut" },
                bodyAvailability: "available" as const,
              },
            ],
          },
        ],
      }),
    },
    quality: { checks: [createVueI18nTargetSyntaxChecker()] },
  });
  const report = await analyzeQuality(config, {
    candidates: [{ sourceKey: "greeting", language: "fr", content: "bad }" }],
  });
  assert.equal(report.diagnostics.length, 1);
  assert.equal(report.diagnostics[0]?.location.range, "fr.json");
  assert.deepEqual(report.diagnostics[0]?.location.span, { start: 4, end: 4 });
});

void test("结构化正文默认报告不完整，显式准备适配支持特殊范围与三态", async () => {
  const create = (
    prepare?: import("@lioni/checks").VueI18nPreparer<
      { key: string; source: { text: string } },
      { key: string; text: string },
      { text: string }
    >,
  ) =>
    defineConfig({
      source: {
        schema: z.object({
          key: z.string(),
          source: z.object({ text: z.string() }),
        }),
        read: () => ({
          scopes: [
            {
              range: "source",
              enumeration: "complete" as const,
              records: [
                {
                  value: { key: "a", source: { text: "Hello" } },
                  bodyAvailability: "available" as const,
                },
              ],
            },
          ],
        }),
      },
      keyOf: (unit) => unit.key,
      translations: {
        languages: ["fr"],
        schema: z.object({ key: z.string(), text: z.string() }),
        contentSchema: z.object({ text: z.string() }),
        keyOf: (item) => item.key,
        contentOf: (item) => ({ text: item.text }),
        read: () => ({ scopes: [] }),
      },
      quality: {
        checks: [
          createVueI18nTargetSyntaxChecker({
            id: "syntax",
            ...(prepare ? { prepare } : {}),
          }),
        ],
      },
    });
  const candidate = {
    sourceKey: "a",
    language: "fr",
    content: { text: "bad }" },
  };
  const missing = await analyzeQuality(create(), { candidates: [candidate] });
  assert.equal(missing.checks[0]?.status, "incomplete");
  const ready = await analyzeQuality(
    create(({ candidate, sourceUnit, translation }) => ({
      status: "ready",
      input: {
        key: sourceUnit.key,
        language: candidate.language,
        source: { status: "available", text: sourceUnit.unit.source.text },
        target: { status: "available", text: candidate.content.text },
        locations: {
          source: { language: null, range: null },
          target: {
            language: candidate.language,
            range: translation?.range ?? "new-message",
          },
        },
      },
    })),
    { candidates: [candidate] },
  );
  assert.equal(ready.diagnostics[0]?.location.range, "new-message");
  assert.deepEqual(ready.diagnostics[0]?.location.span, { start: 4, end: 4 });
  const skipped = await analyzeQuality(
    create(() => ({ status: "not-applicable" })),
    { candidates: [candidate] },
  );
  assert.equal(skipped.checks[0]?.status, "not-applicable");
});

void test("Vue 工厂在装配时拒绝无效准备适配", () => {
  assert.throws(
    () =>
      createVueI18nTargetSyntaxChecker({
        id: "syntax",
        prepare: "invalid" as never,
      }),
    /准备适配/u,
  );
});

void test("Vue 基础工厂立即拒绝无效语言读取器且不在装配时读取", () => {
  for (const create of [
    createVueI18nSourceSyntaxChecker,
    createVueI18nTargetSyntaxChecker,
    createVueI18nVariableCorrespondenceChecker,
  ]) {
    for (const value of [42, false, null])
      assert.throws(
        () => create({ id: "syntax", loadLanguages: value as never }),
        /loadLanguages/u,
      );
    let reads = 0;
    create({
      id: "syntax",
      loadLanguages: () => {
        reads++;
        return [];
      },
    });
    assert.equal(reads, 0);
  }
});

void test("完整 Vue 工厂立即验证全部回调且保留按需读取", () => {
  for (const name of [
    "prepare",
    "loadLanguages",
    "loadPolicies",
    "loadTerms",
    "reference",
  ] as const) {
    for (const value of [42, false, null])
      assert.throws(
        () =>
          createVueI18nChecks({
            reference: () => {
              throw new Error("装配时不应读取参照");
            },
            [name]: value,
          } as never),
        TypeError,
      );
  }
  let reads = 0;
  const checks = createVueI18nChecks({
    prepare: () => {
      reads++;
      return { status: "not-applicable" };
    },
    reference: () => {
      reads++;
      throw new Error("装配时不应读取参照");
    },
    loadLanguages: () => {
      reads++;
      return [];
    },
    loadPolicies: () => {
      reads++;
      return [];
    },
    loadTerms: () => {
      reads++;
      return { concepts: [] };
    },
  });
  assert.equal(checks.length, 10);
  assert.equal(reads, 0);
});
