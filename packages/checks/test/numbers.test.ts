import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  analyzeQuality,
  createQualityException,
  defineConfig,
  QualityCheckerContractError,
  type BodyAvailability,
  type JsonValue,
  type SemanticEditCandidate,
} from "@lioni/core";
import { z } from "zod";

import { createNumberChecker } from "../src/index.ts";

type Unit = { readonly source: JsonValue; readonly identity: string };
type Translation = { readonly text: JsonValue; readonly nativeKey: string };

type TextUnit = {
  readonly kind: "text";
  readonly source: string;
  readonly identity: string;
};
type ListUnit = {
  readonly kind: "list";
  readonly source: readonly string[];
  readonly identity: string;
};
type MixedUnit = TextUnit | ListUnit;
type MixedBody = string | readonly string[];
type MixedTranslation = {
  readonly text: MixedBody;
  readonly nativeKey: string;
};

const jsonValueSchema: z.ZodType<JsonValue, JsonValue> = z.json();
const sourceSchema: z.ZodType<Unit, Unit> = z.object({
  identity: z.string(),
  source: jsonValueSchema,
});
const translationSchema: z.ZodType<Translation, Translation> = z.object({
  nativeKey: z.string(),
  text: jsonValueSchema,
});

const mixedBodySchema: z.ZodType<MixedBody, MixedBody> = z.union([
  z.string(),
  z.array(z.string()),
]);
const mixedUnitSchema: z.ZodType<MixedUnit, MixedUnit> = z.discriminatedUnion(
  "kind",
  [
    z.object({
      kind: z.literal("text"),
      source: z.string(),
      identity: z.string(),
    }),
    z.object({
      kind: z.literal("list"),
      source: z.array(z.string()),
      identity: z.string(),
    }),
  ],
);
const mixedTranslationSchema: z.ZodType<MixedTranslation, MixedTranslation> =
  z.object({ nativeKey: z.string(), text: mixedBodySchema });

function configFor(
  source: JsonValue | undefined,
  target: JsonValue | undefined,
  availability: BodyAvailability = "available",
) {
  return defineConfig({
    source: {
      schema: sourceSchema,
      read: () => ({
        scopes: [
          {
            range: "source.json",
            enumeration: "complete",
            records:
              source === undefined
                ? []
                : [
                    {
                      value: { source, identity: "message" },
                      bodyAvailability: availability,
                    },
                  ],
          },
        ],
      }),
    },
    keyOf: ({ identity }) => `hash:${identity}`,
    translations: {
      languages: ["fr"],
      keyOf: (translation) => `hash:${translation.nativeKey}`,
      schema: translationSchema,
      contentSchema: jsonValueSchema,
      contentOf: ({ text }) => text,
      read: (_language, units) => ({
        scopes: [
          {
            range: "fr.json",
            enumeration: "complete",
            covers: units.map(({ key }) => key),
            records:
              target === undefined
                ? []
                : [
                    {
                      value: { text: target, nativeKey: "message" },
                      bodyAvailability: "available",
                    },
                  ],
          },
        ],
      }),
    },
    quality: { checks: [createNumberChecker()] },
  });
}

function defaultNumberConfigFor(source: string, target: string) {
  return defineConfig({
    source: {
      schema: sourceSchema,
      read: () => ({
        scopes: [
          {
            range: "source.json",
            enumeration: "complete",
            records: [
              {
                value: { source, identity: "message" },
                bodyAvailability: "available",
              },
            ],
          },
        ],
      }),
    },
    keyOf: ({ identity }) => identity,
    translations: {
      languages: ["fr"],
      keyOf: (translation) => translation.nativeKey,
      schema: translationSchema,
      contentSchema: jsonValueSchema,
      contentOf: ({ text }) => text,
      read: (_language, units) => ({
        scopes: [
          {
            range: "fr.json",
            enumeration: "complete",
            covers: units.map(({ key }) => key),
            records: [
              {
                value: { text: target, nativeKey: "message" },
                bodyAvailability: "available",
              },
            ],
          },
        ],
      }),
    },
    quality: { checks: [createNumberChecker()] },
  });
}

async function check(source: string, target: string) {
  return analyzeQuality(configFor(source, target));
}

