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
import { bindQualityCheck, snapshotJsonValue } from "@lioni/core";
import { z } from "zod";

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

const configurationSchema = z.object({ version: z.literal(1) });
type Configuration = z.output<typeof configurationSchema>;

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
  TPrepared,
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
  readonly prepare: (
    projection: VueI18nMessageProjection,
    policy: VueI18nPolicy,
    memo: import("@lioni/memo").MemoScope,
  ) => TPrepared;
  readonly check: (
    input: VueI18nMessageRuleInput<TUnit, TTranslation, TBody, TUnavailable>,
    policy: VueI18nPolicy,
    prepared: TPrepared,
  ) => QualityCheckOutcome;
};

/** 绑定共同消息投影、资源可用性和位置，具体规则只负责判断。 */
export function createVueI18nMessageCheck<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable = never,
  TPrepared = unknown,
>(
  options: VueI18nMessageRuleOptions<
    TUnit,
    TTranslation,
    TBody,
    TUnavailable,
    TPrepared
  >,
): QualityCheckDefinition<
  TUnit,
  TTranslation,
  QualityObject,
  TBody,
  TUnavailable
> {
  type Subject = {
    readonly projection: VueI18nMessageProjection;
    readonly policy: VueI18nPolicy;
    readonly prepared: TPrepared;
  };
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
      return {
        status: "selected",
        subject: {
          projection,
          policy,
          prepared: options.prepare(projection, policy, input.memo),
        },
      };
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
    ) => ({ status: "ready", value: input.subject.projection }),
    fingerprintInput: ({ projected, subject }) => ({
      projection: snapshotJsonValue(projected, "Vue I18n 检查投影"),
      dependencies: snapshotJsonValue(subject.prepared, "Vue I18n 检查依赖"),
    }),
    check: (input) =>
      options.check(
        { ...input, subject: input.subject.projection },
        input.subject.policy,
        input.subject.prepared,
      ),
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
