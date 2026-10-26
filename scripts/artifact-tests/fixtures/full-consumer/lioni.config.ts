import { defineConfig } from "@lioni/core";

import { isNumberArray, isRecord, standardSchema } from "./schemas.ts";

type Unit = {
  readonly source: string;
  readonly context: {
    readonly file: string;
    readonly line: number;
    readonly screenshot: string;
  };
};
type Translation = {
  readonly id: string;
  readonly text: string;
  readonly context: { readonly sourceLines: readonly number[] };
};
type UnavailableTranslation = {
  readonly id: string;
  readonly context: { readonly sourceLines: readonly number[] };
};

const sourceSchema = standardSchema<Unit>(
  (value): value is Unit =>
    isRecord(value) &&
    typeof value.source === "string" &&
    isRecord(value.context) &&
    typeof value.context.file === "string" &&
    typeof value.context.line === "number" &&
    typeof value.context.screenshot === "string",
);
const translationSchema = standardSchema<Translation>(
  (value): value is Translation =>
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.text === "string" &&
    isRecord(value.context) &&
    isNumberArray(value.context.sourceLines),
);
const unavailableTranslationSchema = standardSchema<UnavailableTranslation>(
  (value): value is UnavailableTranslation =>
    isRecord(value) &&
    typeof value.id === "string" &&
    isRecord(value.context) &&
    isNumberArray(value.context.sourceLines),
);
const contentSchema = standardSchema<string>(
  (value): value is string => typeof value === "string",
);

export let translationReadCount = 0;

const config = defineConfig({
  source: {
    schema: sourceSchema,
    read: () => ({
      scopes: [
        {
          range: "src/messages.ts",
          enumeration: "complete",
          records: [
            {
              value: {
                source: "Save",
                context: {
                  file: "src/messages.ts",
                  line: 18,
                  screenshot: "shots/save.png",
                },
              },
              bodyAvailability: "available",
            },
            {
              value: {
                source: "Submit",
                context: {
                  file: "src/messages.ts",
                  line: 19,
                  screenshot: "shots/submit.png",
                },
              },
              bodyAvailability: "available",
            },
            {
              value: {
                source: "Cancel",
                context: {
                  file: "src/messages.ts",
                  line: 20,
                  screenshot: "shots/cancel.png",
                },
              },
              bodyAvailability: "available",
            },
            {
              value: {
                source: "Help",
                context: {
                  file: "src/messages.ts",
                  line: 21,
                  screenshot: "shots/help.png",
                },
              },
              bodyAvailability: "available",
            },
          ],
        },
      ],
    }),
  },
  keyOf(unit) {
    return unit.context.file + ":" + unit.context.line;
  },
  translations: {
    languages: ["fr", "ja", "de"],
    identityOf: (translation) => ({
      namespace: "catalogue",
      key: translation.id,
    }),
    schema: translationSchema,
    unavailableSchema: unavailableTranslationSchema,
    contentSchema,
    contentOf(translation) {
      return translation.text;
    },
    read(language, sourceUnits) {
      translationReadCount += 1;
      if (language === "de") throw new Error("German catalogue unavailable");
      if (language === "fr") {
        return {
          scopes: [
            {
              range: "locales/fr/partial.json",
              covers: sourceUnits.slice(0, 3).map(({ key }) => key),
              enumeration: "partial",
              records: [
                {
                  value: {
                    id: "shared-fr",
                    text: "Partagé",
                    context: { sourceLines: [18, 19] },
                  },
                  bodyAvailability: "available",
                },
                {
                  value: {
                    id: "cancel-a-fr",
                    text: "Annuler A",
                    context: { sourceLines: [20] },
                  },
                  bodyAvailability: "available",
                },
                {
                  value: {
                    id: "cancel-b-fr",
                    text: "Annuler B",
                    context: { sourceLines: [20] },
                  },
                  bodyAvailability: "available",
                },
              ],
            },
            {
              range: "locales/fr/complete.json",
              covers: sourceUnits.slice(3).map(({ key }) => key),
              enumeration: "complete",
              records: [
                {
                  value: {
                    id: "orphan-fr",
                    text: "Isolé",
                    context: { sourceLines: [] },
                  },
                  bodyAvailability: "available",
                },
              ],
            },
          ],
        };
      }
      return {
        scopes: [
          {
            range: "locales/ja.json",
            covers: sourceUnits.map(({ key }) => key),
            enumeration: "complete",
            records: [
              {
                value: {
                  id: "shared-ja",
                  text: "共有",
                  context: { sourceLines: [18, 19] },
                },
                bodyAvailability: "available",
              },
              {
                value: { id: "unavailable-ja", context: { sourceLines: [20] } },
                bodyAvailability: "unavailable",
              },
              {
                value: {
                  id: "orphan-ja",
                  text: "孤立",
                  context: { sourceLines: [] },
                },
                bodyAvailability: "available",
              },
              {
                value: {
                  id: "help-ja",
                  text: "ヘルプ",
                  context: { sourceLines: [21] },
                },
                bodyAvailability: "available",
              },
            ],
          },
        ],
      };
    },
    matches(unit, translation) {
      return translation.context.sourceLines.includes(unit.context.line);
    },
  },
});

export default config;