void describe("阿拉伯数字对应检查", () => {
  void it("构造时立即拒绝无效准备适配", () => {
    assert.throws(
      () => createNumberChecker({ prepare: null as never }),
      /prepare 必须是函数/u,
    );
  });

  void it("用默认工厂检查字符串正文并报告资源位置与证据", async () => {
    const result = await analyzeQuality(
      defaultNumberConfigFor("Wait 12 seconds", "Attendre 21 secondes"),
    );

    assert.equal(result.diagnostics.length, 1);
    assert.equal(result.diagnostics[0]?.checkId, "number-correspondence");
    assert.deepEqual(result.diagnostics[0]?.location, {
      language: "fr",
      range: "fr.json",
      key: "message",
    });
    assert.deepEqual(
      result.diagnostics[0]?.evidence.map(({ role, value }) => [role, value]),
      [
        ["source", "Wait 12 seconds"],
        ["target", "Attendre 21 secondes"],
      ],
    );
  });

  void it("允许完整数字重排，同时保留重复次数", async () => {
    for (const [source, target] of [
      ["12 and 3.14", "3.14 et 12"],
      ["7, 12, 7", "12、7、7"],
      ["-5 and +8", "+8、-5"],
      ["No numbers", "没有数字"],
      ["", ""],
    ]) {
      const result = await check(source!, target!);
      assert.equal(result.status, "complete");
      assert.deepEqual(result.diagnostics, []);
    }
  });

  void it("完整数字与小数按文本精确匹配，不按字符或数值等价比较", async () => {
    for (const [source, target] of [
      ["12", "21"],
      ["3.14", "314"],
      ["1.2", "2.1"],
      ["01", "1"],
      ["1.0", "1"],
      ["-5", "5"],
      ["9007199254740992", "9007199254740993"],
    ]) {
      const result = await check(source!, target!);
      assert.equal(result.status, "complete");
      assert.equal(result.diagnostics.length, 1);
      assert.match(result.diagnostics[0]!.message, /缺少数字/u);
      assert.match(result.diagnostics[0]!.message, /多出数字/u);
    }
  });

  void it("报告数字缺失、多余及重复次数的差异", async () => {
    const missing = await check("12, 12 and 3", "3 and 12");
    assert.equal(missing.diagnostics[0]?.message, "译文缺少数字：12。");
    const extra = await check("3 and 12", "12, 3 and 12");
    assert.equal(extra.diagnostics[0]?.message, "译文多出数字：12。");
    const repeated = await check("12, 12, 12", "12");
    assert.equal(repeated.diagnostics[0]?.message, "译文缺少数字：12、12。");
    assert.equal(
      (await check("No number", "7")).diagnostics[0]?.message,
      "译文多出数字：7。",
    );
    assert.equal(
      (await check("7", "")).diagnostics[0]?.message,
      "译文缺少数字：7。",
    );
  });

  void it("检查未保存的候选正文，并保留原文与候选证据", async () => {
    const config = configFor("Wait 12 seconds", "Attendre 12 secondes");
    const result = await analyzeQuality(config, {
      candidates: [
        {
          sourceKey: "hash:message",
          language: "fr",
          content: "Attendre 21 secondes",
        },
      ],
    });
    const diagnostic = result.diagnostics[0]!;
    assert.equal(diagnostic.checkId, "number-correspondence");
    assert.deepEqual(diagnostic.location, {
      language: "fr",
      range: "fr.json",
      key: "hash:message",
    });
    assert.equal(diagnostic.object.key, "hash:message");
    assert.deepEqual(
      diagnostic.evidence.map(({ role, value }) => [role, value]),
      [
        ["source", "Wait 12 seconds"],
        ["target", "Attendre 21 secondes"],
      ],
    );
  });

  void it("缺译没有候选时不执行，明确提供候选后可检查和报告空内容", async () => {
    const config = configFor("12 seconds", undefined);
    assert.equal((await analyzeQuality(config)).status, "not-run");
    const passed = await analyzeQuality(config, {
      candidates: [
        { sourceKey: "hash:message", language: "fr", content: "12 secondes" },
      ],
    });
    assert.equal(passed.status, "complete");
    assert.deepEqual(passed.diagnostics, []);
    const empty = await analyzeQuality(config, {
      candidates: [{ sourceKey: "hash:message", language: "fr", content: "" }],
    });
    assert.equal(empty.diagnostics[0]?.message, "译文缺少数字：12。");
    assert.deepEqual(empty.diagnostics[0]?.location, {
      language: "fr",
      range: null,
      key: "hash:message",
    });
  });

  void it("通过显式准备适配读取结构化候选正文", async () => {
    const structuredChecker = createNumberChecker.withTypes<
      Unit,
      Translation,
      JsonValue,
      never
    >()({
      prepare: ({ sourceUnit, translation, candidate }) => {
        const source = sourceUnit.unit.source;
        const content = candidate.content;
        const target =
          content !== null &&
          typeof content === "object" &&
          !Array.isArray(content) &&
          typeof (content as { readonly text?: JsonValue }).text === "string"
            ? (content as { readonly text: string }).text
            : undefined;
        if (typeof source !== "string" || target === undefined)
          return {
            status: "incomplete",
            issue: {
              code: "textUnavailable",
              message: "无法从结构化正文中取得字符串。",
            },
          };
        return {
          status: "ready",
          source,
          target,
          sourceLocation: {
            language: "en",
            range: "structured-source.json",
            key: "message",
          },
          targetLocation: {
            language: candidate.language,
            range: translation?.range ?? null,
            key:
              translation?.bodyAvailability === "available"
                ? translation.translation.nativeKey
                : candidate.sourceKey,
          },
        };
      },
    });
    const config = {
      ...configFor("12 seconds", "12 secondes"),
      quality: { checks: [structuredChecker] },
    };
    for (const [text, diagnosticCount] of [
      ["12 secondes", 0],
      ["21 secondes", 1],
    ] as const) {
      const result = await analyzeQuality(config, {
        candidates: [
          {
            sourceKey: "hash:message",
            language: "fr",
            content: { text, unrelatedNumber: 123 },
          },
        ],
      });
      assert.equal(result.status, "complete");
      assert.equal(result.diagnostics.length, diagnosticCount);
      if (diagnosticCount === 1) {
        assert.deepEqual(result.diagnostics[0]?.location, {
          language: "fr",
          range: "fr.json",
          key: "message",
        });
        assert.deepEqual(result.diagnostics[0]?.evidence[0]?.location, {
          language: "en",
          range: "structured-source.json",
          key: "message",
        });
        assert.deepEqual(
          result.diagnostics[0]?.evidence.map(({ role, value }) => [
            role,
            value,
          ]),
          [
            ["source", "12 seconds"],
            ["target", { text, unrelatedNumber: 123 }],
          ],
        );
      }
    }
  });

  void it("拒绝未读取原文的候选，并报告正文不可用或无法取得字符串", async () => {
    await assert.rejects(
      analyzeQuality(configFor(undefined, "12"), {
        candidates: [
          { sourceKey: "hash:message", language: "fr", content: "12" },
        ],
      }),
      /原文键.*不存在于本次已读取的原文/,
    );
    for (const [config, candidate] of [
      [configFor("12", "12", "unavailable"), "12"],
      [configFor(null, "12"), "12"],
      [configFor("12", null), null],
      [configFor({ text: "12" }, { text: "12" }), { text: "12" }],
    ] as const) {
      const result = await analyzeQuality(config, {
        candidates: [
          {
            sourceKey: "hash:message",
            language: "fr",
            content: candidate,
          },
        ],
      });
      assert.equal(result.status, "incomplete");
      assert.deepEqual(result.diagnostics, []);
      assert.equal(result.checks[0]?.coverage.incomplete, 1);
      assert.equal(result.checks[0]?.issues.length, 1);
    }
  });

  void it("在字符串与列表混合项目中仅检查文本候选并保留列表事实", async () => {
    const units: readonly MixedUnit[] = [
      { kind: "text", identity: "message", source: "Total 12" },
      { kind: "list", identity: "rows", source: ["Version 2024"] },
    ];
    const translations: readonly MixedTranslation[] = [
      { nativeKey: "message", text: "Total 21" },
      { nativeKey: "rows", text: ["Version 2024"] },
    ];
    const checker = createNumberChecker.withTypes<
      MixedUnit,
      MixedTranslation,
      MixedBody,
      never
    >()({
      prepare: ({ sourceUnit, candidate }) => {
        if (sourceUnit.unit.kind === "list")
          return { status: "not-applicable" };
        if (typeof candidate.content !== "string")
          return {
            status: "incomplete",
            issue: {
              code: "textUnavailable",
              message: "文本候选必须是字符串。",
            },
          };
        return {
          status: "ready",
          source: sourceUnit.unit.source,
          target: candidate.content,
        };
      },
    });
    const numberCheckId: "number-correspondence" = checker.id;
    void numberCheckId;
    const config = defineConfig({
      source: {
        schema: mixedUnitSchema,
        read: () => ({
          scopes: [
            {
              range: "source.json",
              enumeration: "complete",
              records: units.map((value) => ({
                value,
                bodyAvailability: "available" as const,
              })),
            },
          ],
        }),
      },
      keyOf: ({ identity }) => `hash:${identity}`,
      translations: {
        languages: ["fr"],
        keyOf: (translation) => `hash:${translation.nativeKey}`,
        schema: mixedTranslationSchema,
        contentSchema: mixedBodySchema,
        contentOf: ({ text }) => text,
        read: (_language, sourceUnits) => ({
          scopes: [
            {
              range: "fr.json",
              covers: sourceUnits.map(({ key }) => key),
              enumeration: "complete" as const,
              records: translations.map((value) => ({
                value,
                bodyAvailability: "available" as const,
              })),
            },
          ],
        }),
      },
      quality: { checks: [checker] },
    });

    const result = await analyzeQuality(config);
    const typedCandidates: readonly SemanticEditCandidate<MixedBody>[] =
      result.candidates;

    assert.equal(result.status, "complete");
    assert.deepEqual(
      typedCandidates.map(({ content }) => content),
      ["Total 21", ["Version 2024"]],
    );
    assert.deepEqual(result.checks[0]?.coverage, {
      selected: 2,
      evaluated: 1,
      notApplicable: 1,
      incomplete: 0,
      failed: 0,
    });
    assert.equal(result.diagnostics.length, 1);
    assert.equal(
      result.diagnostics[0]?.message,
      "译文缺少数字：12。译文多出数字：21。",
    );
  });
});

