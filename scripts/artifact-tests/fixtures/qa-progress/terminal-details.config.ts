import { appendFileSync, existsSync } from "node:fs";

import { defineChecker, defineConfig, type QualityFinding } from "@lioni/lioni";
import * as z from "zod";

import { baseConfig, type LocaleRecord, type Unit } from "./lioni.config.ts";

const detailsCheck = defineChecker.withTypes<
  Unit,
  LocaleRecord,
  string,
  never
>()({
  id: "details-check",
  version: "1",
  inputSchema: z.object({ key: z.string(), language: z.string() }),
  prepare: ({ association }) => ({
    key: association.sourceKey,
    language: association.language,
  }),
  check(subject): readonly QualityFinding[] {
    const location = { ...subject, range: `${subject.language}.json` };
    const object = { kind: "translation-unit", ...subject };
    if (subject.key === "greeting") {
      return [
        {
          severity: "warning",
          object,
          location,
          message: "问候语建议更自然（警告一）。",
          evidence: [],
        },
        {
          severity: "error",
          object,
          location,
          message: "问候语缺少称谓占位（错误一）。",
          evidence: [],
        },
      ];
    }
    if (subject.key === "button") {
      return [
        {
          severity: "warning",
          object,
          location,
          message: "按钮文案偏长（警告二）。",
          evidence: [],
        },
        {
          severity: "error",
          object,
          location,
          message: "按钮文案禁止含标点（错误二）。",
          evidence: [],
        },
      ];
    }
    if (subject.key === "brand") {
      return [
        {
          severity: "info",
          object,
          location,
          message: "品牌大小写提示（提示一）。",
          evidence: [],
        },
      ];
    }
    return [];
  },
});

const extraInfoCheck = defineChecker.withTypes<
  Unit,
  LocaleRecord,
  string,
  never
>()({
  id: "extra-info",
  version: "1",
  inputSchema: z.object({ key: z.string(), language: z.string() }),
  prepare: ({ association }) => ({
    key: association.sourceKey,
    language: association.language,
  }),
  check(subject): readonly QualityFinding[] {
    if (subject.key !== "brand") return [];
    return [
      {
        severity: "info",
        object: { kind: "translation-unit", ...subject },
        location: { ...subject, range: `${subject.language}.json` },
        message: "附加术语提示。",
        evidence: [],
      },
    ];
  },
});

export default defineConfig({
  ...baseConfig,
  source: {
    ...baseConfig.source,
    async read() {
      if (existsSync(new URL("./.track-reads", import.meta.url))) {
        appendFileSync(
          new URL("./.qa-reads.log", import.meta.url),
          "source:read\n",
          "utf8",
        );
      }
      return await baseConfig.source.read();
    },
  },
  quality: {
    checks: [detailsCheck, extraInfoCheck],
  },
});
