import { appendFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  defineConfig,
  type QualityCheckDefinition,
  type QualityCheckResultCache,
  type QualityObject,
  type StandardSchemaV1,
} from "@lioni/core";
import { createDefaultQualityCheckResultCache } from "@lioni/core/node";
import {
  createVueI18nSourceSyntaxChecker,
  createVueI18nTargetSyntaxChecker,
  createVueI18nVariableCorrespondenceChecker,
  type VueI18nProjector,
} from "@lioni/vue-i18n";

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
const project: VueI18nProjector<Unit, Translation, Content> = (input) => {
  const sourceUnit = input.sourceUnit;
  const source =
    sourceUnit?.bodyAvailability === "available"
      ? sourceUnit.unit.source.catalog.message.body
      : undefined;
  const key = input.candidate.sourceKey;
  const language = input.candidate.language;
  return {
    key,
    language,
    source:
      sourceUnit === null
        ? { status: "absent" }
        : source === undefined
          ? { status: "unavailable" }
          : { status: "available", text: source },
    target: {
      status: "available",
      text: input.candidate.content.catalog.message.body,
    },
    locations: {
      source: { language: null, range: { file: "source.json" }, key },
      target: { language, range: { file: "fr.json" }, key },
    },
  };
};

const unitSchema: StandardSchemaV1<Unit, Unit> = standardSchema(isUnit);
const translationSchema: StandardSchemaV1<Translation, Translation> =
  standardSchema(isTranslation);
const contentSchema: StandardSchemaV1<Content, Content> =
  standardSchema(isContent);
const fileCache = createDefaultQualityCheckResultCache(
  fileURLToPath(import.meta.url),
);
const resultCache: QualityCheckResultCache = {
  async get(key) {
    const outcome = await fileCache.get(key);
    await appendFile(
      "qa-cache-events.txt",
      `${outcome === undefined ? "miss" : "hit"}\n`,
      "utf8",
    );
    return outcome;
  },
  set: (key, outcome) => fileCache.set(key, outcome),
};

const syntaxChecks: readonly QualityCheckDefinition<
  Unit,
  Translation,
  QualityObject,
  Content
>[] = [
  createVueI18nSourceSyntaxChecker<Unit, Translation, Content>({
    hostVersion: "artifact-fixture-v1",
    project,
  }),
  createVueI18nTargetSyntaxChecker<Unit, Translation, Content>({
    hostVersion: "artifact-fixture-v1",
    project,
  }),
];

export function createVariableChecker() {
  return createVueI18nVariableCorrespondenceChecker<Unit, Translation, Content>(
    {
      hostVersion: "artifact-fixture-v1",
      project,
    },
  );
}

export function createConfig(
  sourceBody: string,
  targetBody: string,
  checks: readonly QualityCheckDefinition<
    Unit,
    Translation,
    QualityObject,
    Content
  >[] = syntaxChecks,
) {
  return defineConfig({
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
                    catalog: { message: { body: sourceBody } },
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
                    catalog: { message: { body: targetBody } },
                  },
                },
                bodyAvailability: "available" as const,
              },
            ],
          },
        ],
      }),
    },
    quality: {
      prepare: () => ({ checks }),
      resultCache,
    },
  });
}

export default createConfig("source } error", "cible } erreur");

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
