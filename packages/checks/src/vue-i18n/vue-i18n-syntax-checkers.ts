import type {
  QualityFinding,
  QualityCheckDefinition,
  QualityEvidence,
  QualityObject,
  TranslationUnitInput,
} from "@lioni/core";
import { defineChecker } from "@lioni/core";

import {
  assertVueI18nCallback,
  readVueI18nLanguagePolicies,
} from "./dependencies.ts";
import {
  prepareVueI18nMessage,
  assertVueI18nPreparer,
  type VueI18nPreparer,
  vueI18nMessageProjectionSchema,
} from "./quality-projection.ts";
import type {
  VueI18nDataReader,
  VueI18nLanguagePolicy,
  VueI18nMessageProjection,
} from "./quality-types.ts";
import { parseVueI18nMessage } from "./vue-i18n-messages.ts";
import { VUE_I18N_MESSAGE_COMPILER_VERSION } from "./vue-i18n-messages.ts";

export type VueI18nSourceSyntaxCheckerOptions<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable = never,
  TId extends string = string,
> = {
  readonly id: TId;
  readonly prepare?: VueI18nPreparer<TUnit, TTranslation, TBody, TUnavailable>;
  readonly loadLanguages?: VueI18nDataReader<
    TUnit,
    TTranslation,
    TBody,
    TUnavailable,
    readonly VueI18nLanguagePolicy[]
  >;
};

export type VueI18nTargetSyntaxCheckerOptions<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable = never,
  TId extends string = string,
> = VueI18nSourceSyntaxCheckerOptions<
  TUnit,
  TTranslation,
  TBody,
  TUnavailable,
  TId
>;

/** 按候选对应的共同消息投影检查原文语法。 */
export function createVueI18nSourceSyntaxChecker<
  TUnit extends TranslationUnitInput = TranslationUnitInput,
  TTranslation = unknown,
  TBody = unknown,
  TUnavailable = never,
>(): QualityCheckDefinition<
  TUnit,
  TTranslation,
  QualityObject,
  TBody,
  TUnavailable,
  "vue-i18n/source-syntax"
>;
export function createVueI18nSourceSyntaxChecker<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable = never,
  const TId extends string = string,
>(
  options: VueI18nSourceSyntaxCheckerOptions<
    TUnit,
    TTranslation,
    TBody,
    TUnavailable,
    TId
  >,
): QualityCheckDefinition<
  TUnit,
  TTranslation,
  QualityObject,
  TBody,
  TUnavailable,
  TId
>;
export function createVueI18nSourceSyntaxChecker<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable = never,
  TId extends string = string,
>(
  options?: VueI18nSourceSyntaxCheckerOptions<
    TUnit,
    TTranslation,
    TBody,
    TUnavailable,
    TId
  >,
) {
  assertVueI18nPreparer(options?.prepare);
  assertVueI18nCallback(options?.loadLanguages, "loadLanguages");
  return defineChecker.withTypes<TUnit, TTranslation, TBody, TUnavailable>()({
    id: options?.id ?? "vue-i18n/source-syntax",
    version: `checks.vue-i18n/source-syntax/v2+@intlify/message-compiler@${VUE_I18N_MESSAGE_COMPILER_VERSION}`,
    inputSchema: vueI18nMessageProjectionSchema,
    load: async ({ snapshot, memo, qualityData }) =>
      options?.loadLanguages
        ? readVueI18nLanguagePolicies(
            await qualityData.read(options?.loadLanguages, snapshot, memo),
          )
        : null,
    prepare: async (input) => {
      if (
        input.loaded !== null &&
        !input.loaded.has(input.association.language)
      )
        return null;
      const projection = await prepareVueI18nMessage(input, options?.prepare);
      if (projection === null) return null;
      if (projection.source.status === "absent") return null;
      if (
        projection.source.status === "unavailable" ||
        input.sourceUnit.bodyAvailability !== "available"
      )
        throw new Error("原文正文不可用，无法检查 Vue I18n 语法。");
      return projection;
    },
    check: (input) => {
      if (input === null) return [];
      const text = input.source;
      if (text.status !== "available") throw new Error("原文正文不可用。");
      return syntaxOutcome("source", input, text.text);
    },
  });
}

