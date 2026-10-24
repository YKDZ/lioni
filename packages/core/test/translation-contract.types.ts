import { defineConfig } from "../src/index.ts";
import type { StandardSchemaV1 } from "../src/index.ts";
import {
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
    // @ts-expect-error Array source units are not inferred as string records.
    unit.source.toUpperCase();
    return `${line}:${strings.length}`;
  },
  translations: {
    languages: ["fr"],
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
  completion: {
    criterion: "typed target facts",
    resolveCompletion({ translations }) {
      const translation = translations[0];
      if (translation?.bodyAvailability === "available") {
        const text: string = translation.translation.text;
        const body: string = translation.content;
        void text;
        void body;
        return true;
      }
      if (translation?.bodyAvailability === "unavailable") {
        const id: string = translation.translation.id;
        // @ts-expect-error Unavailable records have no content property.
        const body: string = translation.content;
        void id;
        void body;
      }
      return false;
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
    schema: availableSchema,
    contentSchema,
    read: () => ({ scopes: [] }),
    matches: () => true,
    // @ts-expect-error The body callback must return the declared body type.
    contentOf: () => 42,
  },
});

defineConfig({
  source: { schema: sourceSchema, read: () => ({ scopes: [] }) },
  keyOf: (unit) => String(unit.context.line),
  translations: {
    languages: ["fr"],
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
              // @ts-expect-error Without unavailableSchema, unavailable records are not supported.
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
    schema: availableSchema,
    // @ts-expect-error The declared schema must preserve its input/output type.
    contentSchema: transformingContentSchema,
    read: () => ({ scopes: [] }),
    matches: () => true,
    contentOf: (translation) => translation.text.length,
  },
});
