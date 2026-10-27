import {
  createVueI18nSourceSyntaxChecker,
  createVueI18nTargetSyntaxChecker,
} from "@lioni/checks";
import {
  defineConfig,
  type QualityCheckInput,
  type SourceUnitFact,
  type StandardSchemaV1,
} from "@lioni/core";

type Content = {
  readonly catalog: { readonly message: { readonly body: string } };
};
type Unit = {
  readonly source: {
    readonly id: string;
    readonly catalog: { readonly message: { readonly body: string } };
  };
};
type Translation = { readonly nativeKey: string; readonly content: Content };

const unitSchema: StandardSchemaV1<Unit, Unit> = standardSchema(isUnit);
const translationSchema: StandardSchemaV1<Translation, Translation> =
  standardSchema(isTranslation);
const contentSchema: StandardSchemaV1<Content, Content> =
  standardSchema(isContent);

const qualityChecks = [
  createVueI18nSourceSyntaxChecker<Unit, Translation, Unit, Content>({
    hostVersion: "artifact-fixture-v1",
    select: (input: QualityCheckInput<Unit, Translation, unknown, Content>) => {
      if (input.sourceUnit === null)
        return {
          status: "incomplete" as const,
          issue: { code: "sourceUnavailable", message: "找不到对应原文。" },
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
    sourceText: (unit) => unit.source.catalog.message.body,
    sourceLocation: (_unit, subject, range) => ({
      language: null,
      range: { file: "source.json", span: range },
      key: subject.key,
    }),
  }),
  createVueI18nTargetSyntaxChecker<Unit, Translation, Content, Content>({
    hostVersion: "artifact-fixture-v1",
    select: (input) => ({
      status: "selected",
      subject: {
        sourceKey: input.candidate.sourceKey,
        language: input.candidate.language,
        content: input.candidate.content,
      },
    }),
    targetText: (content) => content.catalog.message.body,
  }),
];

const config = defineConfig({
  source: {
    schema: unitSchema,
    read: () => ({
      scopes: [
        {
          range: "source.json",
          enumeration: "complete" as const,
          records: [
            {
              value: {
                source: {
                  id: "message",
                  catalog: { message: { body: "source } error" } },
                },
              },
              bodyAvailability: "available" as const,
            },
          ],
        },
      ],
    }),
  },
  keyOf: ({ source }) => source.id,
  translations: {
    languages: ["fr"],
    identityOf: (translation) => ({
      namespace: "messages",
      key: translation.nativeKey,
    }),
    schema: translationSchema,
    contentSchema,
    contentOf: (translation) => translation.content,
    matches: (unit, translation) => unit.source.id === translation.nativeKey,
    read: (_language, units) => ({
      scopes: [
        {
          range: "fr.json",
          enumeration: "complete" as const,
          covers: units.map(({ key }) => key),
          records: [
            {
              value: {
                nativeKey: "message",
                content: {
                  catalog: { message: { body: "cible } erreur" } },
                },
              },
              bodyAvailability: "available" as const,
            },
          ],
        },
      ],
    }),
  },
  qualityChecks,
});

export default config;

function standardSchema<T>(
  isValue: (value: unknown) => value is T,
): StandardSchemaV1<T, T> {
  return {
    "~standard": {
      version: 1,
      vendor: "lioni-ticket05-vue-i18n-artifact",
      validate(value) {
        return isValue(value)
          ? { value }
          : { issues: [{ message: "制品消费者记录结构无效。" }] };
      },
    },
  };
}

function isContent(value: unknown): value is Content {
  return (
    isRecord(value) &&
    isRecord(value.catalog) &&
    isRecord(value.catalog.message) &&
    typeof value.catalog.message.body === "string"
  );
}

function isUnit(value: unknown): value is Unit {
  return (
    isRecord(value) &&
    isRecord(value.source) &&
    typeof value.source.id === "string" &&
    isContent({ catalog: value.source.catalog })
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
