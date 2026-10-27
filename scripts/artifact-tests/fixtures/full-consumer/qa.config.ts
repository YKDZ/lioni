import { readFile } from "node:fs/promises";

import { createNumberChecker } from "@lioni/checks";
import { defineConfig, type FrameworkFacts } from "@lioni/core";

import { isRecord, standardSchema } from "./schemas.ts";

type Unit = {
  readonly source: string;
  readonly nativeId: string;
  readonly context: { readonly file: string; readonly line: number };
};
type Translation = {
  readonly sourceId: string;
  readonly nativeKey: string;
  readonly text: string;
};
const sourceSchema = standardSchema<Unit>(
  (value): value is Unit =>
    isRecord(value) &&
    typeof value.source === "string" &&
    typeof value.nativeId === "string" &&
    isRecord(value.context) &&
    typeof value.context.file === "string" &&
    typeof value.context.line === "number",
);
const translationSchema = standardSchema<Translation>(
  (value): value is Translation =>
    isRecord(value) &&
    typeof value.sourceId === "string" &&
    typeof value.nativeKey === "string" &&
    typeof value.text === "string",
);
const contentSchema = standardSchema<string>(
  (value): value is string => typeof value === "string",
);

async function readMessageResource() {
  return JSON.parse(await readFile("qa-messages.json", "utf8")) as {
    readonly messages: readonly Translation[];
  };
}

const checks = [
  createNumberChecker<Unit, Translation, Unit, string, string, never>({
    hostVersion: "full-consumer-v1",
    select: ({ sourceUnit, candidate }) => {
      if (sourceUnit === null)
        return {
          status: "incomplete",
          issue: {
            code: "sourceUnavailable",
            message: "找不到对应原文。",
          },
        };
      if (sourceUnit.bodyAvailability !== "available")
        return {
          status: "incomplete",
          issue: {
            code: "sourceUnavailable",
            message: "原文正文不可用。",
          },
        };
      if (typeof candidate.content !== "string")
        return {
          status: "incomplete",
          issue: {
            code: "textUnavailable",
            message: "候选正文不是字符串。",
          },
        };
      return {
        status: "selected",
        subject: {
          sourceUnit,
          sourceKey: candidate.sourceKey,
          language: candidate.language,
          content: candidate.content,
        },
      };
    },
    sourceText: (unit) => unit.source,
    translationText: (content) => content,
    sourceLocation: (unit, _subject, range) => ({
      ...range,
      key: String(unit.context.line),
    }),
    translationLocation: (translation, subject, range) => ({
      ...range,
      key: translation?.nativeKey ?? subject.key,
    }),
  }),
];

function createRequest(facts: FrameworkFacts<Unit, Translation, string>) {
  const association = facts.associations.find(
    ({ sourceKey, language, status }) =>
      sourceKey === "sha256:save" && language === "fr" && status === "matched",
  );
  const record =
    association === undefined
      ? undefined
      : facts.translations.records[association.translationIndexes[0] as number];
  return {
    candidates:
      record?.bodyAvailability !== "available"
        ? []
        : [
            {
              sourceKey: "sha256:save",
              language: "fr",
              content: record.content,
            },
          ],
    dependencies: {},
  };
}

export default defineConfig({
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
                source: "Hello 12 and 3.14",
                nativeId: "save",
                context: { file: "src/messages.ts", line: 18 },
              },
              bodyAvailability: "available",
            },
            {
              value: {
                source: "Save",
                nativeId: "submit",
                context: { file: "src/messages.ts", line: 19 },
              },
              bodyAvailability: "available",
            },
          ],
        },
      ],
    }),
  },
  keyOf: (unit) => "sha256:" + unit.nativeId,
  translations: {
    languages: ["fr"],
    identityOf: (translation) => ({
      namespace: "qa-messages",
      key: translation.nativeKey,
    }),
    schema: translationSchema,
    contentSchema,
    contentOf: (translation) => translation.text,
    async read(_language, sourceUnits) {
      const resource = await readMessageResource();
      return {
        scopes: [
          {
            range: "locales/fr.json",
            covers: sourceUnits.map(({ key }) => key),
            enumeration: "complete",
            records: resource.messages.map((value) => ({
              value,
              bodyAvailability: "available",
            })),
          },
        ],
      };
    },
    matches: (unit, translation) => unit.nativeId === translation.sourceId,
  },
  quality: {
    prepare(facts) {
      return { checks, request: createRequest(facts) };
    },
  },
});
