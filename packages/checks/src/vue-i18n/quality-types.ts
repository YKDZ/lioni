import type {
  ActualTranslationFact,
  JsonValue,
  SourceUnitFact,
  TranslationAssociationFact,
  TranslationUnitInput,
} from "@lioni/core";
import type { TermbaseData } from "@lioni/terminology";
import type { QuantityOptions } from "@lioni/text-analysis";

import type { MessageFamilyReferenceProjection } from "../message-family-checker.ts";
import type {
  VueI18nMessageProjection,
  VueI18nProjectionInput,
  VueI18nProjector,
} from "./quality-projection.ts";

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

/** 每次质量检查读取的 Vue 规则、消息资料与术语库。 */
export type VueI18nCheckData = {
  readonly policies: readonly VueI18nPolicy[];
  readonly terms: TermbaseData;
};

/** 放入 quality.loadDependencies 返回值的 Vue 检查资料。 */
export type VueI18nCheckDependencies = {
  readonly vueI18n: VueI18nCheckData;
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
    readonly targetEquivalences: readonly (readonly string[])[];
  };
};

export type VueI18nCheckIdentity = {
  readonly id: string;
  readonly hostVersion: string;
};

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
  input: VueI18nProjectionInput<TUnit, TTranslation, TBody, TUnavailable>,
) => VueI18nMessageProjection;

export type VueI18nChecksOptions<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable = never,
> = {
  /** 宿主投影、位置映射和策略语义变化时更新，用于使缓存失效。 */
  readonly hostVersion: string;
  /** 将本次候选、事实和依赖映射为 Vue I18n 消息。 */
  readonly project: VueI18nProjector<TUnit, TTranslation, TBody, TUnavailable>;
  /** 将已保存译文映射为 Vue I18n 消息，供消息族参照检查使用。 */
  readonly reference: VueI18nReferenceProjector<
    TUnit,
    TTranslation,
    TBody,
    TUnavailable
  >;
};
