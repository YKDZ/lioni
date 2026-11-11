import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  analyzeQuality,
  defineChecker,
  defineConfig,
  StandardSchemaContractError,
  type JsonValue,
} from "../src/index.ts";
import {
  jsonValueSchema,
  schemaFromExamples,
  sourceSchemaFromExamples,
  fixtureTranslationKey,
} from "./source-schema.ts";

type Unit = { readonly key: string; readonly source: string };
type Translation = {
  readonly key: string;
  readonly text: string;
  readonly language: string;
};

function fixture(
  input: {
    readonly sourceUnits?: readonly Unit[];
    readonly translations?: readonly Translation[];
    readonly languages?: readonly string[];
    readonly enumeration?: "complete" | "partial";
    readonly sourceBodyAvailability?: "available" | "unavailable";
    readonly relationships?: readonly {
      readonly kind: "translation-family";
      readonly key: string;
      readonly members: readonly {
        readonly key: string;
        readonly language: string;
      }[];
    }[];
    readonly observe?: (input: {
      readonly candidate: {
        readonly sourceKey: string;
        readonly language: string;
      };
      readonly facts: {
        readonly source: {
          readonly units: readonly { readonly key: string }[];
        };
        readonly translations: {
          readonly records: readonly {
            readonly identity: { readonly key: string };
          }[];
        };
      };
      readonly relationships?: readonly unknown[];
    }) => void;
  } = {},
) {
  const sourceUnits = input.sourceUnits ?? [{ key: "save", source: "Save" }];
  const translations = input.translations ?? [
    { key: "save", text: "保存", language: "zh-CN" },
  ];
  const languages = input.languages ?? ["zh-CN", "fr"];
  const check = defineChecker.withTypes<Unit, Translation, JsonValue>()({
    id: "candidate-observer",
    version: "candidate-observer-v1",
    inputSchema: schemaFromExamples(null),
    prepare(checkInput) {
      input.observe?.(checkInput);
      return { status: "ready", input: null };
    },
    check() {
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

  return defineConfig({
    source: {
      schema: sourceSchemaFromExamples(
        sourceUnits[0] ?? { key: "save", source: "Save" },
      ),
      read: () => ({
        scopes: [
          {
            range: "messages.json",
            enumeration: "complete" as const,
            records: sourceUnits.map((value) => ({
              value,
              bodyAvailability: input.sourceBodyAvailability ?? "available",
            })),
          },
        ],
      }),
    },
    keyOf: ({ key }) => key,
    translations: {
      languages,
      schema: schemaFromExamples<Translation>({
        key: "save",
        text: "保存",
        language: "zh-CN",
      }),
      contentSchema: jsonValueSchema,
      keyOf: fixtureTranslationKey,
      contentOf: ({ text }) => text,
      read: (language, source) => ({
        scopes: [
          {
            range: `${language}.json`,
            covers: source.map(({ key }) => key),
            enumeration: input.enumeration ?? "complete",
            records: translations
              .filter((translation) => translation.language === language)
              .map((value) => ({
                value,
                bodyAvailability: "available" as const,
              })),
          },
        ],
      }),
    },
    quality: {
      checks: [check],
      relationships: input.relationships ?? [],
    },
  });
}

void describe("QA 候选入口与身份", () => {
  void it("默认纳入已读取且正文可用的同键译文，即使覆盖范围不完整", async () => {
    const result = await analyzeQuality(fixture({ enumeration: "partial" }));

    assert.deepEqual(result.candidates, [
      { sourceKey: "save", language: "zh-CN", content: "保存" },
    ]);
    assert.equal(result.factCoverage.associations[0]?.status, "unknown");
  });

  void it("显式候选子集只限制检查对象，完整事实与关系仍可见", async () => {
    const observed: unknown[] = [];
    const config = fixture({
      sourceUnits: [
        { key: "save", source: "Save" },
        { key: "cancel", source: "Cancel" },
      ],
      translations: [
        { key: "save", text: "保存", language: "zh-CN" },
        { key: "cancel", text: "取消", language: "zh-CN" },
      ],
      relationships: [
        {
          kind: "translation-family",
          key: "actions",
          members: [
            { key: "save", language: "zh-CN" },
            { key: "cancel", language: "zh-CN" },
          ],
        },
      ],
      observe: ({ candidate, facts, relationships }) => {
        observed.push({
          key: candidate.sourceKey,
          sourceKeys: facts.source.units.map(({ key }) => key),
          translationKeys: facts.translations.records.map(
            ({ identity }) => identity.key,
          ),
          relationships: relationships ?? [],
        });
      },
    });

    const result = await analyzeQuality(config, {
      candidates: [{ sourceKey: "save", language: "zh-CN", content: "已保存" }],
    });

    assert.deepEqual(
      result.candidates.map(({ sourceKey }) => sourceKey),
      ["save"],
    );
    assert.deepEqual(observed, [
      {
        key: "save",
        sourceKeys: ["save", "cancel"],
        translationKeys: ["save", "cancel"],
        relationships: [
          {
            kind: "translation-family",
            key: "actions",
            members: [
              { key: "save", language: "zh-CN" },
              { key: "cancel", language: "zh-CN" },
            ],
          },
        ],
      },
    ]);
  });

  void it("接受原文已读取但尚无现存译文的候选，并拒绝未知原文", async () => {
    const config = fixture();
    const added = await analyzeQuality(config, {
      candidates: [
        { sourceKey: "save", language: "fr", content: "Enregistrer" },
      ],
    });
    assert.deepEqual(added.candidates, [
      { sourceKey: "save", language: "fr", content: "Enregistrer" },
    ]);

    await assert.rejects(
      analyzeQuality(config, {
        candidates: [
          { sourceKey: "missing", language: "fr", content: "Absent" },
        ],
      }),
      /原文键.*不存在.*本次已读取/,
    );
  });

  void it("原文正文不可用不改变已知消息键的候选身份", async () => {
    const result = await analyzeQuality(
      fixture({
        translations: [],
        sourceBodyAvailability: "unavailable",
      }),
      {
        candidates: [
          { sourceKey: "save", language: "fr", content: "Enregistrer" },
        ],
      },
    );

    assert.deepEqual(result.candidates, [
      { sourceKey: "save", language: "fr", content: "Enregistrer" },
    ]);
  });

  void it("拒绝重复候选、未配置语言和显式范围外语言", async () => {
    const config = fixture();
    const candidate = {
      sourceKey: "save",
      language: "fr",
      content: "Enregistrer",
    };

    await assert.rejects(
      analyzeQuality(config, { candidates: [candidate, { ...candidate }] }),
      /候选身份.*重复/,
    );
    await assert.rejects(
      analyzeQuality(config, {
        candidates: [{ ...candidate, language: "es" }],
      }),
      /译文候选语言 "es" 不在本次执行范围内/,
    );
    await assert.rejects(
      analyzeQuality(config, {
        languages: ["zh-CN"],
        candidates: [candidate],
      }),
      /译文候选语言 "fr" 不在本次执行范围内/,
    );
  });

  void it("候选筛选不能隐藏错误身份，也不能重复返回同一身份", async () => {
    const config = fixture();

    await assert.rejects(
      analyzeQuality(config, {
        candidates: [
          { sourceKey: "missing", language: "fr", content: "Absent" },
        ],
        selectCandidates: () => [],
      }),
      /原文键.*不存在.*本次已读取/,
    );
    await assert.rejects(
      analyzeQuality(config, {
        candidates: [
          { sourceKey: "save", language: "fr", content: "Enregistrer" },
        ],
        selectCandidates: (candidates) => [candidates[0]!, candidates[0]!],
      }),
      /候选身份.*重复/,
    );
  });

  void it("候选筛选回调不能改写已验证的身份或结构化正文", async () => {
    const candidate = {
      sourceKey: "save",
      language: "fr",
      content: { nested: { value: "stable" } },
    };
    const result = await analyzeQuality(fixture(), {
      candidates: [candidate],
      selectCandidates(candidates) {
        assert.equal(
          Reflect.set(candidates[0]!, "sourceKey", "missing"),
          false,
        );
        const content = candidates[0]!.content as {
          readonly nested: { readonly value: string };
        };
        assert.equal(Reflect.set(content.nested, "value", "changed"), false);
        return candidates;
      },
    });

    assert.deepEqual(result.candidates, [candidate]);
  });

  void it("显式空候选集合不运行检查", async () => {
    let calls = 0;
    const config = fixture({ observe: () => calls++ });

    const result = await analyzeQuality(config, { candidates: [] });

    assert.deepEqual(result.candidates, []);
    assert.equal(calls, 0);
    assert.equal(result.status, "not-run");
  });

  void it("显式 null 不会被当成省略候选而触发默认候选", async () => {
    await assert.rejects(
      analyzeQuality(fixture(), { candidates: null as never }),
      /candidates 必须是译文候选数组/,
    );
  });

  void it("在准备检查器前拒绝不符合宿主正文 schema 的候选", async () => {
    let prepared = false;
    const source = { key: "save", source: "Save" };
    const config = defineConfig({
      source: {
        schema: sourceSchemaFromExamples(source),
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
      keyOf: ({ key }) => key,
      translations: {
        languages: ["fr"],
        schema: schemaFromExamples({ key: "save", text: "" }),
        contentSchema: schemaFromExamples(""),
        contentOf: ({ text }) => text,
        keyOf: ({ key }) => key,
        read: () => ({
          scopes: [
            {
              range: "messages.fr.json",
              covers: ["save"],
              enumeration: "complete",
              records: [],
            },
          ],
        }),
      },
      quality: {
        checks: [
          defineChecker({
            id: "candidate-body",
            version: "candidate-body-v1",
            inputSchema: schemaFromExamples(null),
            prepare: () => {
              prepared = true;
              return { status: "ready", input: null };
            },
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
          }),
        ],
      },
    });

    await assert.rejects(
      analyzeQuality(config, {
        candidates: [
          {
            sourceKey: "save",
            language: "fr",
            content: { text: "Enregistrer" } as never,
          },
        ],
      }),
      (error: unknown) => {
        assert.ok(error instanceof StandardSchemaContractError);
        assert.equal(error.kind, "schema-mismatch");
        assert.equal(error.valueDescription, "译文候选正文");
        return true;
      },
    );

    assert.equal(prepared, false);
  });
});
