import { readFile } from "node:fs/promises";

import {
  compareNumberText,
  createNumberChecker,
  defineConfig,
  type CheckerPrepareInput,
  type NumberCheckerOptions,
  type NumberCheckerPreparation,
  type NumberTextInput,
} from "@lioni/lioni";
import * as z from "zod";

const bodySchema = z.union([z.string(), z.looseObject({ text: z.string() })]);
const unitSchema = z.looseObject({ id: z.string(), source: bodySchema });
const translationSchema = z.looseObject({ id: z.string(), body: bodySchema });
type Body = z.infer<typeof bodySchema>;
type Unit = z.infer<typeof unitSchema>;
type Translation = z.infer<typeof translationSchema>;
const textOf = (body: Body): string =>
  typeof body === "string" ? body : body.text;

const numberPreparation = (
  input: CheckerPrepareInput<Unit, Translation, Body, never>,
): NumberCheckerPreparation => ({
  status: "ready",
  source: textOf(input.sourceUnit.unit.source),
  target: textOf(input.candidate.content),
});
const numberOptions: NumberCheckerOptions<Unit, Translation, Body, never> = {
  prepare: numberPreparation,
};
const directNumberInput: NumberTextInput = {
  source: "Use 2 files",
  target: "Utiliser 2 fichiers",
  subject: { key: "catalog", language: "fr" },
  sourceLocation: { language: null, range: "source" },
  targetLocation: { language: "fr", range: "fr.json", key: "catalog" },
  targetContent: { text: "Utiliser 2 fichiers" },
};
if (compareNumberText(directNumberInput).status !== "complete")
  throw new Error("直接数字比较应当完成。");

// 同一公开配置组合字符串和对象正文，验证发布声明仍允许宿主定义资源形态。
const units: Unit[] = [
  { id: "catalog", source: "Save 2 files" },
  { id: "guide", source: { text: "Read 3 pages" } },
];
export function createConfig() {
  const numbers = createNumberChecker.withTypes<
    Unit,
    Translation,
    Body,
    never
  >()(numberOptions);

  return defineConfig({
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
      keyOf: (translation) => translation.id,
      schema: translationSchema,
      contentSchema: bodySchema,
      contentOf: (translation) => translation.body,

      async read(language, sourceUnits) {
        const values = JSON.parse(
          await readFile(
            new URL(`./${language}.json`, import.meta.url),
            "utf8",
          ),
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
}

export default createConfig();
