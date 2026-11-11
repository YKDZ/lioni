import type { TranslationUnitInput } from "@lioni/core";
import type { TermbaseData } from "@lioni/terminology";

import { createVueI18nAnalysis } from "./analysis.ts";
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
import { missingVueI18nData } from "./dependencies.ts";
import type { VueI18nChecksOptions } from "./quality-types.ts";
import type {
  VueI18nLanguagePolicy,
  VueI18nPolicyData,
} from "./quality-types.ts";
import {
  createVueI18nSourceSyntaxChecker,
  createVueI18nTargetSyntaxChecker,
} from "./vue-i18n-syntax-checkers.ts";
import { createVueI18nVariableCorrespondenceChecker } from "./vue-i18n-variable-checker.ts";

/** 创建可直接放入 quality.checks 的 Vue I18n 消息检查集合。 */
export function createVueI18nChecks<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable = never,
>(options: VueI18nChecksOptions<TUnit, TTranslation, TBody, TUnavailable>) {
  const loadLanguages =
    options.loadLanguages ??
    missingVueI18nData<readonly VueI18nLanguagePolicy[]>(
      "Vue I18n 语言策略读取器",
    );
  const loadPolicies =
    options.loadPolicies ??
    missingVueI18nData<readonly VueI18nPolicyData[]>("Vue I18n 检查策略读取器");
  const messagePreparation =
    options.prepare === undefined ? {} : { prepare: options.prepare };
  const loadTerms =
    options.loadTerms ??
    missingVueI18nData<TermbaseData>("Vue I18n 术语库读取器");
  const identity = <const TId extends string>(id: TId) => ({ id });
  const analysis = createVueI18nAnalysis();

  return [
    createVueI18nSourceSyntaxChecker({
      id: "vue-i18n/source-syntax",
      ...messagePreparation,
      loadLanguages,
    }),
    createVueI18nTargetSyntaxChecker({
      id: "vue-i18n/target-syntax",
      ...messagePreparation,
      loadLanguages,
    }),
    createVueI18nVariableCorrespondenceChecker({
      id: "vue-i18n/variable-correspondence",
      ...messagePreparation,
      loadLanguages,
    }),
    createLinkTargetExistsCheck({
      identity: identity("vue-i18n/link-target-exists"),
      ...messagePreparation,
      loadPolicies,
    }),
    createLinkCycleCheck({
      identity: identity("vue-i18n/link-cycle"),
      ...messagePreparation,
      loadPolicies,
    }),
    createProtectedLiteralCheck({
      identity: identity("vue-i18n/protected-literals"),
      ...messagePreparation,
      loadPolicies,
    }),
    createQuantityCheck({
      identity: identity("vue-i18n/quantities"),
      ...messagePreparation,
      loadPolicies,
    }),
    ...createVueI18nTerminologyChecks({
      ...messagePreparation,
      analysis,
      loadLanguages,
      loadTerms,
      identities: {
        allowedTerminology: identity("terminology/require-allowed-translation"),
        forbiddenTerminology: identity(
          "terminology/reject-forbidden-translation",
        ),
      },
    }),
    createVueI18nMessageFamilyCheck({
      ...messagePreparation,
      loadPolicies,
      reference: options.reference,
      analysis,
      identity: identity("message-family-consistency"),
    }),
  ] as const;
}
