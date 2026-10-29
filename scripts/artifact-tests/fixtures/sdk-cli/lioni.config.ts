import { readFile } from "node:fs/promises";

import { createNumberChecker, defineConfig } from "@lioni/lioni";
import * as z from "zod";

const bodySchema = z.union([z.string(), z.looseObject({ text: z.string() })]);
const unitSchema = z.looseObject({ id: z.string(), source: bodySchema });
const translationSchema = z.looseObject({ id: z.string(), body: bodySchema });
type Body = z.infer<typeof bodySchema>;
type Unit = z.infer<typeof unitSchema>;
type Translation = z.infer<typeof translationSchema>;
const textOf = (body: Body): string =>
  typeof body === "string" ? body : body.text;

// 同一公开配置组合字符串和对象正文，验证发布声明仍允许宿主定义资源形态。
const units: Unit[] = [
  { id: "catalog", source: "Save 2 files" },
  { id: "guide", source: { text: "Read 3 pages" } },
];
const numbers = createNumberChecker<Unit, Translation, Unit, Body, Body>({
  hostVersion: "artifact-consumer/v1",
  fingerprintInput: ({ projected }) => projected,
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
    schema: unitSchema,
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
    schema: translationSchema,
    contentSchema: bodySchema,
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
