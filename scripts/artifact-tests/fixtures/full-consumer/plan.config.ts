import { readFile, writeFile } from "node:fs/promises";

import { defineConfig } from "@lioni/core";

import { isRecord, standardSchema } from "./schemas.ts";

type Unit = {
  readonly id: string;
  readonly source: string;
  readonly context: {
    readonly file: string;
    readonly line: number;
    readonly screenshot: string;
  };
};
type Translation = { readonly id: string; text: string };
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
              bodyAvailability: "available",
            })),
          },
        ],
      };
    },
  },
  keyOf: (unit) => unit.id,
  translations: {
    languages: ["fr"],
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
              bodyAvailability: "available",
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
  updatePolicy: ({ sourceKey, language, change, sourceUnit }) => {
    callbackCounts.policy += 1;
    return change === "changed"
      ? {
          action: "candidate",
          candidate: {
            sourceKey,
            language,
            content: sourceUnit?.source ?? "",
          },
          reason: "读取计划时生成的候选。",
        }
      : { action: "none", reason: "该项未由此计划处理。" };
  },
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
    dependencies: ({ sourceUnit }) => ({
      screenshot: sourceUnit.unit.context.screenshot,
    }),
    async write({ edit, target }) {
      callbackCounts.write += 1;
      if (typeof edit.content !== "string")
        throw new TypeError("候选译文必须是字符串。");
      const locator = target.locator;
      if (
        typeof locator !== "object" ||
        locator === null ||
        !("id" in locator) ||
        typeof locator.id !== "string"
      ) {
        throw new TypeError("译文定位缺少实际记录身份。");
      }
      const path = new URL("./update-plan-resources/fr.json", import.meta.url);
      const translations = JSON.parse(
        await readFile(path, "utf8"),
      ) as Translation[];
      const translation = translations.find(({ id }) => id === locator.id);
      if (translation === undefined) throw new Error("实际译文记录已不存在。");
      translation.text = edit.content;
      await writeFile(path, JSON.stringify(translations), "utf8");
    },
  },
});
