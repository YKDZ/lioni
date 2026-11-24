import { defineChecker, defineConfig, type QualityFinding } from "@lioni/lioni";
import * as z from "zod";

import { baseConfig, type LocaleRecord, type Unit } from "./lioni.config.ts";

const toneA = defineChecker.withTypes<Unit, LocaleRecord, string, never>()({
  id: "tone-a",
  version: "1",
  inputSchema: z.object({ key: z.string(), language: z.string() }),
  prepare: ({ association }) => ({
    key: association.sourceKey,
    language: association.language,
  }),
  check(subject): readonly QualityFinding[] {
    if (subject.key === "button") {
      // 同一对象产生多条诊断并引用 brand 作跨消息证据，验证只扣一项且不连带扣减 brand。
      return (["info", "warning"] as const).map((severity) => ({
        severity,
        object: { kind: "translation-unit", ...subject },
        location: { ...subject, range: `${subject.language}.json` },
        message: `待复核（${severity}）。`,
        evidence: [
          {
            role: "reference",
            object: {
              kind: "translation-unit",
              key: "brand",
              language: subject.language,
            },
            location: {
              language: subject.language,
              range: `${subject.language}.json`,
              key: "brand",
            },
            value: "Lioni",
          },
        ],
      }));
    }
    if (subject.key === "greeting") {
      return [
        {
          severity: "info",
          object: { kind: "translation-unit", ...subject },
          location: { ...subject, range: `${subject.language}.json` },
          message: "建议润色。",
          evidence: [],
        },
      ];
    }
    return [];
  },
});

const toneB = defineChecker.withTypes<Unit, LocaleRecord, string, never>()({
  id: "tone-b",
  version: "1",
  inputSchema: z.object({ key: z.string(), language: z.string() }),
  prepare: ({ association }) => ({
    key: association.sourceKey,
    language: association.language,
  }),
  check(subject): readonly QualityFinding[] {
    if (subject.key === "button") {
      return [
        {
          severity: "error",
          object: { kind: "translation-unit", ...subject },
          location: { ...subject, range: `${subject.language}.json` },
          message: "必须修复按钮文案。",
          evidence: [],
        },
      ];
    }
    return [];
  },
});

export default defineConfig({
  ...baseConfig,
  quality: {
    checks: [toneA, toneB],
  },
});
