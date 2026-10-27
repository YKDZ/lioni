export {
  parseVueI18nMessage,
  VUE_I18N_MESSAGE_COMPILER_VERSION,
} from "./vue-i18n-messages.ts";
export type {
  VueI18nLinkFact,
  VueI18nMessage,
  VueI18nMessageBranch,
  VueI18nSyntaxError,
} from "./vue-i18n-messages.ts";
export {
  createVueI18nSourceSyntaxChecker,
  createVueI18nTargetSyntaxChecker,
} from "./vue-i18n-syntax-checkers.ts";
export type {
  VueI18nSourceSyntaxCheckerOptions,
  VueI18nTargetSyntaxCheckerOptions,
} from "./vue-i18n-syntax-checkers.ts";
export { createVueI18nVariableCorrespondenceChecker } from "./vue-i18n-variable-checker.ts";
export type { VueI18nVariableCorrespondenceCheckerOptions } from "./vue-i18n-variable-checker.ts";
export {
  createVueI18nTextRecognizer,
  createVueI18nAnalysis,
} from "./analysis.ts";
export { extractVueI18nUsages } from "./usages.ts";
export type { VueI18nUsage, VueI18nUsageIndex } from "./usage-types.ts";
export { prepareVueI18nQuality } from "./quality-checks.ts";
export type {
  VueI18nCheckIdentities,
  VueI18nCheckIdentity,
  VueI18nCheckName,
  VueI18nMessageProjection,
  VueI18nMessageReference,
  VueI18nPolicy,
  VueI18nProjector,
  VueI18nProjectionInput,
  VueI18nQuantityPolicy,
  VueI18nQualityDependencies,
  VueI18nQualityOptions,
  VueI18nQualityPreparation,
  VueI18nReferenceProjector,
  VueI18nScopeRule,
  VueI18nSourceMessage,
  VueI18nTargetMessage,
  VueI18nUsageScopeRule,
} from "./quality-types.ts";
