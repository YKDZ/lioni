import { defineConfig } from "../src/index.ts";
import type { StandardSchemaV1 } from "../src/index.ts";
import {
  fixtureTranslationIdentity,
  schemaFromExamples,
  sourceSchemaFromExamples,
} from "./source-schema.ts";

type Unit = {
  readonly source: readonly string[];
  readonly context: { readonly line: number };
};

type AvailableTranslation = {
  readonly id: string;
  readonly sourceLine: number;
  readonly text: string;
};

type UnavailableTranslation = {
  readonly id: string;
  readonly sourceLine: number;
};

const sourceSchema = sourceSchemaFromExamples<Unit>({
  source: ["Save", "Submit"],
  context: { line: 18 },
});
const availableSchema = schemaFromExamples<AvailableTranslation>({
  id: "save",
  sourceLine: 18,
  text: "Enregistrer",
});
const unavailableSchema = schemaFromExamples<UnavailableTranslation>({
  id: "submit",
  sourceLine: 19,
});
const contentSchema = schemaFromExamples<string>("Enregistrer");
const actualUnit = {
  source: ["Save", "Submit"],
  context: { line: 18 },
};
const actualAvailableTranslation = {
  id: "save",
  sourceLine: 18,
  text: "Enregistrer",
};
const actualUnavailableTranslation = { id: "submit", sourceLine: 19 };

const config = defineConfig({
  source: {
    schema: sourceSchema,
    read: () => ({
      scopes: [
        {
          range: "messages.json",
          enumeration: "complete",
          records: [
            { value: actualUnit, bodyAvailability: "available" as const },
          ],
        },
      ],
    }),
  },
  keyOf(unit) {
    const strings: readonly string[] = unit.source;
    const line: number = unit.context.line;
    // @ts-expect-error 列表原文单元不能按字符串记录使用。
    unit.source.toUpperCase();
    return `${line}:${strings.length}`;
  },
  translations: {
    languages: ["fr"],
    keyOf: fixtureTranslationIdentity,
    schema: availableSchema,
    unavailableSchema,
    contentSchema,
    read: () => ({
      scopes: [
        {
          range: "locales/fr.json",
          covers: ["18:2"],
          enumeration: "complete",
          records: [
            {
              value: actualAvailableTranslation,
              bodyAvailability: "available" as const,
            },
            {
              value: actualUnavailableTranslation,
              bodyAvailability: "unavailable" as const,
            },
          ],
        },
      ],
    }),
    matches(unit, translation) {
      const sourceLine: number = translation.sourceLine;
      const line: number = unit.context.line;
      if ("text" in translation) {
        const text: string = translation.text;
        void text;
      }
      return sourceLine === line;
    },
    contentOf(translation) {
      const text: string = translation.text;
      return text;
    },
  },
});

const configuredBody: string = config.translations!.contentOf({
  id: "save",
  sourceLine: 18,
  text: "Enregistrer",
});
void configuredBody;

interface InterfaceBody {
  readonly message: string;
}

type InterfaceTranslation = {
  readonly id: string;
  readonly body: InterfaceBody;
};
const interfaceTranslationSchema = schemaFromExamples<InterfaceTranslation>({
  id: "save",
  body: { message: "Enregistrer" },
});
const interfaceBodySchema = schemaFromExamples<InterfaceBody>({
  message: "Enregistrer",
});
const interfaceBodyConfig = defineConfig({
  source: { schema: sourceSchema, read: () => ({ scopes: [] }) },
  keyOf: (unit) => String(unit.context.line),
  translations: {
    languages: ["fr"],
    keyOf: fixtureTranslationIdentity,
    schema: interfaceTranslationSchema,
    contentSchema: interfaceBodySchema,
    read: () => ({ scopes: [] }),
    matches: () => true,
    contentOf: (translation) => translation.body,
  },
});
const bodyPreservesInterfaceType: InterfaceBody =
  interfaceBodyConfig.translations!.contentOf({
    id: "save",
    body: { message: "Enregistrer" },
  });
void bodyPreservesInterfaceType;

defineConfig({
  source: { schema: sourceSchema, read: () => ({ scopes: [] }) },
  keyOf: (unit) => String(unit.context.line),
  translations: {
    languages: ["fr"],
    keyOf: fixtureTranslationIdentity,
    schema: availableSchema,
    contentSchema,
    read: () => ({ scopes: [] }),
    matches: () => true,
    // @ts-expect-error 正文回调必须返回声明的正文类型。
    contentOf: () => 42,
  },
});

defineConfig({
  source: { schema: sourceSchema, read: () => ({ scopes: [] }) },
  keyOf: (unit) => String(unit.context.line),
  translations: {
    languages: ["fr"],
    keyOf: fixtureTranslationIdentity,
    schema: availableSchema,
    contentSchema,
    read: () => ({
      scopes: [
        {
          range: "catalogue.fr",
          covers: [],
          enumeration: "complete",
          records: [
            {
              // @ts-expect-error 未声明不可用记录 schema 时不接受此类记录。
              value: { id: "submit", sourceLine: 19 },
              bodyAvailability: "unavailable",
            },
          ],
        },
      ],
    }),
    matches: () => true,
    contentOf: (translation) => translation.text,
  },
});

const transformingContentSchema: StandardSchemaV1<string, number> = {
  "~standard": {
    version: 1,
    vendor: "invalid-test-fixture",
    validate: (value) => ({ value: Number(value) }),
  },
};

defineConfig({
  source: { schema: sourceSchema, read: () => ({ scopes: [] }) },
  keyOf: (unit) => String(unit.context.line),
  translations: {
    languages: ["fr"],
    keyOf: fixtureTranslationIdentity,
    schema: availableSchema,
    // @ts-expect-error 声明的 schema 必须保留输入和输出类型。
    contentSchema: transformingContentSchema,
    read: () => ({ scopes: [] }),
    matches: () => true,
    contentOf: (translation) => translation.text.length,
  },
});
