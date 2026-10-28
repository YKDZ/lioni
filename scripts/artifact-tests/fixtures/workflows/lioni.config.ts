import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  defaultUpdatePolicy,
  defineConfig,
  type StandardSchemaV1,
  type UpdatePolicy,
  type UpdatePlanItem,
} from "lioni";

export type Unit = { id: string; source: string };
export type Translation = { id: string; text: string; writePath?: string };
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
function schema<T>(
  accepts: (value: unknown) => value is T,
): StandardSchemaV1<T, T> {
  return {
    "~standard": {
      version: 1,
      vendor: "workflow-consumer",
      validate: (value) =>
        accepts(value)
          ? { value }
          : { issues: [{ message: "工作流数据无效。" }] },
    },
  };
}
const sourceUrl = new URL("./source.json", import.meta.url);
const targetsUrl = new URL("./fr/", import.meta.url);
const targetPath = (id: string) =>
  fileURLToPath(new URL(`${id}.json`, targetsUrl));

const updatePolicy: UpdatePolicy<Unit, Translation, string> = async (input) => {
  // 删除沿用正式默认策略；更新为测试宿主提供的确定性译文。
  const items: UpdatePlanItem<Unit, Translation, string>[] = (
    await defaultUpdatePolicy(input)
  ).filter(({ action }) => action === "delete");
  for (const change of input.comparisons.sourceChanges) {
    if (change.status !== "modified") continue;
    const source = input.current.source.units.find(
      ({ key }) => key === change.key,
    );
    const target = input.current.translations.records.find(
      ({ translation }) => translation.id === change.key,
    );
    if (source === undefined || target?.bodyAvailability !== "available")
      continue;
    const content = `更新译文 ${source.key}`;
    const base = {
      sourceKey: source.key,
      language: "fr",
      target: target.identity,
      changes: { source: change, translations: [] },
    };
    items.push(
      target.content === content
        ? { ...base, action: "retain", reason: "保留此前已完成的写入。" }
        : {
            ...base,
            action: "write",
            reason: "更新变化的原文。",
            after: { content },
            request: {
              operation: "write",
              target: { identity: target.identity },
              content,
              expectedSource: {
                presence: "present",
                key: source.key,
                unit: source.unit,
                content: source.unit.source,
                range: "source.json",
              },
              expectedTarget: {
                status: "present",
                identity: target.identity,
                content: target.content,
                range: "fr",
                record: target.translation,
              },
            },
          },
    );
  }
  return items;
};

export default defineConfig({
  source: {
    schema: schema<Unit>(
      (value): value is Unit =>
        isRecord(value) &&
        typeof value.id === "string" &&
        typeof value.source === "string",
    ),
    async read() {
      const values = JSON.parse(await readFile(sourceUrl, "utf8")) as Unit[];
      return {
        scopes: [
          {
            range: "source.json",
            enumeration: "complete",
            records: values.map((value) => ({
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
    schema: schema<Translation>(
      (value): value is Translation =>
        isRecord(value) &&
        typeof value.id === "string" &&
        typeof value.text === "string" &&
        (value.writePath === undefined || typeof value.writePath === "string"),
    ),
    contentSchema: schema(
      (value): value is string => typeof value === "string",
    ),
    identityOf: (translation) => ({ namespace: "files", key: translation.id }),
    contentOf: (translation) => translation.text,
    matches: (unit, translation) => unit.id === translation.id,
    async read(_language, sourceUnits) {
      const files = (await readdir(targetsUrl))
        .filter((file) => file.endsWith(".json"))
        .sort();
      const values = await Promise.all(
        files.map(
          async (file) =>
            JSON.parse(
              await readFile(new URL(file, targetsUrl), "utf8"),
            ) as Translation,
        ),
      );
      return {
        scopes: [
          {
            range: "fr",
            enumeration: "complete",
            covers: sourceUnits.map(({ key }) => key),
            records: values.map((value) => ({
              value,
              bodyAvailability: "available" as const,
            })),
          },
        ],
      };
    },
  },
  updatePolicy,
  translationWriteback: {
    locateExistingTarget: ({ translation }) => ({
      status: "located",
      locator:
        translation.translation.writePath ??
        targetPath(translation.translation.id),
    }),
    locateNewTarget: () => ({
      status: "notWritable",
      reason: "此工作流只修改现有译文。",
    }),
    async write({ request, target, currentTranslation }) {
      if (
        typeof target.locator !== "string" ||
        currentTranslation === undefined
      )
        throw new TypeError("写回需要现有文件的定位。");
      if (request.operation === "delete") await rm(target.locator);
      else
        await writeFile(
          target.locator,
          JSON.stringify({
            ...currentTranslation.translation,
            text: request.content,
          }),
        );
    },
  },
});
