import type { TranslationUnitInput } from "@lioni/core";
import type { TermbaseData } from "@lioni/terminology";
export type Resources = {
  source: Readonly<Record<string, string>>;
  target: Readonly<Record<string, string>>;
};
export type Usage = {
  key: string;
  file: string;
  kind: "call" | "component";
  supplied: readonly string[];
  parametersKnown: boolean;
};
export type UsageIndex = {
  entries: readonly Usage[];
  unresolved: readonly { file: string; expression: string }[];
  errors: readonly { file: string; message: string }[];
};
export type ReviewBaseline = {
  source: string;
  approvedTargets: readonly string[];
  reason: string;
};
export type ScopeRule = {
  scope: string;
  keys?: readonly string[];
  keyPattern?: string;
  flags?: string;
};
export type UsageScopeRule = { scope: string; filePattern: string };
export type LanguageMetadata = {
  quantityProfile?: string;
  reviews?: Readonly<Record<string, ReviewBaseline>>;
  equivalences?: readonly (readonly string[])[];
  quantityUnitAliases?: Readonly<
    Record<string, Readonly<Record<string, string>>>
  >;
  quantityDefaultUnits?: Readonly<Record<string, string>>;
  quantityIgnoredLiterals?: Readonly<Record<string, readonly string[]>>;
};
export type MessagePolicy = {
  literals: Readonly<Record<string, readonly string[]>>;
  scopes: readonly ScopeRule[];
  usageScopes: readonly UsageScopeRule[];
};
export type Policy = Resources &
  MessagePolicy & {
    sourceLanguage: string;
    targetLanguage: string;
    sourceRange: string;
    targetRange: string;
    sourceQuantityProfile?: string;
    targetQuantityProfile?: string;
    quantityDefaultUnits?: Readonly<Record<string, string>>;
    targetQuantityDefaultUnits?: Readonly<Record<string, string>>;
    quantityUnitAliases?: Readonly<
      Record<string, Readonly<Record<string, string>>>
    >;
    targetQuantityUnitAliases?: Readonly<
      Record<string, Readonly<Record<string, string>>>
    >;
    sourceQuantityIgnoredLiterals?: Readonly<Record<string, readonly string[]>>;
    targetQuantityIgnoredLiterals?: Readonly<Record<string, readonly string[]>>;
    terms: TermbaseData;
    usages: UsageIndex;
    reviews: Readonly<Record<string, ReviewBaseline>>;
    targetEquivalences: readonly (readonly string[])[];
  };
export type Project = {
  policies: readonly Policy[];
  terms: TermbaseData;
  usages: UsageIndex;
};
export type Pair = {
  key: string;
  source: string;
  target: string;
  language: string;
};
export type Finding = {
  code: string;
  message: string;
  severity?: "error" | "warning";
  details?: unknown;
};
export type Unit = TranslationUnitInput & {
  key: string;
  source: { text: string };
};
export type Translation = { key: string; text: string; language: string };
export type Body = { text: string; language: string; resourceKey: string };
