import { existsSync } from "node:fs";

import {
  createMissingTranslationChecker,
  createSameTextChecker,
  defineChecker,
  defineConfig,
  type QualityFinding,
} from "@boringparts/lioni";
import * as z from "zod";

import { baseConfig, type LocaleRecord, type Unit } from "./lioni.config.ts";

const conditionalNote = defineChecker.withTypes<
  Unit,
  LocaleRecord,
  string,
  never
>()({
  id: "conditional-note",
  version: "1",
  inputSchema: z.object({ key: z.string(), language: z.string() }),
  prepare: ({ association }) => ({
    key: association.sourceKey,
    language: association.language,
  }),
  check(subject): readonly QualityFinding[] {
    if (
      existsSync(new URL("./.emit-conditional-note", import.meta.url)) &&
      subject.key === "greeting" &&
      subject.language === "de"
    ) {
      return [
        {
          severity: "info",
          object: { kind: "translation-unit", ...subject },
          location: { ...subject, range: "de.json" },
          message: "条件性提示诊断。",
          evidence: [],
        },
      ];
    }
    return [];
  },
});

export default defineConfig({
  ...baseConfig,
  translations: {
    ...baseConfig.translations,
    languages: ["fr", "de"],
  },
  quality: {
    checks: [
      createMissingTranslationChecker<Unit, LocaleRecord, string>(),
      createSameTextChecker<Unit, LocaleRecord, string>(),
      conditionalNote,
    ],
  },
});
