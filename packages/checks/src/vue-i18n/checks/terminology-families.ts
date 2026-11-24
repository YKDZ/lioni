import {
  type QualityCheckDefinition,
  type QualityDataLoadInput,
  type QualityObject,
  type TranslationUnitInput,
} from "@lioni/core";
import {
  compileTerms,
  createTermbase,
  rejectForbiddenTranslation,
  requireAllowedTranslation,
} from "@lioni/terminology";
import type { TermbaseData } from "@lioni/terminology";
import { signatureKey } from "@lioni/text-analysis";
import type { TemplateOptions, TextAnalysis } from "@lioni/text-analysis";

import type { MessageFamilyInput } from "../../message-families.ts";
import { createMessageFamilyChecker } from "../../message-family-checker.ts";
import { createTermChecker } from "../../terms.ts";
import {
  readVueI18nFamilyPolicies,
  readVueI18nLanguagePolicies,
} from "../dependencies.ts";
import { memoizedVueI18nMessage } from "../message-memo.ts";
import {
  assertVueI18nMessageProjection,
  prepareVueI18nMessage,
} from "../quality-projection.ts";
import type {
  VueI18nCheckIdentity,
  VueI18nDataReader,
  VueI18nLanguagePolicy,
  VueI18nMessageProjection,
  VueI18nPolicy,
  VueI18nPolicyData,
  VueI18nPreparer,
  VueI18nReferenceProjector,
} from "../quality-types.ts";
import { createVueI18nScopeResolver } from "../scope.ts";
import { parseVueI18nMessage } from "../vue-i18n-messages.ts";

export function createVueI18nTerminologyChecks<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
  TAllowedId extends string = string,
  TForbiddenId extends string = string,
>(options: {
  readonly prepare?: VueI18nPreparer<TUnit, TTranslation, TBody, TUnavailable>;
  readonly analysis: TextAnalysis;
  readonly loadLanguages: VueI18nDataReader<
    TUnit,
    TTranslation,
    TBody,
    TUnavailable,
    readonly VueI18nLanguagePolicy[]
  >;
  readonly loadTerms: VueI18nDataReader<
    TUnit,
    TTranslation,
    TBody,
    TUnavailable,
    TermbaseData
  >;
  readonly identities: {
    readonly allowedTerminology: VueI18nCheckIdentity<TAllowedId>;
    readonly forbiddenTerminology: VueI18nCheckIdentity<TForbiddenId>;
  };
}): readonly QualityCheckDefinition<
  TUnit,
  TTranslation,
  QualityObject,
  TBody,
  TUnavailable,
  TAllowedId | TForbiddenId
>[] {
  const rules = [
    {
      rule: requireAllowedTranslation(),
      identity: options.identities.allowedTerminology,
    },
    {
      rule: rejectForbiddenTranslation(),
      identity: options.identities.forbiddenTerminology,
    },
  ] as const;
  // 两条术语规则共用同一编译任务，按本次依赖缓存一份结果。
  const compile = (data: TermbaseData) =>
    compileTerms(createTermbase(data), { analysis: options.analysis });
  const loadLanguages = async ({
    snapshot,
    memo,
    qualityData,
  }: QualityDataLoadInput<TUnit, TTranslation, TBody, TUnavailable>) => {
    return readVueI18nLanguagePolicies(
      await qualityData.read(options.loadLanguages, snapshot, memo),
    );
  };
  const loadTerms = async ({
    snapshot,
    memo,
    qualityData,
  }: QualityDataLoadInput<TUnit, TTranslation, TBody, TUnavailable>) => {
    const data = await qualityData.read(options.loadTerms, snapshot, memo);
    return memo.memo(compile)(data);
  };

  return rules.map(({ rule, identity }) =>
    createTermChecker.withTypes<
      TUnit,
      TTranslation,
      VueI18nMessageProjection,
      TBody,
      TUnavailable
    >()({
      id: identity.id,
      terms: loadTerms,
      load: loadLanguages,
      rule,
      prepare: async (input) => {
        const policy = input.loaded.context.get(input.association.language);
        if (policy === undefined) return null;
        const { loaded: _loaded, ...messageInput } = input;
        const projection = await prepareVueI18nMessage(
          messageInput,
          options.prepare,
        );
        if (projection === null) return null;
        if (projection.target.status === "missing") return null;
        if (projection.target.status === "unavailable")
          throw new Error("目标消息正文不可用，术语检查未执行。");
        if (projection.source.status === "absent") return null;
        if (
          projection.source.status === "unavailable" ||
          input.sourceUnit.bodyAvailability !== "available"
        )
          throw new Error("原文正文不可用，术语检查未执行。");
        if (!projection.target.text.trim()) return null;
        return {
          subject: projection,
          comparison: {
            groups: [
              {
                ref: projection.key,
                source: {
                  language: policy.sourceLanguage,
                  fragments: [
                    { ref: projection.key, text: projection.source.text },
                  ],
                },
                target: {
                  language: policy.targetLanguage,
                  fragments: [
                    { ref: projection.key, text: projection.target.text },
                  ],
                },
              },
            ],
          },
        };
      },
      location: ({ side, subject }) => subject.locations[side],
    }),
  );
}

export function createVueI18nMessageFamilyCheck<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable = never,
  TId extends string = string,
