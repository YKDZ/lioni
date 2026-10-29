import { readFile } from "node:fs/promises";

import {
  createNumberChecker,
  defineConfig,
  type StandardSchemaV1,
} from "@lioni/lioni";

type Body = string | { text: string };
type Unit = { id: string; source: Body };
type Translation = { id: string; body: Body };
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isBody = (value: unknown): value is Body =>
  typeof value === "string" ||
  (isRecord(value) && typeof value.text === "string");
const textOf = (body: Body): string =>
  typeof body === "string" ? body : body.text;
function schema<T>(
  accepts: (value: unknown) => value is T,
): StandardSchemaV1<T, T> {
  return {
    "~standard": {
      version: 1,
      vendor: "artifact-consumer",
      validate: (value) =>
        accepts(value)
          ? { value }
          : { issues: [{ message: "消费项目数据无效。" }] },
    },
  };
}

// 同一公开配置组合字符串和对象正文，验证发布声明仍允许宿主定义资源形态。
const units: Unit[] = [
  { id: "catalog", source: "Save 2 files" },
  { id: "guide", source: { text: "Read 3 pages" } },
];
const numbers = createNumberChecker<Unit, Translation, Unit, Body, Body>({
  hostVersion: "artifact-consumer/v1",
  select: ({ sourceUnit, candidate }) =>
    sourceUnit?.bodyAvailability === "available"
      ? {
          status: "selected",
          subject: {
            sourceUnit,
            sourceKey: candidate.sourceKey,
            language: candidate.language,
            content: candidate.content,
          },
        }
      : { status: "not-applicable" },
  sourceText: (unit) => textOf(unit.source),
  translationText: textOf,
});

export default defineConfig({
  source: {
    schema: schema<Unit>(
      (value): value is Unit =>
        isRecord(value) && typeof value.id === "string" && isBody(value.source),
    ),
    read: () => ({
      scopes: [
        {
          range: "source",
          enumeration: "complete",
          records: units.map((value) => ({
            value,
            bodyAvailability: "available",
          })),
        },
      ],
    }),
  },
  keyOf: (unit) => unit.id,
  translations: {
    languages: ["fr", "de"],
    keyOf: (translation) => ({
      namespace: "catalog",
      key: translation.id,
    }),
    schema: schema<Translation>(
      (value): value is Translation =>
        isRecord(value) && typeof value.id === "string" && isBody(value.body),
    ),
    contentSchema: schema(isBody),
    contentOf: (translation) => translation.body,
    matches: (unit, translation) => unit.id === translation.id,
    async read(language, sourceUnits) {
      const values = JSON.parse(
        await readFile(new URL(`./${language}.json`, import.meta.url), "utf8"),
      ) as Translation[];
      return {
        scopes: [
          {
            range: `${language}.json`,
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
  quality: { checks: [numbers] },
});
