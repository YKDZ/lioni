import type {
  ActualTranslationFact,
  QualityCheckInput,
  QualityLocation,
  SourceUnitFact,
  TranslationAssociationFact,
  TranslationUnitInput,
} from "@lioni/core";
import type { MessageFamilyReferenceProjection } from "@lioni/checks";
import type { QuantityOptions } from "@lioni/text-analysis";

import type { VueI18nUsageIndex } from "./usage-types.ts";

export type VueI18nSourceMessage =
  | { readonly status: "available"; readonly text: string }
  | { readonly status: "unavailable" }
  | { readonly status: "absent" };

export type VueI18nTargetMessage =
  | { readonly status: "available"; readonly text: string }
  | { readonly status: "unavailable" }
  | { readonly status: "missing" };

/** 候选与参照都使用的显式消息投影。缺少或不可读的正文不会伪装成空串。 */
export type VueI18nMessageProjection = {
  readonly key: string;
  readonly language: string;
  readonly source: VueI18nSourceMessage;
  readonly target: VueI18nTargetMessage;
  readonly locations: {
    readonly source: QualityLocation;
    readonly target: QualityLocation;
  };
};

/** 共用投影只能读取事实、候选及关系，不能依赖某个检查专属 configuration。 */
export type VueI18nProjectionInput<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
> = Omit<
  QualityCheckInput<TUnit, TTranslation, unknown, TBody, TUnavailable>,
  "configuration"
>;

export type VueI18nProjector<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
> = (
  input: VueI18nProjectionInput<TUnit, TTranslation, TBody, TUnavailable>,
) => VueI18nMessageProjection;

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
      readonly range: unknown;
    };
    readonly target: {
      readonly messages: Readonly<Record<string, string>>;
      readonly range: unknown;
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
  readonly hostVersion?: string;
};

export type VueI18nCheckIdentities = Partial<
  Readonly<Record<VueI18nCheckName, VueI18nCheckIdentity>>
>;

export type VueI18nMessageReference<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
> = MessageFamilyReferenceProjection<
  TUnit,
  TTranslation,
  TBody,
  TUnavailable
> & {
  readonly sourceUnit: SourceUnitFact<TUnit>;
  readonly association: TranslationAssociationFact;
  readonly translation: ActualTranslationFact<TTranslation, TBody, TUnavailable>;
};

export type VueI18nReferenceProjector<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
> = (
  reference: VueI18nMessageReference<
    TUnit,
    TTranslation,
    TBody,
    TUnavailable
  >,
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
  readonly terms: import("@lioni/terminology").TermbaseData;
  readonly usages: VueI18nUsageIndex;
  readonly identities?: VueI18nCheckIdentities;
};
