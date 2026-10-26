import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { defineConfig } from "@lioni/core";

import { isRecord, standardSchema } from "./schemas.ts";

type Unit = { id: string; source: string };
type Translation = {
  targetId: string;
  sourceId: string;
  text: string;
  path: string;
};
const sourceSchema = standardSchema<Unit>(
  (value): value is Unit =>
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.source === "string",
);
const translationSchema = standardSchema<Translation>(
  (value): value is Translation =>
    isRecord(value) &&
    typeof value.targetId === "string" &&
    typeof value.sourceId === "string" &&
    typeof value.text === "string" &&
    typeof value.path === "string",
);
const contentSchema = standardSchema<string>(
  (value): value is string => typeof value === "string",
);

const sourcePath = fileURLToPath(
  new URL("./resume-resources/source.json", import.meta.url),
);
const targetPath = (id: string) =>
  fileURLToPath(
    new URL("./resume-resources/fr/" + id + ".json", import.meta.url),
  );

export default defineConfig({
  source: {
    schema: sourceSchema,
    async read() {
      const records = JSON.parse(await readFile(sourcePath, "utf8")) as Unit[];
      return {
        scopes: [
          {
            range: "resume-resources/source.json",
            enumeration: "complete",
            records: records.map((value) => ({
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
    identityOf: (translation) => ({
      namespace: "resume-targets",
      key: translation.targetId,
    }),
    schema: translationSchema,
    contentSchema,
    contentOf: (translation) => translation.text,
    async read(_language, sourceUnits) {
      const records = await Promise.all(
        sourceUnits.map(async ({ unit }) => {
          const path = targetPath(unit.id);
          const value = JSON.parse(await readFile(path, "utf8")) as Omit<
            Translation,
            "path"
          >;
          return {
            value: { ...value, path },
            bodyAvailability: "available" as const,
          };
        }),
      );
      return {
        scopes: [
          {
            range: "resume-resources/fr",
            covers: sourceUnits.map(({ key }) => key),
            enumeration: "complete",
            records,
          },
        ],
      };
    },
    matches: (unit, translation) => unit.id === translation.sourceId,
  },
  updatePolicy: ({ sourceKey, language, change }) =>
    change === "changed"
      ? process.argv[2] === "replan-retain" && sourceKey === "C"
        ? { action: "retain", reason: "保留当前译文并处理本次变化。" }
        : {
            action: "candidate",
            candidate: {
              sourceKey,
              language,
              content: "更新译文 " + sourceKey,
            },
          }
      : { action: "none" },
  translationWriteback: {
    locateExistingTarget: ({ translation }) => ({
      status: "located",
      locator: { path: translation.translation.path },
    }),
    locateNewTarget: () => ({
      status: "notWritable",
      reason: "此场景只修改已有译文。",
    }),
    async write({ edit, currentTranslation }) {
      if (currentTranslation === undefined || typeof edit.content !== "string")
        throw new TypeError("恢复场景需要字符串候选和现有译文。");
      const value = JSON.parse(
        await readFile(currentTranslation.translation.path, "utf8"),
      ) as Record<string, unknown>;
      value.text = edit.content;
      await writeFile(
        currentTranslation.translation.path,
        JSON.stringify(value) + "\n",
        "utf8",
      );
    },
  },
});
