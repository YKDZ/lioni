import type {
  QualityFinding,
  QualityEvidence,
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
  ) => readonly QualityFinding[];
}) {
  assertVueI18nPreparer(options.adapter);
  const inputSchema: import("@lioni/core").StandardSchemaV1<{
    readonly projection: VueI18nMessageProjection;
    readonly prepared: TPrepared;
  } | null> = {
    "~standard": {
      version: 1,
      vendor: "lioni-vue-i18n",
      async validate(value) {
        if (value === null) return { value: null };
        if (
          !value ||
          typeof value !== "object" ||
          !("projection" in value) ||
          value.projection === null ||
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
    load: async ({ snapshot, memo, qualityData }) =>
      readVueI18nPolicies(
        await qualityData.read(options.loadPolicies, snapshot, memo),
        options.policyRequirements,
      ),
    prepare: async (input) => {
      const policy = input.loaded.get(input.association.language);
      if (!policy) return null;
      const projection = await prepareVueI18nMessage(input, options.adapter);
      if (projection === null) return null;
      if (options.requiresTarget) {
        if (projection.target.status === "missing") return null;
        if (projection.target.status === "unavailable")
          throw new Error("目标消息正文不可用，检查未执行。");
      }
      if (options.requiresSource) {
        if (projection.source.status === "absent") return null;
        if (
          projection.source.status === "unavailable" ||
          input.sourceUnit.bodyAvailability !== "available"
        )
          throw new Error("原文正文不可用，检查未执行。");
      }
      if (
        options.targetMustContainText &&
        (projection.target.status !== "available" ||
          !projection.target.text.trim())
      )
        return null;
      if (options.applies && !options.applies(projection, policy)) return null;
      return {
        projection,
        prepared: options.prepare(projection, policy, input.memo),
      };
    },
    check: (input) =>
      input === null
        ? []
        : options.check(input.projection, input.prepared as TPrepared),
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
