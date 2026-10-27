import type {
  QualityCheckDefinition,
  QualityObject,
  JsonValue,
  TranslationUnitInput,
} from "@lioni/core";
import { snapshotJsonValue } from "@lioni/core";

import { createVueI18nAnalysis } from "./analysis.ts";
import { createCallArgumentCheck } from "./checks/calls.ts";
import {
  createLinkCycleCheck,
  createLinkTargetExistsCheck,
} from "./checks/links.ts";
import {
  createProtectedLiteralCheck,
  createQuantityCheck,
} from "./checks/quantities-and-literals.ts";
import {
  createVueI18nMessageFamilyCheck,
  createVueI18nTerminologyChecks,
} from "./checks/terminology-families.ts";
import type {
  VueI18nPolicy,
  VueI18nQualityOptions,
  VueI18nQualityPreparation,
} from "./quality-types.ts";
import type {
  VueI18nCheckName,
  VueI18nQualityDependencies,
} from "./quality-types.ts";
import {
  createVueI18nSourceSyntaxChecker,
  createVueI18nTargetSyntaxChecker,
} from "./vue-i18n-syntax-checkers.ts";
import { createVueI18nVariableCorrespondenceChecker } from "./vue-i18n-variable-checker.ts";

/**
 * 绑定 Vue I18n 规则及其不可变 JSON 依据；候选沿用 core 本次 facts 的默认投影。
 */
export function prepareVueI18nQuality<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable = never,
>(
  options: VueI18nQualityOptions<TUnit, TTranslation, TBody, TUnavailable>,
): VueI18nQualityPreparation<TUnit, TTranslation, TBody, TUnavailable> {
  const basis = freezeJson(
    snapshotJsonValue(
      {
        policies: options.policies,
        terms: options.terms,
        usages: options.usages,
      },
      "Vue I18n 质量规则依赖",
    ),
  ) as unknown as VueI18nQualityDependencies;
  const policies = new Map(
    basis.policies.map((policy) => [policy.targetLanguage, policy]),
  );
  if (policies.size !== basis.policies.length)
    throw new TypeError("Vue I18n 策略的目标语言必须唯一。");

  const identity = (name: VueI18nCheckName) => options.identities[name];
  const analysis = createVueI18nAnalysis();
  const checks: QualityCheckDefinition<
    TUnit,
    TTranslation,
    QualityObject,
    TBody,
    TUnavailable
  >[] = [
    createVueI18nSourceSyntaxChecker({
      id: identity("sourceSyntax").id,
      hostVersion: identity("sourceSyntax").hostVersion,
      project: options.project,
      policies,
    }),
    createVueI18nTargetSyntaxChecker({
      id: identity("targetSyntax").id,
      hostVersion: identity("targetSyntax").hostVersion,
      project: options.project,
      policies,
    }),
    createVueI18nVariableCorrespondenceChecker({
      id: identity("variableCorrespondence").id,
      hostVersion: identity("variableCorrespondence").hostVersion,
      project: options.project,
      policies,
    }),
    createCallArgumentCheck({
      identity: identity("callArguments"),
      project: options.project,
      policies,
      usages: basis.usages,
    }),
    createLinkTargetExistsCheck({
      identity: identity("linkTargetExists"),
      project: options.project,
      policies,
    }),
    createLinkCycleCheck({
      identity: identity("linkCycle"),
      project: options.project,
      policies,
    }),
    createProtectedLiteralCheck({
      identity: identity("protectedLiterals"),
      project: options.project,
      policies,
    }),
    createQuantityCheck({
      identity: identity("quantities"),
      project: options.project,
      policies,
    }),
    ...createVueI18nTerminologyChecks({
      project: options.project,
      policies,
      terms: basis.terms,
      analysis,
      identities: {
        allowedTerminology: identity("allowedTerminology"),
        forbiddenTerminology: identity("forbiddenTerminology"),
      },
    }),
    createVueI18nMessageFamilyCheck({
      project: options.project,
      reference: options.reference,
      policies,
      usages: basis.usages,
      analysis,
      identity: identity("messageFamilyConsistency"),
    }),
  ];

  return {
    checks,
    request: {
      dependencies: Object.freeze({ vueI18n: basis }),
    },
  };
}

export type { VueI18nPolicy };

function freezeJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    for (const item of value) freezeJson(item);
  } else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) freezeJson(item);
  }
  return Object.freeze(value);
}
