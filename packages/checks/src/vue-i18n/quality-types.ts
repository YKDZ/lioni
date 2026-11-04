import type {
  ActualTranslationFact,
  Awaitable,
  FrameworkFacts,
  JsonValue,
  SourceUnitFact,
  TranslationAssociationFact,
  TranslationUnitInput,
} from "@lioni/core";
import type { MemoScope } from "@lioni/memo";
import type { TermbaseData } from "@lioni/terminology";
import type { QuantityOptions } from "@lioni/text-analysis";

import type {
  MessageFamilyReferenceProjection,
  MessageFamilyContext,
} from "../message-family-checker.ts";
import type {
  VueI18nMessageProjection,
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

/** 语法、变量与术语检查所需的最小语言范围。 */
export type VueI18nLanguagePolicy = {
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
};

/** 完整 Vue 策略；供既有项目投影和事实构造使用。 */
export type VueI18nPolicy = VueI18nLanguagePolicy & {
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

/** 每项策略允许只携带具体检查项使用的部分；必需字段由该项 schema 校验。 */
export type VueI18nPolicyData = Pick<
  VueI18nPolicy,
  "sourceLanguage" | "targetLanguage"
> &
  Partial<
    Pick<
      VueI18nPolicy,
      "resources" | "quantities" | "protectedLiterals" | "messageFamilies"
    >
  >;

export type VueI18nPolicyRequirement =
  | "resources"
  | "quantities"
  | "protectedLiterals"
  | "messageFamilies";

/** 宿主按需读取 Vue I18n 检查资料；facts 与 memo 可用于选择读取范围。 */
export type VueI18nDataReader<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
  TValue,
> = (
  facts: FrameworkFacts<TUnit, TTranslation, TBody, TUnavailable>,
  memo: MemoScope,
) => Awaitable<TValue>;

export type VueI18nCheckIdentity<TId extends string = string> = {
  readonly id: TId;
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
  input: MessageFamilyContext<TUnit, TTranslation, TBody, TUnavailable>,
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
  /** 只提供语言范围；语法、变量和术语检查不要求消息族策略或术语容器。 */
  readonly loadLanguages?: VueI18nDataReader<
    TUnit,
    TTranslation,
    TBody,
    TUnavailable,
    readonly VueI18nLanguagePolicy[]
  >;
  /** 链接、数量、字面值和消息族检查只验证自己读取的策略字段。 */
  readonly loadPolicies?: VueI18nDataReader<
    TUnit,
    TTranslation,
    TBody,
    TUnavailable,
    readonly VueI18nPolicyData[]
  >;
  /** 术语检查读取原始术语库资料，并在共享计算范围内编译。 */
  readonly loadTerms?: VueI18nDataReader<
    TUnit,
    TTranslation,
    TBody,
    TUnavailable,
    TermbaseData
  >;
  /** 将已保存译文映射为 Vue I18n 消息，供消息族参照检查使用。 */
  readonly reference: VueI18nReferenceProjector<
    TUnit,
    TTranslation,
    TBody,
    TUnavailable
  >;
};
