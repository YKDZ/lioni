export { compareNumberText, createNumberChecker } from "./numbers.ts";
export type {
  NumberCheckerOptions,
  NumberCheckerPreparation,
  NumberTextInput,
} from "./numbers.ts";
export { createTermChecker } from "./terms.ts";
export type {
  TermCheckerGroupLocations,
  TermCheckerInput,
  TermCheckerLoaded,
  TermCheckerLocationInput,
  TermCheckerOptions,
  TermCheckerPreparation,
} from "./terms.ts";
export {
  compareMessageFamily,
  indexMessageFamilies,
} from "./message-families.ts";
export type {
  MessageFamilyComparison,
  MessageFamilyIssue,
  MessageFragment,
  MessageFamilyGroup,
  MessageFamilyIndex,
  MessageFamilyInput,
  MessageFamilyLimits,
  MessageFamilyReference,
  MessageFamilySignature,
  MessageText,
} from "./message-families.ts";
export { createMessageFamilyChecker } from "./message-family-checker.ts";
export type {
  MessageFamilyCheckerOptions,
  MessageFamilyContext,
  MessageFamilyReferenceProjection,
} from "./message-family-checker.ts";
export { compareQuantityBranches } from "./quantities.ts";
export type { QuantityBranch, QuantityBranchIssue } from "./quantities.ts";
export { compareProtectedLiterals } from "./protected-literals.ts";
export type { ProtectedLiteralIssue } from "./protected-literals.ts";
export { createVueI18nChecks } from "./vue-i18n/quality-checks.ts";
export type {
  VueI18nChecksOptions,
  VueI18nDataReader,
  VueI18nLanguagePolicy,
  VueI18nMessageProjection,
  VueI18nPolicy,
  VueI18nPolicyData,
  VueI18nPolicyRequirement,
  VueI18nReferenceProjector,
  VueI18nScopeRule,
  VueI18nQuantityPolicy,
  VueI18nSourceMessage,
  VueI18nTargetMessage,
} from "./vue-i18n/quality-types.ts";
export { prepareVueI18nMessage } from "./vue-i18n/quality-projection.ts";
export type {
  VueI18nPrepareInput,
  VueI18nPreparer,
} from "./vue-i18n/quality-projection.ts";
export {
  createVueI18nSourceSyntaxChecker,
  createVueI18nTargetSyntaxChecker,
} from "./vue-i18n/vue-i18n-syntax-checkers.ts";
export { createVueI18nVariableCorrespondenceChecker } from "./vue-i18n/vue-i18n-variable-checker.ts";
