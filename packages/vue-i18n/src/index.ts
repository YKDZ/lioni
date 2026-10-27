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
  VueI18nSourceSyntaxSubject,
  VueI18nTargetSyntaxCheckerOptions,
  VueI18nTargetSyntaxSubject,
} from "./vue-i18n-syntax-checkers.ts";
export { createVueI18nVariableCorrespondenceChecker } from "./vue-i18n-variable-checker.ts";
export type {
  VueI18nVariableCorrespondenceCheckerOptions,
  VueI18nVariableCorrespondenceSubject,
} from "./vue-i18n-variable-checker.ts";
export { createVueI18nTextRecognizer, createVueI18nAnalysis } from "./analysis.ts";
export { extractVueI18nUsages } from "./usages.ts";
export type { VueI18nUsage, VueI18nUsageIndex } from "./usage-types.ts";
