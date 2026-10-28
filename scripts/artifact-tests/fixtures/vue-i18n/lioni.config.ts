import { readFile } from "node:fs/promises";

import { defineConfig, type StandardSchemaV1 } from "@lioni/core";
import {
  extractVueI18nUsages,
  prepareVueI18nQuality,
  type VueI18nMessageProjection,
} from "@lioni/vue-i18n";

type Unit = { readonly source: string };
const source = "Hello {name}";
const stringSchema = schema(
  (value): value is string => typeof value === "string",
);
const unitSchema = schema(
  (value): value is Unit =>
    typeof value === "object" &&
    value !== null &&
    "source" in value &&
    typeof value.source === "string",
);
const identity = (id: string) => ({ id, hostVersion: "artifact-consumer-v1" });

export function createConfig(target: string) {
  return defineConfig({
    source: {
      schema: unitSchema,
      read: () => ({
        scopes: [
          {
            range: "en.json",
            enumeration: "complete" as const,
            records: [
              { value: { source }, bodyAvailability: "available" as const },
            ],
          },
        ],
      }),
    },
    keyOf: () => "message",
    translations: {
      languages: ["zh-CN"],
      schema: stringSchema,
      contentSchema: stringSchema,
      contentOf: (translation) => translation,
      identityOf: () => ({ namespace: "messages", key: "message" }),
      matches: () => true,
      read: () => ({
        scopes: [
          {
            range: "zh-CN.json",
            enumeration: "complete" as const,
            covers: ["message"],
            records: [
              { value: target, bodyAvailability: "available" as const },
            ],
          },
        ],
      }),
    },
    quality: {
      prepare: () =>
        prepareVueI18nQuality<Unit, string, string>({
          project: ({ sourceUnit, candidate }) =>
            projection(sourceUnit?.unit.source, candidate.content),
          reference: ({ sourceUnit, translation }) =>
            projection(
              sourceUnit.unit.source,
              translation.bodyAvailability === "available"
                ? translation.content
                : undefined,
            ),
          policies: [
            {
              sourceLanguage: "en",
              targetLanguage: "zh-CN",
              resources: {
                source: { messages: { message: source }, range: "en.json" },
                target: { messages: { message: target }, range: "zh-CN.json" },
              },
              quantities: {
                source: { profile: "en" },
                target: { profile: "zh-CN" },
              },
              protectedLiterals: {},
              messageFamilies: {
                scopes: [],
                usageScopes: [],
                targetEquivalences: [],
              },
            },
          ],
          terms: { concepts: [] },
          usages: extractVueI18nUsages(
            '<template><p>{{ t("message", { name }) }}</p></template>',
            "Message.vue",
          ),
          identities: {
            sourceSyntax: identity("source-syntax"),
            targetSyntax: identity("target-syntax"),
            variableCorrespondence: identity("variables"),
            callArguments: identity("call-arguments"),
            linkTargetExists: identity("link-target"),
            linkCycle: identity("link-cycle"),
            protectedLiterals: identity("protected-literals"),
            quantities: identity("quantities"),
            allowedTerminology: identity("allowed-terminology"),
            forbiddenTerminology: identity("forbidden-terminology"),
            messageFamilyConsistency: identity("message-family"),
          },
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

function schema<T>(
  isValue: (value: unknown) => value is T,
): StandardSchemaV1<T, T> {
  return {
    "~standard": {
      version: 1,
      vendor: "artifact-consumer",
      validate: (value) =>
        isValue(value)
          ? { value }
          : { issues: [{ message: "消费者资料结构无效。" }] },
    },
  };
}
