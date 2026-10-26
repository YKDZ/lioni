import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  defineConfig,
  type JsonValue,
  type UpdatePlanItem,
  type UpdatePolicy,
} from "@lioni/core";

import { isRecord, standardSchema } from "./schemas.ts";

type SourceUnit = { id: string; source: string };
type TargetTranslation = {
  targetId: string;
  sourceId: string;
  text: string;
  path: string;
  writePath?: string;
};

const sourceSchema = standardSchema<SourceUnit>(
  (value): value is SourceUnit =>
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.source === "string",
);
const translationSchema = standardSchema<TargetTranslation>(
  (value): value is TargetTranslation =>
    isRecord(value) &&
    typeof value.targetId === "string" &&
    typeof value.sourceId === "string" &&
    typeof value.text === "string" &&
    typeof value.path === "string" &&
    (value.writePath === undefined || typeof value.writePath === "string"),
);
const contentSchema = standardSchema<string>(
  (value): value is string => typeof value === "string",
);
const sourcePath = fileURLToPath(
  new URL("./resume-resources/source.json", import.meta.url),
);
const targetPath = (id: string) =>
  fileURLToPath(new URL(`./resume-resources/fr/${id}.json`, import.meta.url));

const updatePolicy: UpdatePolicy<SourceUnit, TargetTranslation, string> = ({
  current,
  comparisons,
  associations,
}) => {
  const items: UpdatePlanItem<SourceUnit, TargetTranslation, string>[] = [];
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

    const base = {
      sourceKey: sourceUnit.key,
      language: "fr",
      target: translation.identity,
      changes: { source: change, translations: [] },
    };
    const content = "更新译文 " + sourceUnit.key;
    if (translation.content === content) {
      items.push({
        ...base,
        action: "retain",
        reason: "当前译文已是本次计划的目标内容，保留已完成项。",
      });
      continue;
    }
    items.push({
      ...base,
      action: "write",
      reason: "更新已确认变化的译文。",
      after: { content },
      request: {
        operation: "write",
        target: { identity: translation.identity },
        content,
        expectedSource: {
          presence: "present",
          key: sourceUnit.key,
          unit: sourceUnit.unit,
          content: sourceUnit.unit.source,
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
      const records = JSON.parse(
        await readFile(sourcePath, "utf8"),
      ) as SourceUnit[];
      return {
        scopes: [
          {
            range: "resume-resources/source.json",
            enumeration: "complete",
            records: records.map((value) => ({
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
            TargetTranslation,
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
  updatePolicy,
  translationWriteback: {
    locateExistingTarget: ({ translation }) => ({
      status: "located",
      locator: {
        path: translation.translation.writePath ?? translation.translation.path,
      },
    }),
    locateNewTarget: () => ({
      status: "notWritable",
      reason: "此场景只修改已有译文。",
    }),
    async write({ request, target, currentTranslation }) {
      if (
        request.operation !== "write" ||
        typeof request.content !== "string" ||
        currentTranslation === undefined
      )
        throw new TypeError("恢复场景需要现有译文和字符串写入请求。");
      const locator = target.locator;
      if (!isRecord(locator) || typeof locator.path !== "string")
        throw new TypeError("恢复场景的目标定位缺少资源路径。");
      const value = JSON.parse(
        await readFile(currentTranslation.translation.path, "utf8"),
      ) as Record<string, unknown>;
      value.text = request.content;
      await writeFile(locator.path, JSON.stringify(value) + "\n", "utf8");
    },
  },
});
