import { readFile, writeFile } from "node:fs/promises";

import {
  defineConfig,
  type JsonValue,
  type UpdatePlanItem,
  type UpdatePolicy,
} from "@lioni/core";

import { isRecord, standardSchema } from "./schemas.ts";

export type Unit = {
  readonly id: string;
  readonly source: string;
  readonly context: {
    readonly file: string;
    readonly line: number;
    readonly screenshot: string;
  };
};
export type Translation = { readonly id: string; text: string };
const sourceSchema = standardSchema<Unit>(
  (value): value is Unit =>
    isRecord(value) &&
    typeof value.id === "string" &&
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
    typeof value.text === "string",
);
const contentSchema = standardSchema<string>(
  (value): value is string => typeof value === "string",
);
export const callbackCounts = { matches: 0, policy: 0, locate: 0, write: 0 };

const updatePolicy: UpdatePolicy<Unit, Translation, string> = ({
  current,
  comparisons,
  associations,
}) => {
  callbackCounts.policy += 1;
  const items: UpdatePlanItem<Unit, Translation, string>[] = [];
  for (const change of comparisons.sourceChanges) {
    if (change.status !== "modified" || change.current === undefined) continue;
    const sourceUnit = current.source.units.find(
      ({ key }) => key === change.key,
    );
    const association = associations.current.find(
      ({ sourceKey, language }) =>
        sourceKey === change.key && language === "fr",
    );
    const translationIndex = association?.translationIndexes[0];
    const translation = current.translations.records.find(
      ({ index }) => index === translationIndex,
    );
    const range =
      sourceUnit === undefined
        ? undefined
        : current.source.read.scopes[sourceUnit.scopeIndex]?.range;
    if (
      sourceUnit === undefined ||
      range === undefined ||
      association?.status !== "matched" ||
      translation?.bodyAvailability !== "available"
    )
      continue;
    const content = sourceUnit.unit.source;
    items.push({
      action: "write",
      sourceKey: sourceUnit.key,
      language: "fr",
      target: translation.identity,
      changes: {
        source: change,
        translations: [],
      },
      reason: "将当前原文写入已定位的目标译文。",
      after: { content },
      request: {
        operation: "write",
        target: { identity: translation.identity },
        content,
        expectedSource: {
          presence: "present",
          key: sourceUnit.key,
          unit: sourceUnit.unit,
          content,
          range: range as JsonValue,
        },
        expectedTarget: {
          status: "present",
          identity: translation.identity,
          content: translation.content,
          range: translation.range as JsonValue,
          record: translation.translation,
        },
      },
    });
  }
  return items;
};

export default defineConfig({
  source: {
    schema: sourceSchema,
    async read() {
      const units = JSON.parse(
        await readFile(
          new URL("./update-plan-resources/source.json", import.meta.url),
          "utf8",
        ),
      ) as Unit[];
      return {
        scopes: [
          {
            range: "update-plan-resources/source.json",
            enumeration: "complete",
            records: units.map((value) => ({
              value,
              bodyAvailability: "available" as const,
            })),
          },
        ],
      };
    },
  },
  keyOf: (unit) => unit.id,
  translations: {
    languages: ["fr"],
    identityOf: (translation) => ({
      namespace: "update-plan",
      key: translation.id,
    }),
    schema: translationSchema,
    contentSchema,
    contentOf: (translation) => translation.text,
    async read(_language, sourceUnits) {
      const translations = JSON.parse(
        await readFile(
          new URL("./update-plan-resources/fr.json", import.meta.url),
          "utf8",
        ),
      ) as Translation[];
      return {
        scopes: [
          {
            range: "update-plan-resources/fr.json",
            covers: sourceUnits.map(({ key }) => key),
            enumeration: "complete",
            records: translations.map((value) => ({
              value,
              bodyAvailability: "available" as const,
            })),
          },
        ],
      };
    },
    matches: (unit, translation) => {
      callbackCounts.matches += 1;
      return unit.id === translation.id;
    },
  },
  updatePolicy,
  translationWriteback: {
    locateExistingTarget: ({ translation }) => {
      callbackCounts.locate += 1;
      return {
        status: "located",
        locator: { id: translation.translation.id },
      };
    },
    locateNewTarget: () => ({
      status: "notWritable",
      reason: "此消费场景只更新现有译文。",
    }),
    async write({ request, target }) {
      callbackCounts.write += 1;
      if (request.operation !== "write" || typeof request.content !== "string")
        throw new TypeError("本消费场景只接收字符串译文写入请求。");
      const locator = target.locator;
      if (
        typeof locator !== "object" ||
        locator === null ||
        !("id" in locator) ||
        typeof locator.id !== "string"
      )
        throw new TypeError("译文定位缺少实际记录身份。");
      const path = new URL("./update-plan-resources/fr.json", import.meta.url);
      const translations = JSON.parse(
        await readFile(path, "utf8"),
      ) as Translation[];
      const translation = translations.find(({ id }) => id === locator.id);
      if (translation === undefined) throw new Error("实际译文记录已不存在。");
      translation.text = request.content;
      await writeFile(path, JSON.stringify(translations), "utf8");
    },
  },
});
