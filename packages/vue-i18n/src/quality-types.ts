import type { MessageFamilyReferenceProjection } from "@lioni/checks";
import type {
  ActualTranslationFact,
  JsonValue,
  QualityCheckRequest,
  QualityPreparation,
  SemanticEditCandidate,
  SourceUnitFact,
  TranslationAssociationFact,
  TranslationUnitInput,
} from "@lioni/core";
import type { TermbaseData } from "@lioni/terminology";
import type { QuantityOptions } from "@lioni/text-analysis";

import type {
  VueI18nMessageProjection,
  VueI18nProjector,
} from "./quality-projection.ts";
import type { VueI18nUsageIndex } from "./usage-types.ts";

export type {
  VueI18nMessageProjection,
  VueI18nProjectionInput,
  VueI18nProjector,
  VueI18nSourceMessage,
  VueI18nTargetMessage,
} from "./quality-projection.ts";

export type VueI18nQuantityPolicy = QuantityOptions & {
  readonly profile?: string;
  readonly byKey?: Readonly<Record<string, QuantityOptions>>;
};

export type VueI18nScopeRule = {
  readonly scope: string;
  readonly keys?: readonly string[];
  readonly keyPattern?: string;
  readonly flags?: string;
};

export type VueI18nUsageScopeRule = {
  readonly scope: string;
  readonly filePattern: string;
};

export type VueI18nPolicy = {
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
  readonly resources: {
    readonly source: {
      readonly messages: Readonly<Record<string, string>>;
      readonly range: JsonValue;
    };
    readonly target: {
      readonly messages: Readonly<Record<string, string>>;
      readonly range: JsonValue;
    };
  };
  readonly quantities?: {
    readonly source: VueI18nQuantityPolicy;
    readonly target: VueI18nQuantityPolicy;
  };
  readonly protectedLiterals: Readonly<Record<string, readonly string[]>>;
  readonly messageFamilies: {
    readonly scopes: readonly VueI18nScopeRule[];
    readonly usageScopes: readonly VueI18nUsageScopeRule[];
    readonly targetEquivalences: readonly (readonly string[])[];
  };
};

export type VueI18nCheckName =
  | "sourceSyntax"
  | "targetSyntax"
  | "variableCorrespondence"
  | "callArguments"
  | "linkTargetExists"
  | "linkCycle"
  | "protectedLiterals"
  | "quantities"
  | "allowedTerminology"
  | "forbiddenTerminology"
  | "messageFamilyConsistency";

export type VueI18nCheckIdentity = {
  readonly id: string;
  /** 宿主资料投影或业务声明的版本；Vue 算法与解析器版本由包加入。 */
  readonly hostVersion: string;
};

export type VueI18nCheckIdentities = Readonly<
  Record<VueI18nCheckName, VueI18nCheckIdentity>
>;

export type VueI18nMessageReference<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable = never,
> = MessageFamilyReferenceProjection<
  TUnit,
  TTranslation,
  TBody,
  TUnavailable
> & {
  readonly sourceUnit: SourceUnitFact<TUnit>;
  readonly association: TranslationAssociationFact;
  readonly translation: ActualTranslationFact<
    TTranslation,
    TBody,
    TUnavailable
  >;
};

export type VueI18nReferenceProjector<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable = never,
> = (
  reference: VueI18nMessageReference<TUnit, TTranslation, TBody, TUnavailable>,
) => VueI18nMessageProjection;

export type VueI18nQualityOptions<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable = never,
> = {
  readonly project: VueI18nProjector<TUnit, TTranslation, TBody, TUnavailable>;
  readonly reference: VueI18nReferenceProjector<
    TUnit,
    TTranslation,
    TBody,
    TUnavailable
  >;
  readonly policies: readonly VueI18nPolicy[];
  readonly terms: TermbaseData;
  readonly usages: VueI18nUsageIndex;
  readonly identities: VueI18nCheckIdentities;
};

export type VueI18nQualityDependencies = {
  readonly policies: readonly VueI18nPolicy[];
  readonly terms: TermbaseData;
  readonly usages: VueI18nUsageIndex;
};

export type VueI18nQualityPreparation<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable = never,
> = Omit<
  QualityPreparation<TUnit, TTranslation, TBody, TUnavailable>,
  "request"
> & {
  readonly request: Omit<
    QualityCheckRequest<TBody>,
    "exceptions" | "candidates" | "dependencies"
  > & {
    readonly candidates?: readonly SemanticEditCandidate<TBody>[];
    readonly dependencies: {
      readonly vueI18n: VueI18nQualityDependencies;
    };
  };
};
