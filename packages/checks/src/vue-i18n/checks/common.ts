import type {
  QualityCheckOutcome,
  QualityEvidence,
  QualityIssue,
  QualityLocation,
  QualityObject,
  TranslationUnitInput,
} from "@lioni/core";
import { defineChecker } from "@lioni/core";

import { readVueI18nPolicies } from "../dependencies.ts";
import {
  prepareVueI18nMessage,
  assertVueI18nPreparer,
  vueI18nMessageProjectionSchema,
  type VueI18nPreparer,
} from "../quality-projection.ts";
import type {
  VueI18nDataReader,
  VueI18nMessageProjection,
  VueI18nPolicy,
  VueI18nPolicyData,
  VueI18nPolicyRequirement,
} from "../quality-types.ts";

/** 策略和运行时工具仅在准备阶段使用；规则只接收消息及所需依据。 */
export function createVueI18nMessageCheck<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable = never,
  TPrepared = unknown,
  TId extends string = string,
>(options: {
  readonly id: TId;
  readonly version: string;
  readonly adapter?:
    | VueI18nPreparer<TUnit, TTranslation, TBody, TUnavailable>
    | undefined;
  readonly loadPolicies: VueI18nDataReader<
    TUnit,
    TTranslation,
    TBody,
    TUnavailable,
    readonly VueI18nPolicyData[]
  >;
  readonly policyRequirements: readonly VueI18nPolicyRequirement[];
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
    projection: VueI18nMessageProjection,
    prepared: TPrepared,
  ) => QualityCheckOutcome;
}) {
  assertVueI18nPreparer(options.adapter);
  const inputSchema: import("@lioni/core").StandardSchemaV1<{
    readonly projection: VueI18nMessageProjection;
    readonly prepared: TPrepared;
  }> = {
    "~standard": {
      version: 1,
      vendor: "lioni-vue-i18n",
      async validate(value) {
        if (
          !value ||
          typeof value !== "object" ||
          !("projection" in value) ||
          !("prepared" in value)
        )
          return { issues: [{ message: "Vue I18n 检查输入缺少消息或依据。" }] };
        const result = await vueI18nMessageProjectionSchema[
          "~standard"
        ].validate(value.projection);
        return result.issues
          ? { issues: result.issues }
          : {
              value: value as {
                projection: VueI18nMessageProjection;
                prepared: TPrepared;
              },
            };
      },
    },
  };
  return defineChecker.withTypes<TUnit, TTranslation, TBody, TUnavailable>()({
    id: options.id,
    version: options.version,
    inputSchema,
    load: async ({ facts, memo, qualityData }) =>
      readVueI18nPolicies(
        await qualityData.read(options.loadPolicies, facts, memo),
        options.policyRequirements,
      ),
    prepare: async (input) => {
      const policy = input.loaded.get(input.candidate.language);
      if (!policy) return { status: "not-applicable" };
      const prepared = await prepareVueI18nMessage(input, options.adapter);
      if (prepared.status !== "ready") return prepared;
      const projection = prepared.input;
      if (
        projection.key !== input.candidate.sourceKey ||
        projection.language !== input.candidate.language
      )
        return incompleteSelection(
          "messageProjectionIdentityMismatch",
          "消息准备结果的键或语言与本次候选不一致。",
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
      if (options.applies && !options.applies(projection, policy))
        return { status: "not-applicable" };
      return {
        status: "ready",
        input: {
          projection,
          prepared: options.prepare(projection, policy, input.memo),
        },
      };
    },
    check: ({ projection, prepared }) =>
      options.check(projection, prepared as TPrepared),
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
