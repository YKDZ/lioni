import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  analyzeQuality,
  createQualityException,
  defineConfig,
  type BodyAvailability,
  type JsonValue,
  type QualityCheckInput,
  type SemanticEditCandidate,
  type SourceUnitFact,
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

function selectNumberSubject(
  input: QualityCheckInput<Unit, Translation, unknown, JsonValue>,
) {
  const sourceUnit = input.sourceUnit;
  if (sourceUnit === null)
    return {
      status: "incomplete" as const,
      issue: { code: "sourceUnavailable", message: "找不到对应原文。" },
    };
  return {
    status: "selected" as const,
    subject: {
      sourceUnit,
      sourceKey: input.candidate.sourceKey,
      language: input.candidate.language,
      content: input.candidate.content,
    },
  };
}

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

function selectMixedText(
  input: QualityCheckInput<
    MixedUnit,
    MixedTranslation,
    unknown,
    MixedBody,
    never
  >,
) {
  const sourceUnit = input.sourceUnit;
  if (sourceUnit === null)
    return {
      status: "incomplete" as const,
      issue: { code: "sourceUnavailable", message: "找不到对应原文。" },
    };

  const content = input.candidate.content;
  if (sourceUnit.unit.kind === "list") {
    if (
      Array.isArray(content) &&
      content.every((entry: unknown) => typeof entry === "string")
    )
      return { status: "not-applicable" as const };
    return {
      status: "incomplete" as const,
      issue: { code: "candidateShape", message: "列表候选结构不匹配。" },
    };
  }

  if (typeof content !== "string")
    return {
      status: "incomplete" as const,
      issue: { code: "candidateShape", message: "文本候选必须是字符串。" },
    };
  const textSourceUnit: SourceUnitFact<TextUnit> = {
    ...sourceUnit,
    unit: sourceUnit.unit,
  };
  return {
    status: "selected" as const,
    subject: {
      sourceUnit: textSourceUnit,
      sourceKey: input.candidate.sourceKey,
      language: input.candidate.language,
      content,
    },
  };
}

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
      keyOf: (translation) => ({
        namespace: "messages",
        key: translation.nativeKey,
      }),
      schema: translationSchema,
      contentSchema: jsonValueSchema,
      contentOf: ({ text }) => text,
      matches: (unit, translation) => unit.identity === translation.nativeKey,
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
    quality: {
      checks: [
        createNumberChecker({
          hostVersion: "number-test-v1",
          select: selectNumberSubject,
          sourceText: (unit) => unit.source,
          translationText: (content) => content,
          translationLocation: (translation, _subject, location) =>
            translation === undefined
              ? location
              : { ...location, key: translation.nativeKey },
        }),
      ],
    },
  });
}

async function check(source: string, target: string) {
  return analyzeQuality(configFor(source, target));
}

void describe("阿拉伯数字对应检查", () => {
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
    assert.equal(
      result.checks[0]?.version,
      "checks.number-correspondence/v2+number-test-v1",
    );
    assert.equal(diagnostic.checkId, "number-correspondence");
    assert.deepEqual(diagnostic.location, {
      language: "fr",
      range: "fr.json",
      key: "message",
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

  void it("通过宿主提供的取值函数检查结构化候选，仅比较正文中的数字", async () => {
    const config = {
      ...configFor("12 seconds", "12 secondes"),
      quality: {
        checks: [
          createNumberChecker({
            hostVersion: "number-test-v1",
            select: selectNumberSubject,
            sourceText: (unit) => unit.source,
            translationText: (content) => {
              if (
                content !== null &&
                typeof content === "object" &&
                !Array.isArray(content)
              )
                return (content as { readonly text?: JsonValue }).text;
              return undefined;
            },
          }),
        ],
      },
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
    }
  });

  void it("原文缺失、正文不可用和非文本内容如实报告未完成", async () => {
    for (const [config, candidate] of [
      [configFor(undefined, "12"), "12"],
      [configFor("12", "12", "unavailable"), "12"],
      [configFor(null, "12"), "12"],
      [configFor("12", null), null],
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
    const checker = createNumberChecker({
      hostVersion: "number-test-v1",
      select: selectMixedText,
      sourceText: (unit) => unit.source,
      translationText: (content) =>
        typeof content === "string" ? content : undefined,
    });
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
        keyOf: (translation) => ({
          namespace: "messages",
          key: translation.nativeKey,
        }),
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
        matches: (unit, translation) => unit.identity === translation.nativeKey,
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
        keyOf: (translation) => ({
          namespace: "messages",
          key: translation.nativeKey,
        }),
        contentOf: (translation) => translation.text,
        matches: (unit, translation) =>
          unit.identity === translation.nativeKey ||
          (unit.identity === "message" &&
            translation.nativeKey === "duplicate"),
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
        checks: [
          createNumberChecker({
            hostVersion: "explicit-number-v1",
            select: selectNumberSubject,
            sourceText: (unit) => unit.source,
            translationText: (content) => content,
            fingerprintInput: ({ projected }) => projected,
          }),
        ],
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
    translations.push({ nativeKey: "duplicate", text: "22" });
    assert.equal(
      (await run()).exceptionApplicability[0]?.status,
      "basis-changed",
    );
  });
});
