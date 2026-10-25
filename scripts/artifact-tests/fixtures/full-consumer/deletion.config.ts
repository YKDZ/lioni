import { readFile, writeFile } from "node:fs/promises";

import { defineConfig } from "@lioni/core";

import { isRecord, standardSchema } from "./schemas.ts";

type Unit = { id: string; source: string; context: { file: string } };
type Translation = {
  id: string;
  text: string;
  context: { file: string; key: string; readonly?: boolean };
};
type Resource = {
  enumeration: "complete" | "partial" | "failed";
  records: Translation[];
};
const sourceSchema = standardSchema<Unit>(
  (value): value is Unit =>
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.source === "string" &&
    isRecord(value.context) &&
    typeof value.context.file === "string",
);
const translationSchema = standardSchema<Translation>(
  (value): value is Translation =>
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.text === "string" &&
    isRecord(value.context) &&
    typeof value.context.file === "string" &&
    typeof value.context.key === "string" &&
    (value.context.readonly === undefined ||
      typeof value.context.readonly === "boolean"),
);
const contentSchema = standardSchema<string>(
  (value): value is string => typeof value === "string",
);
const sourcePath = new URL("./deletion-resources/source.json", import.meta.url);
const targetPath = new URL("./deletion-resources/fr.json", import.meta.url);
const otherTargetPath = new URL(
  "./deletion-resources/other.json",
  import.meta.url,
);
const dependencyPath = new URL(
  "./deletion-resources/dependencies.json",
  import.meta.url,
);

export default defineConfig({
  source: {
    schema: sourceSchema,
    async read() {
      const units = JSON.parse(await readFile(sourcePath, "utf8")) as Unit[];
      return {
        scopes: [
          {
            range: "deletion-resources/source.json",
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
    schema: translationSchema,
    contentSchema,
    contentOf: (translation) => translation.text,
    async read(_language, sourceUnits) {
      const [resource, otherResource] = await Promise.all([
        readFile(targetPath, "utf8").then(
          (value) => JSON.parse(value) as Resource,
        ),
        readFile(otherTargetPath, "utf8").then(
          (value) => JSON.parse(value) as Resource,
        ),
      ]);
      const covers = sourceUnits.map(({ key }) => key);
      return {
        scopes: [
          {
            range: "deletion-resources/fr.json",
            covers,
            enumeration: resource.enumeration,
            records: resource.records.map((value) => ({
              value,
              bodyAvailability: "available" as const,
            })),
          },
          {
            range: "deletion-resources/other.json",
            covers,
            enumeration: otherResource.enumeration,
            records: otherResource.records.map((value) => ({
              value,
              bodyAvailability: "available" as const,
            })),
          },
        ],
      };
    },
    matches: (unit, translation) => unit.id === translation.id,
  },
  updatePolicy: ({ change }) =>
    change === "source-removed"
      ? { action: "delete", reason: "清理已移除原文的目标译文。" }
      : { action: "none" },
  translationWriteback: {
    locateExistingTarget: ({ translation }) =>
      translation.translation.context.readonly
        ? { status: "notWritable", reason: "其他资源中的目标为只读。" }
        : {
            status: "located",
            locator: {
              file: translation.translation.context.file,
              key: translation.translation.context.key,
            },
          },
    locateNewTarget: () => ({
      status: "notWritable",
      reason: "删除场景不创建目标。",
    }),
    async dependencies() {
      return JSON.parse(await readFile(dependencyPath, "utf8")) as {
        revision: number;
      };
    },
    async write({ edit, target }) {
      if (edit.operation !== "delete" || target.kind !== "existing")
        throw new TypeError("该宿主场景只执行删除语义编辑。");
      const locator = target.locator;
      if (
        typeof locator !== "object" ||
        locator === null ||
        !("key" in locator) ||
        typeof locator.key !== "string"
      )
        throw new TypeError("删除目标缺少宿主资源键。");
      const resource = JSON.parse(
        await readFile(targetPath, "utf8"),
      ) as Resource;
      const index = resource.records.findIndex(
        ({ context }) => context.key === locator.key,
      );
      if (index < 0) throw new Error("宿主明确的删除目标已不存在。");
      if (
        process.argv[2] === "apply" &&
        process.argv[3] === "physical-target-remains"
      ) {
        const record = resource.records[index];
        if (record === undefined) throw new Error("宿主删除目标读取失败。");
        record.id = "detached-message";
        await writeFile(targetPath, JSON.stringify(resource) + "\n", "utf8");
        return;
      }
      resource.records.splice(index, 1);
      await writeFile(targetPath, JSON.stringify(resource) + "\n", "utf8");
    },
  },
});
