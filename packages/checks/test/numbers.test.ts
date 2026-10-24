import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  analyzeQuality,
  defineConfig,
  type BodyAvailability,
  type JsonValue,
  type QualityCheckInput,
  type SourceUnitFact,
  type StandardSchemaV1,
} from "@lioni/core";

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

const sourceSchema: StandardSchemaV1<Unit, Unit> = {
  "~standard": {
    version: 1,
    vendor: "lioni-number-check-test",
    validate(value) {
      return isUnit(value)
        ? { value }
        : { issues: [{ message: "原文单元结构不匹配。" }] };
    },
  },
};

const translationSchema: StandardSchemaV1<Translation, Translation> = {
  "~standard": {
    version: 1,
    vendor: "lioni-number-check-test",
    validate(value) {
      if (
        typeof value !== "object" ||
        value === null ||
        Array.isArray(value) ||
        !("text" in value) ||
        !isJsonValue(value.text) ||
        !("nativeKey" in value) ||
        typeof value.nativeKey !== "string"
      )
        return { issues: [{ message: "译文记录结构不匹配。" }] };
      return {
        value: { text: value.text, nativeKey: value.nativeKey },
      };
    },
  },
};

const jsonValueSchema: StandardSchemaV1<JsonValue, JsonValue> = {
  "~standard": {
    version: 1,
    vendor: "lioni-number-check-test",
    validate(value) {
      return isJsonValue(value)
        ? { value }
        : { issues: [{ message: "正文必须是 JSON 数据。" }] };
    },
  },
};

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

function isMixedUnit(value: unknown): value is MixedUnit {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  if (
    !("kind" in value) ||
    !("source" in value) ||
    !("identity" in value) ||
    typeof value.identity !== "string"
  )
    return false;
  if (value.kind === "text") return typeof value.source === "string";
  return (
    value.kind === "list" &&
    Array.isArray(value.source) &&
    value.source.every((entry: unknown) => typeof entry === "string")
  );
}

function isMixedBody(value: unknown): value is MixedBody {
  return (
    typeof value === "string" ||
    (Array.isArray(value) &&
      value.every((entry: unknown) => typeof entry === "string"))
  );
}

const mixedUnitSchema: StandardSchemaV1<MixedUnit, MixedUnit> = {
  "~standard": {
    version: 1,
    vendor: "lioni-number-check-test",
    validate(value) {
      return isMixedUnit(value)
        ? { value }
        : { issues: [{ message: "混合原文单元结构不匹配。" }] };
    },
  },
};

const mixedTranslationSchema: StandardSchemaV1<
  MixedTranslation,
  MixedTranslation
> = {
  "~standard": {
    version: 1,
    vendor: "lioni-number-check-test",
    validate(value) {
      if (
        typeof value !== "object" ||
        value === null ||
        Array.isArray(value) ||
        !("text" in value) ||
        !isMixedBody(value.text) ||
        !("nativeKey" in value) ||
        typeof value.nativeKey !== "string"
      )
        return { issues: [{ message: "混合译文记录结构不匹配。" }] };
      return { value: { text: value.text, nativeKey: value.nativeKey } };
    },
  },
};

const mixedBodySchema: StandardSchemaV1<MixedBody, MixedBody> = {
  "~standard": {
    version: 1,
    vendor: "lioni-number-check-test",
    validate(value) {
      return isMixedBody(value)
        ? { value }
        : { issues: [{ message: "混合正文必须是字符串或字符串列表。" }] };
    },
  },
};

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
    qualityChecks: [
      createNumberChecker({
        select: selectNumberSubject,
        sourceText: (unit) => unit.source,
        translationText: (content) => content,
        translationLocation: (translation, _subject, location) =>
          translation === undefined
            ? location
            : { ...location, key: translation.nativeKey },
      }),
    ],
  });
}

function isJsonValue(
  value: unknown,
  active = new Set<object>(),
): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || active.has(value)) return false;
  active.add(value);
  const valid = Array.isArray(value)
    ? value.every((entry) => isJsonValue(entry, active))
    : Object.values(value).every((entry) => isJsonValue(entry, active));
  active.delete(value);
  return valid;
}

function isUnit(value: unknown): value is Unit {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const unit = value as Record<string, unknown>;
  return (
    Object.hasOwn(unit, "source") &&
    typeof unit.identity === "string" &&
    isJsonValue(unit.source)
  );
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
    assert.equal(diagnostic.ruleId, "number-correspondence");
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
      qualityChecks: [
        createNumberChecker({
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
      qualityChecks: [checker],
    });

    const result = await analyzeQuality(config);

    assert.equal(result.status, "complete");
    assert.deepEqual(
      result.candidates.map(({ content }) => content),
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
