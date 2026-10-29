import { readFile } from "node:fs/promises";

import {
  createVueI18nChecks,
  defineConfig,
  type VueI18nMessageProjection,
  type VueI18nPolicy,
  type TermbaseData,
  type QualityException,
} from "@lioni/lioni";
import * as z from "zod";

const source = "Hello {name}";
const stringSchema = z.string();
const unitSchema = z.looseObject({ key: z.string(), source: z.string() });
const translationSchema = z.looseObject({ key: z.string(), text: z.string() });
type Unit = z.infer<typeof unitSchema>;
type Translation = z.infer<typeof translationSchema>;
export function createConfig(
  target: string,
  options: {
    readonly otherText?: string;
    readonly terms?: TermbaseData;
    readonly exceptions?: readonly QualityException[];
  } = {},
) {
  const policies: readonly VueI18nPolicy[] = [
    {
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      resources: {
        source: {
          messages: {
            message: source,
            ...(options.otherText === undefined ? {} : { other: "Other" }),
          },
          range: "en.json",
        },
        target: {
          messages: {
            message: target,
            ...(options.otherText === undefined
              ? {}
              : { other: options.otherText }),
          },
          range: "zh-CN.json",
        },
      },
      quantities: {
        source: { profile: "en" },
        target: { profile: "zh-CN" },
      },
      protectedLiterals: {},
      messageFamilies: { scopes: [], targetEquivalences: [] },
    },
  ];
  return defineConfig({
    source: {
      schema: unitSchema,
      read: () => ({
        scopes: [
          {
            range: "en.json",
            enumeration: "complete" as const,
            records: [
              {
                value: { key: "message", source },
                bodyAvailability: "available" as const,
              },
              ...(options.otherText === undefined
                ? []
                : [
                    {
                      value: { key: "other", source: "Other" },
                      bodyAvailability: "available" as const,
                    },
                  ]),
            ],
          },
        ],
      }),
    },
    keyOf: ({ key }) => key,
    translations: {
      languages: ["zh-CN"],
      schema: translationSchema,
      contentSchema: stringSchema,
      contentOf: ({ text }) => text,
      keyOf: ({ key }) => ({ namespace: "messages", key }),
      matches: (unit, translation) => unit.key === translation.key,
      read: () => ({
        scopes: [
          {
            range: "zh-CN.json",
            enumeration: "complete" as const,
            covers:
              options.otherText === undefined
                ? ["message"]
                : ["message", "other"],
            records: [
              {
                value: { key: "message", text: target },
                bodyAvailability: "available" as const,
              },
              ...(options.otherText === undefined
                ? []
                : [
                    {
                      value: { key: "other", text: options.otherText },
                      bodyAvailability: "available" as const,
                    },
                  ]),
            ],
          },
        ],
      }),
    },
    quality: {
      exceptionStore: {
        async load() {
          return options.exceptions ?? [];
        },
        async upsert() {
          throw new Error("制品验收只读取例外。");
        },
      },
      checks: createVueI18nChecks<Unit, Translation, string>({
        hostVersion: "artifact-consumer-v1",
        project: ({ sourceUnit, candidate }) =>
          projection(sourceUnit?.unit.source, candidate.content),
        reference: ({ sourceUnit, translation }) =>
          projection(
            sourceUnit.unit.source,
            translation.bodyAvailability === "available"
              ? translation.content
              : undefined,
          ),
      }),
      loadDependencies: () => ({
        vueI18n: { policies, terms: options.terms ?? { concepts: [] } },
      }),
    },
  });
}

export default createConfig(
  JSON.parse(
    await readFile(new URL("./target.json", import.meta.url), "utf8"),
  ) as string,
);

function projection(
  sourceText: string | undefined,
  targetText: string | undefined,
): VueI18nMessageProjection {
  return {
    key: "message",
    language: "zh-CN",
    source:
      sourceText === undefined
        ? { status: "absent" }
        : { status: "available", text: sourceText },
    target:
      targetText === undefined
        ? { status: "unavailable" }
        : { status: "available", text: targetText },
    locations: {
      source: { key: "message", language: null, range: "en.json" },
      target: { key: "message", language: "zh-CN", range: "zh-CN.json" },
    },
  };
}
