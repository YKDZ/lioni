import { readFileSync } from "node:fs";

import { defineConfig } from "@lioni/core";

import { isRecord, standardSchema } from "./schemas.ts";

type Translation = {
  text: string;
  context: { sourceLine: number };
};
type Unit = {
  source: string;
  context: { file: string; line: number };
};
const sourceSchema = standardSchema<Unit>(
  (value): value is Unit =>
    isRecord(value) &&
    typeof value.source === "string" &&
    isRecord(value.context) &&
    typeof value.context.file === "string" &&
    typeof value.context.line === "number",
);
const translationSchema = standardSchema<Translation>(
  (value): value is Translation =>
    isRecord(value) &&
    typeof value.text === "string" &&
    isRecord(value.context) &&
    typeof value.context.sourceLine === "number",
);
const contentSchema = standardSchema<string>(
  (value): value is string => typeof value === "string",
);

const sourceRecords = [
  { source: "Save", context: { file: "src/messages.ts", line: 18 } },
  { source: "Submit", context: { file: "src/messages.ts", line: 19 } },
];

export default defineConfig({
  source: {
    schema: sourceSchema,
    read: () => ({
      scopes: [
        {
          range: "src/messages.ts",
          enumeration: "complete",
          records: sourceRecords.map((value) => ({
            value,
            bodyAvailability: "available",
          })),
        },
      ],
    }),
  },
  keyOf(unit) {
    return unit.context.file + ":" + unit.context.line;
  },
  translations: {
    languages: ["fr", "de"],
    schema: translationSchema,
    contentSchema,
    contentOf: (translation) => translation.text,
    read(language, sourceUnits) {
      const values = JSON.parse(
        readFileSync(
          new URL(
            "./completion-resources/" + language + ".json",
            import.meta.url,
          ),
          "utf8",
        ),
      ) as Translation[];
      return {
        scopes: [
          {
            range: "completion-resources/" + language + ".json",
            covers: sourceUnits.map(({ key }) => key),
            enumeration: "complete",
            records: values.map((value) => ({
              value,
              bodyAvailability: "available",
            })),
          },
        ],
      };
    },
    matches(unit, translation) {
      return unit.context.line === translation.context.sourceLine;
    },
  },
  completion: {
    criterion: "存在可用正文的实际译文",
    resolveCompletion({ translations }) {
      return translations.some(
        ({ bodyAvailability }) => bodyAvailability === "available",
      );
    },
  },
});