void describe("数字检查的显式依据", () => {
  void it("无关记录变化复用批准与缓存，实际位置或关联变化仍重新判断", async () => {
    const sources = [
      { identity: "message", source: "12" },
      { identity: "other", source: "8" },
    ];
    const translations = [
      { nativeKey: "message", text: "21" },
      { nativeKey: "other", text: "8" },
    ];
    let range = "fr.json";
    let exceptions: readonly import("@lioni/core").QualityException[] = [];
    const cache = new Map<
      string,
      Awaited<ReturnType<import("@lioni/core").QualityCheckResultCache["get"]>>
    >();
    let hits = 0;
    const config = defineConfig({
      source: {
        schema: sourceSchema,
        read: () => ({
          scopes: [
            {
              range: "source.json",
              enumeration: "complete",
              records: sources.map((value) => ({
                value,
                bodyAvailability: "available",
              })),
            },
          ],
        }),
      },
      keyOf: (unit) => unit.identity,
      translations: {
        languages: ["fr"],
        schema: translationSchema,
        contentSchema: jsonValueSchema,
        keyOf: (translation) => translation.nativeKey,
        contentOf: (translation) => translation.text,
        read: (_language, units) => ({
          scopes: [
            {
              range,
              covers: units.map((unit) => unit.key),
              enumeration: "complete",
              records: translations.map((value) => ({
                value,
                bodyAvailability: "available",
              })),
            },
          ],
        }),
      },
      quality: {
        checks: [createNumberChecker()],
        groups: { daily: ["number-correspondence"] },
        exceptionStore: {
          load: async () => exceptions,
          upsert: async (value) => {
            exceptions = [...exceptions, value];
          },
        },
        resultCache: {
          get: async (key) => {
            const value = cache.get(key);
            if (value) hits++;
            return value;
          },
          set: async (key, value) => {
            cache.set(key, value);
          },
        },
      },
    });
    function verifySelectionTypes() {
      void analyzeQuality(config, { checkIds: ["number-correspondence"] });
      void analyzeQuality(config, { groups: ["daily"] });
      // @ts-expect-error 动态选择不能扩张静态配置里的检查项 ID。
      void analyzeQuality(config, { checkIds: ["number-correspondance"] });
      // @ts-expect-error 动态选择不能扩张静态配置里的分组名。
      void analyzeQuality(config, { groups: ["nightly"] });
    }
    void verifySelectionTypes;
    const run = () =>
      analyzeQuality(config, {
        candidates: [{ sourceKey: "message", language: "fr", content: "21" }],
      });
    const first = await run();
    exceptions = [
      createQualityException({
        id: "number",
        reason: "接受数字差异",
        execution: first.checks[0]!.executions[0]!,
      }),
    ];
    sources[1]!.source = "9";
    translations.reverse();
    const unrelated = await run();
    assert.equal(unrelated.exceptionApplicability[0]?.status, "applicable");
    assert.equal(unrelated.diagnostics[0]?.handling.status, "excepted");
    assert.equal(hits, 1);
    range = "moved.json";
    const moved = await run();
    assert.equal(moved.exceptionApplicability[0]?.status, "basis-changed");
    assert.equal(moved.diagnostics[0]?.location.range, range);
    range = "fr.json";
    assert.equal((await run()).exceptionApplicability[0]?.status, "applicable");
    translations.splice(
      translations.findIndex(({ nativeKey }) => nativeKey === "message"),
      1,
    );
    assert.equal(
      (await run()).exceptionApplicability[0]?.status,
      "basis-changed",
    );
  });
});

void it("数字准备适配的非法返回中止运行，适配器普通 TypeError 保留失败报告", async () => {
  const config = configFor("Save 1", "保存 1");
  await assert.rejects(
    analyzeQuality({
      ...config,
      quality: {
        checks: [createNumberChecker({ prepare: () => null as never })],
      },
    }),
    QualityCheckerContractError,
  );
  const failed = await analyzeQuality({
    ...config,
    quality: {
      checks: [
        createNumberChecker({
          prepare: () => {
            throw new TypeError("宿主提取失败");
          },
        }),
      ],
    },
  });
  assert.equal(failed.status, "failed");
  assert.equal(failed.checks[0]?.issues[0]?.message, "宿主提取失败");
});
