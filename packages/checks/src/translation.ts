import {
  defineChecker,
  type QualityFinding,
  type TranslationUnitInput,
} from "@lioni/core";
import { z } from "zod";

const subjectSchema = z.object({ key: z.string(), language: z.string() });

/** 只检查是否提供了候选正文。空字符串也是已提供的译文。 */
export function createMissingTranslationChecker<
  TUnit extends TranslationUnitInput = TranslationUnitInput,
  TTranslation = unknown,
  TBody = unknown,
  TUnavailable = never,
>() {
  return defineChecker.withTypes<TUnit, TTranslation, TBody, TUnavailable>()({
    id: "missing-translation",
    version: "checks.missing-translation/v1",
    inputSchema: subjectSchema.nullable(),
    prepare({ candidate, association }) {
      if (candidate !== null) return null;
      if (association.status !== "missing")
        throw new Error("缺少可靠的译文读取依据，无法判断是否缺译。");
      return { key: association.sourceKey, language: association.language };
    },
    check(subject): readonly QualityFinding[] {
      if (subject === null) return [];
      return [
        {
          severity: "error",
          object: { kind: "translation-unit", ...subject },
          location: { ...subject, range: null },
          message: "尚未提供译文。",
          evidence: [],
        },
      ];
    },
  });
}

/** 仅对字符串正文执行精确比较，保留空格、大小写和 Unicode 表示差异。 */
export function createSameTextChecker<
  TUnit extends TranslationUnitInput = TranslationUnitInput,
  TTranslation = unknown,
  TBody = unknown,
  TUnavailable = never,
>() {
  return defineChecker.withTypes<TUnit, TTranslation, TBody, TUnavailable>()({
    id: "same-text",
    version: "checks.same-text/v1",
    inputSchema: subjectSchema
      .extend({ source: z.string(), target: z.string() })
      .nullable(),
    prepare({ sourceUnit, candidate, association }) {
      if (candidate === null) {
        if (association.status !== "missing")
          throw new Error("无法读取候选正文以检查同文。");
        return null;
      }
      if (sourceUnit.bodyAvailability !== "available")
        throw new Error("无法读取原文正文以检查同文。");
      const source = sourceUnit.unit.source;
      const target = candidate.content;
      if (typeof source !== "string" || typeof target !== "string") return null;
      return {
        key: association.sourceKey,
        language: association.language,
        source,
        target,
      };
    },
    check(input): readonly QualityFinding[] {
      if (input === null || input.source !== input.target) return [];
      const object = {
        kind: "translation-unit",
        key: input.key,
        language: input.language,
      };
      const location = {
        key: input.key,
        language: input.language,
        range: null,
      };
      return [
        {
          severity: "error",
          object,
          location,
          message: "译文与原文完全相同。",
          evidence: [
            { role: "same-text", object, location, value: input.target },
          ],
        },
      ];
    },
  });
}
