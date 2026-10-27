import assert from "node:assert/strict";
import test from "node:test";

import {
  createVueI18nSourceSyntaxChecker,
  createVueI18nTargetSyntaxChecker,
} from "@lioni/checks";
import {
  analyzeQuality,
  defineConfig,
  type QualityCheckInput,
  type SourceUnitFact,
  type StandardSchemaV1,
} from "@lioni/core";

type Content = { readonly message: { readonly body: string } };
type Unit = {
  readonly source: {
    readonly identity: string;
    readonly message: { readonly body: string };
  };
};
type Translation = { readonly nativeKey: string; readonly content: Content };

const unitSchema: StandardSchemaV1<Unit, Unit> = {
  "~standard": {
    version: 1,
    vendor: "lioni-vue-i18n-syntax-test",
    validate(value) {
      return isUnit(value)
        ? { value }
        : { issues: [{ message: "原文结构无效。" }] };
    },
  },
};

const translationSchema: StandardSchemaV1<Translation, Translation> = {
  "~standard": {
    version: 1,
    vendor: "lioni-vue-i18n-syntax-test",
    validate(value) {
      return isTranslation(value)
        ? { value }
        : { issues: [{ message: "译文结构无效。" }] };
    },
  },
};

const contentSchema: StandardSchemaV1<Content, Content> = {
  "~standard": {
    version: 1,
    vendor: "lioni-vue-i18n-syntax-test",
    validate(value) {
      return isContent(value)
        ? { value }
        : { issues: [{ message: "候选正文结构无效。" }] };
    },
  },
};

function sourceChecker() {
  return createVueI18nSourceSyntaxChecker<Unit, Translation, Unit, Content>({
    select: (input: QualityCheckInput<Unit, Translation, unknown, Content>) => {
      if (input.sourceUnit === null)
        return {
          status: "incomplete" as const,
          issue: { code: "sourceUnavailable", message: "找不到原文。" },
        };
      return {
        status: "selected" as const,
        subject: {
          sourceUnit: input.sourceUnit as SourceUnitFact<Unit>,
          sourceKey: input.candidate.sourceKey,
          language: input.candidate.language,
        },
      };
    },
    sourceText: (unit) => unit.source.message.body,
    sourceLocation: (_unit, subject, range) => ({
      language: null,
      range: { file: "source.json", key: subject.key, span: range },
      key: subject.key,
    }),
  });
}

function targetChecker() {
  return createVueI18nTargetSyntaxChecker<Unit, Translation, Content, Content>({
    select: (input) => ({
      status: "selected",
      subject: {
        sourceKey: input.candidate.sourceKey,
        language: input.candidate.language,
        content: input.candidate.content,
      },
    }),
    targetText: (content) => content.message.body,
  });
}

function configFor(
  source: string | undefined,
  target: string | undefined,
  checks: readonly ReturnType<typeof sourceChecker>[],
) {
  return defineConfig({
    source: {
      schema: unitSchema,
      read: () => ({
        scopes: [
          {
            range: "source.json",
            enumeration: "complete" as const,
            records:
              source === undefined
                ? []
                : [
                    {
                      value: {
                        source: {
                          identity: "message",
                          message: { body: source },
                        },
                      },
                      bodyAvailability: "available" as const,
                    },
                  ],
          },
        ],
      }),
    },
    keyOf: ({ source: { identity } }) => `hash:${identity}`,
    translations: {
      languages: ["fr"],
      identityOf: (translation) => ({
        namespace: "messages",
        key: translation.nativeKey,
      }),
      schema: translationSchema,
      contentSchema,
      contentOf: (translation) => translation.content,
      matches: (unit, translation) =>
        unit.source.identity === translation.nativeKey,
      read: (_language, units) => ({
        scopes: [
          {
            range: "fr.json",
            enumeration: "complete" as const,
            covers: units.map(({ key }) => key),
            records:
              target === undefined
                ? []
                : [
                    {
                      value: {
                        nativeKey: "message",
                        content: { message: { body: target } },
                      },
                      bodyAvailability: "available" as const,
                    },
                  ],
          },
        ],
      }),
    },
    qualityChecks: checks,
  });
}

void test("原文与候选译文语法分别报告，并将原文错误映射回原文", async () => {
  const result = await analyzeQuality(
    configFor("bad } source", "wrong } target", [
      sourceChecker(),
      targetChecker(),
    ]),
    {
      candidates: [
        {
          sourceKey: "hash:message",
          language: "fr",
          content: { message: { body: "wrong } target" } },
        },
      ],
    },
  );

  assert.equal(result.status, "complete");
  assert.equal(result.diagnostics.length, 2);
  const source = result.diagnostics.find(
    ({ ruleId }) => ruleId === "vue-i18n/source-syntax",
  );
  const target = result.diagnostics.find(
    ({ ruleId }) => ruleId === "vue-i18n/target-syntax",
  );
  assert.equal(source?.severity, "error");
  assert.equal(source?.object.kind, "source-unit");
  assert.equal(source?.location.language, null);
  assert.deepEqual(source?.location.range, {
    file: "source.json",
    key: "hash:message",
    span: { start: 4, end: 4 },
  });
  assert.equal(target?.severity, "error");
  assert.equal(target?.object.kind, "translation-unit");
  assert.equal(target?.location.language, "fr");
  assert.equal(target?.location.range, "fr.json");
  assert.deepEqual(target?.location.span, { start: 6, end: 6 });
});

void test("目标语法检查可投影嵌套正文且不要求存在原文或非空文本", async () => {
  const config = configFor(undefined, undefined, [targetChecker()]);
  const invalid = await analyzeQuality(config, {
    candidates: [
      {
        sourceKey: "orphan",
        language: "fr",
        content: { message: { body: "bad } target" } },
      },
    ],
  });
  const empty = await analyzeQuality(config, {
    candidates: [
      {
        sourceKey: "orphan",
        language: "fr",
        content: { message: { body: "" } },
      },
    ],
  });

  assert.equal(invalid.status, "complete");
  assert.equal(invalid.diagnostics.length, 1);
  assert.equal(invalid.diagnostics[0]?.object.key, "orphan");
  assert.equal(invalid.diagnostics[0]?.object.language, "fr");
  assert.equal(empty.status, "complete");
  assert.deepEqual(empty.diagnostics, []);
});

function isContent(value: unknown): value is Content {
  return (
    isRecord(value) &&
    isRecord(value.message) &&
    typeof value.message.body === "string"
  );
}

function isUnit(value: unknown): value is Unit {
  return (
    isRecord(value) &&
    isRecord(value.source) &&
    typeof value.source.identity === "string" &&
    isContent({ message: value.source.message })
  );
}

function isTranslation(value: unknown): value is Translation {
  return (
    isRecord(value) &&
    typeof value.nativeKey === "string" &&
    isContent(value.content)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
