import type {
  QualityCheckDefinition,
  QualityObject,
  TranslationUnitInput,
} from "@lioni/core";

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
import type { VueI18nChecksOptions } from "./quality-types.ts";
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
>(
  options: VueI18nChecksOptions<TUnit, TTranslation, TBody, TUnavailable>,
): readonly QualityCheckDefinition<
  TUnit,
  TTranslation,
  QualityObject,
  TBody,
  TUnavailable
>[] {
  const identity = (id: string) => ({
    id,
    hostVersion: options.hostVersion,
  });
  const analysis = createVueI18nAnalysis();

  return [
    createVueI18nSourceSyntaxChecker({
      id: "vue-i18n/source-syntax",
      hostVersion: options.hostVersion,
      project: options.project,
    }),
    createVueI18nTargetSyntaxChecker({
      id: "vue-i18n/target-syntax",
      hostVersion: options.hostVersion,
      project: options.project,
    }),
    createVueI18nVariableCorrespondenceChecker({
      id: "vue-i18n/variable-correspondence",
      hostVersion: options.hostVersion,
      project: options.project,
    }),
    createLinkTargetExistsCheck({
      identity: identity("vue-i18n/link-target-exists"),
      project: options.project,
    }),
    createLinkCycleCheck({
      identity: identity("vue-i18n/link-cycle"),
      project: options.project,
    }),
    createProtectedLiteralCheck({
      identity: identity("vue-i18n/protected-literals"),
      project: options.project,
    }),
    createQuantityCheck({
      identity: identity("vue-i18n/quantities"),
      project: options.project,
    }),
    ...createVueI18nTerminologyChecks({
      project: options.project,
      analysis,
      identities: {
        allowedTerminology: identity("terminology/require-allowed-translation"),
        forbiddenTerminology: identity(
          "terminology/reject-forbidden-translation",
        ),
      },
    }),
    createVueI18nMessageFamilyCheck({
      project: options.project,
      reference: options.reference,
      analysis,
      identity: identity("message-family-consistency"),
    }),
  ];
}