/** 按候选正文检查目标语法，允许原文正文不可用。 */
export function createVueI18nTargetSyntaxChecker<
  TUnit extends TranslationUnitInput = TranslationUnitInput,
  TTranslation = unknown,
  TBody = unknown,
  TUnavailable = never,
>(): QualityCheckDefinition<
  TUnit,
  TTranslation,
  QualityObject,
  TBody,
  TUnavailable,
  "vue-i18n/target-syntax"
>;
export function createVueI18nTargetSyntaxChecker<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable = never,
  const TId extends string = string,
>(
  options: VueI18nTargetSyntaxCheckerOptions<
    TUnit,
    TTranslation,
    TBody,
    TUnavailable,
    TId
  >,
): QualityCheckDefinition<
  TUnit,
  TTranslation,
  QualityObject,
  TBody,
  TUnavailable,
  TId
>;
export function createVueI18nTargetSyntaxChecker<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable = never,
  TId extends string = string,
>(
  options?: VueI18nTargetSyntaxCheckerOptions<
    TUnit,
    TTranslation,
    TBody,
    TUnavailable,
    TId
  >,
) {
  assertVueI18nPreparer(options?.prepare);
  assertVueI18nCallback(options?.loadLanguages, "loadLanguages");
  return defineChecker.withTypes<TUnit, TTranslation, TBody, TUnavailable>()({
    id: options?.id ?? "vue-i18n/target-syntax",
    version: `checks.vue-i18n/target-syntax/v2+@intlify/message-compiler@${VUE_I18N_MESSAGE_COMPILER_VERSION}`,
    inputSchema: vueI18nMessageProjectionSchema,
    load: async ({ snapshot, memo, qualityData }) =>
      options?.loadLanguages
        ? readVueI18nLanguagePolicies(
            await qualityData.read(options?.loadLanguages, snapshot, memo),
          )
        : null,
    prepare: async (input) => {
      if (
        input.loaded !== null &&
        !input.loaded.has(input.association.language)
      )
        return null;
      const projection = await prepareVueI18nMessage(input, options?.prepare);
      if (projection === null) return null;
      if (projection.target.status === "missing") return null;
      if (projection.target.status === "unavailable")
        throw new Error("目标消息正文不可用，Vue I18n 检查未执行。");
      return projection;
    },
    check: (input) => {
      if (input === null) return [];
      const text = input.target;
      if (text.status !== "available") throw new Error("目标消息正文不可用。");
      return syntaxOutcome("target", input, text.text);
    },
  });
}

function syntaxOutcome(
  side: "source" | "target",
  projection: VueI18nMessageProjection,
  text: string,
): readonly QualityFinding[] {
  const parsed = parseVueI18nMessage(text);
  const location = projection.locations[side];
  const object: QualityObject = {
    kind: side === "source" ? "source-unit" : "translation-unit",
    key: projection.key,
    ...(side === "target" ? { language: projection.language } : {}),
  };
  return parsed.errors.map((error) => {
    const range = error.range ?? { start: 0, end: 0 };
    const findingLocation = { ...location, span: range };
    const evidence: readonly QualityEvidence[] = [
      {
        role: `${side}-message`,
        object,
        location: findingLocation,
        value: text,
      },
      {
        role: "syntax-error",
        object,
        location: findingLocation,
        value: error,
      },
    ];
    return {
      severity: "error" as const,
      object,
      location: findingLocation,
      message: `${side === "source" ? "原文" : "译文"}不符合 Vue I18n 消息语法：${error.message}。`,
      evidence,
    };
  });
}