>(options: {
  readonly prepare?: VueI18nPreparer<TUnit, TTranslation, TBody, TUnavailable>;
  readonly loadPolicies: VueI18nDataReader<
    TUnit,
    TTranslation,
    TBody,
    TUnavailable,
    readonly VueI18nPolicyData[]
  >;
  readonly reference: VueI18nReferenceProjector<
    TUnit,
    TTranslation,
    TBody,
    TUnavailable
  >;
  readonly analysis: TextAnalysis;
  readonly identity: VueI18nCheckIdentity<TId>;
}) {
  const sourceTemplate: TemplateOptions = {
    abstract: (token) =>
      token.kind === "variable" && token.identity
        ? { kind: token.kind, identity: token.identity }
        : undefined,
  };
  const targetTemplate: TemplateOptions = { ...sourceTemplate };
  const resolvePolicies = (dependencies: unknown) =>
    readVueI18nFamilyPolicies(dependencies);
  const loadDependencies = ({
    snapshot,
    memo,
    qualityData,
  }: QualityDataLoadInput<TUnit, TTranslation, TBody, TUnavailable>) =>
    qualityData.read(options.loadPolicies, snapshot, memo);

  return createMessageFamilyChecker<
    TUnit,
    TTranslation,
    TBody,
    TUnavailable,
    unknown,
    TId
  >({
    id: options.identity.id,
    load: loadDependencies,
    analysis: options.analysis,
    sourceTemplate,
    targetTemplate,
    targetEquivalence: (signature, language, input) =>
      input.memo
        .memo(resolvePolicies)(input.loaded)
        .targetEquivalences.get(language)?.(signature) ??
      signatureKey(signature),
    prepare: async (input) => {
      const policy = input.memo
        .memo(resolvePolicies)(input.loaded)
        .policies.get(input.association.language);
      if (policy === undefined || input.sourceUnit === null) return null;
      const projection = await prepareVueI18nMessage(input, options.prepare);
      if (projection === null) return null;
      if (
        projection.source.status === "absent" ||
        projection.target.status === "missing"
      )
        return null;
      if (
        projection.target.status === "unavailable" ||
        projection.source.status === "unavailable"
      )
        throw new Error("原文或目标消息正文不可用，无法比较消息族。");
      if (input.sourceUnit.bodyAvailability !== "available")
        throw new Error("原文正文不可用，消息族检查未执行。");
      if (
        projection.source.status !== "available" ||
        projection.target.status !== "available" ||
        !projection.target.text.trim()
      )
        return null;
      if (
        memoizedVueI18nMessage(projection.source.text, input.memo).errors
          .length > 0 ||
        memoizedVueI18nMessage(projection.target.text, input.memo).errors
          .length > 0
      )
        throw new Error("原文或译文语法无效，无法确定消息族。");
      return familyInput(
        projection,
        input.memo.memo(resolvePolicies)(input.loaded).policies,
      );
    },
    reference: (reference, context) =>
      familyInput(
        options.reference(reference, context),
        context.memo.memo(resolvePolicies)(context.loaded).policies,
      ),
  });
}

function familyInput(
  projection: VueI18nMessageProjection,
  policies: ReadonlyMap<string, VueI18nPolicy>,
): MessageFamilyInput {
  assertVueI18nMessageProjection(projection);
  const location = projection.locations.target;
  const policy = policies.get(projection.language);
  if (policy === undefined)
    return {
      complete: false,
      groups: [],
      location,
      issues: [
        {
          code: "missing-language-policy",
          message: `未声明 ${projection.language} 的消息族策略。`,
          language: projection.language,
        },
      ],
    };
  if (projection.source.status !== "available")
    return {
      complete: false,
      groups: [],
      location,
      issues: [
        {
          code: "sourceBodyUnavailable",
          message: "原文正文不可用，无法完整投影消息族。",
          language: projection.language,
          sourceKey: projection.key,
        },
      ],
    };
  if (parseVueI18nMessage(projection.source.text).errors.length > 0)
    return {
      complete: false,
      groups: [],
      location,
      issues: [
        {
          code: "sourceMessageSyntaxInvalid",
          message: "原文语法无效，无法确定消息族。",
          language: projection.language,
          sourceKey: projection.key,
        },
      ],
    };
  const targetIssue =
    projection.target.status !== "available"
      ? {
          code:
            projection.target.status === "missing"
              ? "targetMissing"
              : "targetBodyUnavailable",
          message: "已保存译文正文不可用，无法完整投影消息族。",
          language: projection.language,
          sourceKey: projection.key,
        }
      : parseVueI18nMessage(projection.target.text).errors.length > 0
        ? {
            code: "targetMessageSyntaxInvalid",
            message: "已保存译文语法无效，无法完整投影消息族。",
            language: projection.language,
            sourceKey: projection.key,
          }
        : undefined;

  const scope = createVueI18nScopeResolver(policy)(projection.key);
  return {
    location,
    groups: [
      {
        ref: projection.key,
        scope,
        source: {
          language: policy.sourceLanguage,
          fragments: [{ ref: projection.key, text: projection.source.text }],
        },
        // 原文组已知时保留其族归属，目标缺口只限制对应族。
        target: {
          language: policy.targetLanguage,
          fragments:
            projection.target.status === "available" &&
            targetIssue === undefined
              ? [{ ref: projection.key, text: projection.target.text }]
              : [],
          ...(targetIssue === undefined
            ? {}
            : { complete: false, issues: [targetIssue] }),
        },
      },
    ],
  };
}
