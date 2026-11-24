import {
  defineChecker,
  type QualityFinding,
  type TranslationUnitInput,
} from "@lioni/core";
import { z } from "zod";

const subjectSchema = z.object({ key: z.string(), language: z.string() });
const sameTextInputSchema = subjectSchema
  .extend({
    source: z.string(),
    target: z.string(),
    sourceRange: z.unknown(),
    targetRange: z.unknown(),
  })
  .nullable();

/** 只检查是否提供了候选正文。空字符串也是已提供的译文。 */
export function createMissingTranslationChecker<
  TUnit extends TranslationUnitInput = TranslationUnitInput,
  TTranslation = unknown,
  TBody = unknown,
  TUnavailable = unknown,
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
  TUnavailable = unknown,
>() {
  return defineChecker.withTypes<TUnit, TTranslation, TBody, TUnavailable>()({
    id: "same-text",
    version: "checks.same-text/v1",
    inputSchema: sameTextInputSchema,
    prepare({ snapshot, sourceUnit, translation, candidate, association }) {
      if (candidate === null) {
        if (association.status !== "missing")
          throw new Error("无法读取候选正文以检查同文。");
        return null;
      }
      if (sourceUnit.bodyAvailability !== "available")
        throw new Error("无法读取原文正文以检查同文。");
      const source = sourceUnit.unit.source;
      const target = candidate.content;
      if (typeof source !== "string" || typeof target !== "string")
        throw new Error("无法取得原文或候选译文的字符串正文。");
      return {
        key: association.sourceKey,
        language: association.language,
        source,
        target,
        sourceRange:
          snapshot.source.read.scopes[sourceUnit.scopeIndex]?.range ?? null,
        targetRange: translation?.range ?? null,
      };
    },
    check(input): readonly QualityFinding[] {
      if (input === null || input.source !== input.target) return [];
      const object = {
        kind: "translation-unit",
        key: input.key,
        language: input.language,
      };
      const sourceLocation = {
        language: null,
        range: input.sourceRange,
        key: input.key,
      };
      const location = {
        key: input.key,
        language: input.language,
        range: input.targetRange,
      };
      return [
        {
          severity: "error",
          object,
          location,
          message: "译文与原文完全相同。",
          evidence: [
            {
              role: "source",
              object: { kind: "source-unit", key: input.key },
              location: sourceLocation,
              value: input.source,
            },
            {
              role: "target",
              object,
              location,
              value: input.target,
            },
          ],
        },
      ];
    },
  });
}
