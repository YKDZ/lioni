import type {
  QualityCheckDefinition,
  QualityCheckInput,
  QualityCheckOutcome,
  QualityCheckProjectionInput,
  QualityCheckRuleInput,
  QualityCheckSelection,
  QualityEvidence,
  QualityIssue,
  QualityLocation,
  QualityObject,
  TranslationUnitInput,
} from "@lioni/core";
import { bindQualityCheck } from "@lioni/core";
import * as v from "valibot";

import { vueI18nDependencies } from "../dependencies.ts";
import {
  memoizedVueI18nProjection,
  vueI18nMessageProjectionSchema,
} from "../quality-projection.ts";
import type {
  VueI18nMessageProjection,
  VueI18nPolicy,
  VueI18nProjector,
} from "../quality-types.ts";

const configurationSchema = v.object({ version: v.literal(1) });
type Configuration = v.InferOutput<typeof configurationSchema>;

export type VueI18nMessageRuleInput<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
> = QualityCheckRuleInput<
  TUnit,
  TTranslation,
  Configuration,
  VueI18nMessageProjection,
  VueI18nMessageProjection,
  TBody,
  TUnavailable
>;

export type VueI18nMessageRuleOptions<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
> = {
  readonly id: string;
  readonly version: string;
  readonly project: VueI18nProjector<TUnit, TTranslation, TBody, TUnavailable>;
  readonly requiresSource: boolean;
  readonly requiresTarget: boolean;
  readonly targetMustContainText?: boolean;
  readonly applies?: (
    projection: VueI18nMessageProjection,
    policy: VueI18nPolicy,
  ) => boolean;
  readonly check: (
    input: VueI18nMessageRuleInput<TUnit, TTranslation, TBody, TUnavailable>,
    policy: VueI18nPolicy,
  ) => QualityCheckOutcome;
};

/** 绑定共同消息投影、资源可用性和位置，具体规则只负责判断。 */
export function createVueI18nMessageCheck<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable = never,
>(
  options: VueI18nMessageRuleOptions<TUnit, TTranslation, TBody, TUnavailable>,
): QualityCheckDefinition<
  TUnit,
  TTranslation,
  QualityObject,
  TBody,
  TUnavailable
> {
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
    id: options.id,
    version: options.version,
    configurationSchema,
    configuration: { version: 1 },
    inputSchema: vueI18nMessageProjectionSchema,
    select: async (
      input: QualityCheckInput<
        TUnit,
        TTranslation,
        Configuration,
        TBody,
        TUnavailable
      >,
    ): Promise<QualityCheckSelection<Subject>> => {
      const policy = vueI18nDependencies(input).policies.get(
        input.candidate.language,
      );
      if (policy === undefined) return { status: "not-applicable" };
      const projection = await memoizedVueI18nProjection(
        input,
        options.project,
      );
      if (
        projection.key !== input.candidate.sourceKey ||
        projection.language !== input.candidate.language
      )
        return incompleteSelection(
          "messageProjectionIdentityMismatch",
          "消息投影的键或语言与本次候选不一致。",
        );
      if (options.requiresTarget) {
        if (projection.target.status === "missing")
          return { status: "not-applicable" };
        if (projection.target.status === "unavailable")
          return incompleteSelection(
            "targetUnavailable",
            "目标消息正文不可用，检查未执行。",
          );
      }
      if (options.requiresSource) {
        if (projection.source.status === "absent")
          return { status: "not-applicable" };
        if (projection.source.status === "unavailable")
          return incompleteSelection(
            "sourceUnavailable",
            "原文正文不可用，检查未执行。",
          );
      }
      if (
        options.targetMustContainText &&
        (projection.target.status !== "available" ||
          !projection.target.text.trim())
      )
        return { status: "not-applicable" };
      if (options.applies !== undefined && !options.applies(projection, policy))
        return { status: "not-applicable" };
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
    check: (
      input: QualityCheckRuleInput<
        TUnit,
        TTranslation,
        Configuration,
        Subject,
        VueI18nMessageProjection,
        TBody,
        TUnavailable
      >,
    ) => {
      const policy = vueI18nDependencies(input).policies.get(
        input.projected.language,
      );
      if (policy === undefined)
        return incompleteOutcome([
          issue(
            "languagePolicyUnavailable",
            `未声明 ${input.projected.language} 的 Vue I18n 策略。`,
            input.projected,
          ),
        ]);
      return options.check(input, policy);
    },
  });
}

export function sourceObject(key: string): QualityObject {
  return { kind: "source-unit", key };
}

export function translationObject(
  projection: VueI18nMessageProjection,
  code?: string,
): QualityObject {
  return {
    kind: "translation-unit",
    key: projection.key,
    language: projection.language,
    ...(code === undefined ? {} : { code }),
  };
}

export function messageLocation(
  projection: VueI18nMessageProjection,
  span?: { readonly start: number; readonly end: number },
): QualityLocation {
  return {
    ...projection.locations.target,
    ...(span === undefined ? {} : { span }),
  };
}

export function completeOutcome(
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

export function incompleteOutcome(
  issues: readonly QualityIssue[],
  diagnostics: QualityCheckOutcome["diagnostics"] = [],
): QualityCheckOutcome {
  return {
    status: "incomplete",
    diagnostics,
    issues,
    coverage: {
      selected: 1,
      evaluated: 0,
      notApplicable: 0,
      incomplete: 1,
      failed: 0,
    },
  };
}

export function issue(
  code: string,
  message: string,
  projection: VueI18nMessageProjection,
): QualityIssue {
  return {
    code,
    message,
    object: translationObject(projection),
    location: projection.locations.target,
  };
}

export function finding(
  projection: VueI18nMessageProjection,
  code: string,
  message: string,
  span: { readonly start: number; readonly end: number },
  evidence: readonly QualityEvidence[],
) {
  return {
    severity: "error" as const,
    object: translationObject(projection, code),
    location: messageLocation(projection, span),
    message,
    evidence,
  };
}

function incompleteSelection(code: string, message: string) {
  return {
    status: "incomplete" as const,
    issue: { code, message },
  };
}
