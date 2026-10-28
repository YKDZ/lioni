import type {
  QualityCheckOutcome,
  QualityCheckProjectionInput,
  QualityEvidence,
  QualityObject,
  TranslationUnitInput,
} from "@lioni/core";
import { bindQualityCheck } from "@lioni/core";
import type { MemoScope } from "@lioni/memo";
import * as v from "valibot";

import { memoizedVueI18nMessage } from "./message-memo.ts";
import {
  memoizedVueI18nProjection,
  vueI18nMessageProjectionSchema,
} from "./quality-projection.ts";
import type {
  VueI18nMessageProjection,
  VueI18nPolicy,
  VueI18nProjector,
} from "./quality-types.ts";
import { VUE_I18N_MESSAGE_COMPILER_VERSION } from "./vue-i18n-messages.ts";

const configurationSchema = v.object({ compilerVersion: v.string() });
type Configuration = v.InferOutput<typeof configurationSchema>;

const configuration: Configuration = {
  compilerVersion: VUE_I18N_MESSAGE_COMPILER_VERSION,
};

export type VueI18nSourceSyntaxCheckerOptions<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable = never,
> = {
  readonly id?: string;
  readonly hostVersion: string;
  readonly project: VueI18nProjector<TUnit, TTranslation, TBody, TUnavailable>;
  readonly policies?: ReadonlyMap<string, VueI18nPolicy>;
};

export type VueI18nTargetSyntaxCheckerOptions<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable = never,
> = VueI18nSourceSyntaxCheckerOptions<TUnit, TTranslation, TBody, TUnavailable>;

/** 按候选对应的共同消息投影检查原文语法。 */
export function createVueI18nSourceSyntaxChecker<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable = never,
>(
  options: VueI18nSourceSyntaxCheckerOptions<
    TUnit,
    TTranslation,
    TBody,
    TUnavailable
  >,
) {
  type Subject = VueI18nMessageProjection;
  return bindQualityCheck<
    TUnit,
    TTranslation,
    typeof configurationSchema,
    typeof vueI18nMessageProjectionSchema,
    Subject,
    QualityObject,
    TBody,
    TUnavailable
  >({
    id: options.id ?? "vue-i18n/source-syntax",
    version: `checks.vue-i18n/source-syntax/v1+@intlify/message-compiler@${VUE_I18N_MESSAGE_COMPILER_VERSION}+${options.hostVersion}`,
    configurationSchema,
    configuration,
    inputSchema: vueI18nMessageProjectionSchema,
    select: async (input) => {
      if (
        options.policies !== undefined &&
        !options.policies.has(input.candidate.language)
      )
        return { status: "not-applicable" };
      const projection = await memoizedVueI18nProjection(
        input,
        options.project,
      );
      if (projection.target.status === "missing")
        return { status: "not-applicable" };
      if (projection.target.status === "unavailable")
        return incompleteSelection(
          "candidateBodyUnavailable",
          "目标消息正文不可用，Vue I18n 检查未执行。",
        );
      if (projection.source.status === "absent")
        return { status: "not-applicable" };
      if (projection.source.status === "unavailable")
        return incompleteSelection(
          "sourceUnavailable",
          "原文正文不可用，无法检查 Vue I18n 语法。",
        );
      return { status: "selected", subject: projection };
    },
    project: (
      input: QualityCheckProjectionInput<
        TUnit,
        TTranslation,
        Configuration,
        Subject,
        TBody,
        TUnavailable
      >,
    ) => ({ status: "ready", value: input.subject }),
    check: (input) => {
      const text = input.projected.source;
      if (text.status !== "available")
        return incompleteOutcome("sourceUnavailable", "原文正文不可用。");
      return syntaxOutcome("source", input.projected, text.text, input.memo);
    },
  });
}

/** 按候选正文检查目标语法，允许没有原文记录的目标键。 */
export function createVueI18nTargetSyntaxChecker<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable = never,
>(
  options: VueI18nTargetSyntaxCheckerOptions<
    TUnit,
    TTranslation,
    TBody,
    TUnavailable
  >,
) {
  type Subject = VueI18nMessageProjection;
  return bindQualityCheck<
    TUnit,
    TTranslation,
    typeof configurationSchema,
    typeof vueI18nMessageProjectionSchema,
    Subject,
    QualityObject,
    TBody,
    TUnavailable
  >({
    id: options.id ?? "vue-i18n/target-syntax",
    version: `checks.vue-i18n/target-syntax/v1+@intlify/message-compiler@${VUE_I18N_MESSAGE_COMPILER_VERSION}+${options.hostVersion}`,
    configurationSchema,
    configuration,
    inputSchema: vueI18nMessageProjectionSchema,
    select: async (input) => {
      if (
        options.policies !== undefined &&
        !options.policies.has(input.candidate.language)
      )
        return { status: "not-applicable" };
      const projection = await memoizedVueI18nProjection(
        input,
        options.project,
      );
      if (projection.target.status === "missing")
        return { status: "not-applicable" };
      if (projection.target.status === "unavailable")
        return incompleteSelection(
          "candidateBodyUnavailable",
          "目标消息正文不可用，Vue I18n 检查未执行。",
        );
      return { status: "selected", subject: projection };
    },
    project: (
      input: QualityCheckProjectionInput<
        TUnit,
        TTranslation,
        Configuration,
        Subject,
        TBody,
        TUnavailable
      >,
    ) => ({ status: "ready", value: input.subject }),
    check: (input) => {
      const text = input.projected.target;
      if (text.status !== "available")
        return incompleteOutcome("targetUnavailable", "目标消息正文不可用。");
      return syntaxOutcome("target", input.projected, text.text, input.memo);
    },
  });
}

function syntaxOutcome(
  side: "source" | "target",
  projection: VueI18nMessageProjection,
  text: string,
  memo: MemoScope,
): QualityCheckOutcome {
  const parsed = memoizedVueI18nMessage(text, memo);
  const location = projection.locations[side];
  const object: QualityObject = {
    kind: side === "source" ? "source-unit" : "translation-unit",
    key: projection.key,
    ...(side === "target" ? { language: projection.language } : {}),
  };
  return completeOutcome(
    parsed.errors.map((error) => {
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
    }),
  );
}

function completeOutcome(
  diagnostics: QualityCheckOutcome["diagnostics"],
): QualityCheckOutcome {
  return {
    status: "complete",
    diagnostics,
    issues: [],
    coverage: {
      selected: 1,
      evaluated: 1,
      notApplicable: 0,
      incomplete: 0,
      failed: 0,
    },
  };
}

function incompleteOutcome(code: string, message: string): QualityCheckOutcome {
  return {
    status: "incomplete",
    diagnostics: [],
    issues: [{ code, message }],
    coverage: {
      selected: 1,
      evaluated: 0,
      notApplicable: 0,
      incomplete: 1,
      failed: 0,
    },
  };
}

function incompleteSelection(code: string, message: string) {
  return { status: "incomplete" as const, issue: { code, message } };
}
