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
import { memoizedVueI18nProjection } from "../quality-projection.ts";
import type {
  VueI18nCheckIdentity,
  VueI18nDataReader,
  VueI18nLanguagePolicy,
  VueI18nMessageProjection,
  VueI18nPolicy,
  VueI18nPolicyData,
  VueI18nProjector,
  VueI18nReferenceProjector,
} from "../quality-types.ts";
import { createVueI18nScopeResolver } from "../scope.ts";
import { parseVueI18nMessage } from "../vue-i18n-messages.ts";

type TermSubject = {
  readonly key: string;
  readonly language: string;
  readonly source: string;
  readonly target: string;
  readonly policy: VueI18nLanguagePolicy;
  readonly projection: VueI18nMessageProjection;
};

export function createVueI18nTerminologyChecks<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
  TAllowedId extends string = string,
  TForbiddenId extends string = string,
>(options: {
  readonly project: VueI18nProjector<TUnit, TTranslation, TBody, TUnavailable>;
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
    facts,
    memo,
    qualityData,
  }: QualityDataLoadInput<TUnit, TTranslation, TBody, TUnavailable>) => {
    return qualityData.read(options.loadLanguages, facts, memo);
  };
  const loadTerms = async ({
    facts,
    memo,
    qualityData,
  }: QualityDataLoadInput<TUnit, TTranslation, TBody, TUnavailable>) => {
    const data = await qualityData.read(options.loadTerms, facts, memo);
    return memo.memo(compile)(data);
  };

  return rules.map(({ rule, identity }) =>
    createTermChecker.withTypes<
      TUnit,
      TTranslation,
      TermSubject,
      TBody,
      TUnavailable
    >()({
      id: identity.id,
      terms: loadTerms,
      load: loadLanguages,
      rule,
      prepare: async (input) => {
        const policy = readVueI18nLanguagePolicies(input.loaded.context).get(
          input.candidate.language,
        );
        if (policy === undefined) return { status: "not-applicable" };
        const projection = await memoizedVueI18nProjection(
          {
            ...input,
            configuration: undefined,
            dependencies: input.loaded.context,
          },
          options.project,
        );
        if (projection.target.status === "missing")
          return { status: "not-applicable" };
        if (projection.target.status === "unavailable")
          return incompleteSelection(
            "targetUnavailable",
            "目标消息正文不可用，术语检查未执行。",
          );
        if (projection.source.status === "absent")
          return { status: "not-applicable" };
        if (projection.source.status === "unavailable")
          return incompleteSelection(
            "sourceUnavailable",
            "原文正文不可用，术语检查未执行。",
          );
        if (!projection.target.text.trim()) return { status: "not-applicable" };
        const subject: TermSubject = {
          key: projection.key,
          language: projection.language,
          source: projection.source.text,
          target: projection.target.text,
          policy,
          projection,
        };
        return {
          status: "ready",
          subject,
          comparison: {
            groups: [
              {
                ref: subject.key,
                source: {
                  language: policy.sourceLanguage,
                  fragments: [{ ref: subject.key, text: subject.source }],
                },
                target: {
                  language: policy.targetLanguage,
                  fragments: [{ ref: subject.key, text: subject.target }],
                },
              },
            ],
          },
        };
      },
      location: ({ side, subject }) => subject.projection.locations[side],
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
  readonly project: VueI18nProjector<TUnit, TTranslation, TBody, TUnavailable>;
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
    facts,
    memo,
    qualityData,
  }: QualityDataLoadInput<TUnit, TTranslation, TBody, TUnavailable>) =>
    qualityData.read(options.loadPolicies, facts, memo);

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
        .policies.get(input.candidate.language);
      if (policy === undefined || input.sourceUnit === null)
        return { status: "not-applicable" };
      const projection = await memoizedVueI18nProjection(
        { ...input, configuration: undefined, dependencies: input.loaded },
        options.project,
      );
      const unavailable = sourceAvailability(projection);
      if (unavailable !== undefined) return unavailable;
      const targetUnavailable = targetAvailability(projection);
      if (targetUnavailable !== undefined) return targetUnavailable;
      if (input.sourceUnit.bodyAvailability !== "available")
        return incompleteSelection(
          "sourceUnavailable",
          "原文正文不可用，消息族检查未执行。",
        );
      if (
        projection.source.status !== "available" ||
        projection.target.status !== "available" ||
        !projection.target.text.trim()
      )
        return { status: "not-applicable" };
      if (
        memoizedVueI18nMessage(projection.source.text, input.memo).errors
          .length > 0 ||
        memoizedVueI18nMessage(projection.target.text, input.memo).errors
          .length > 0
      )
        return { status: "not-applicable" };
      return {
        status: "ready",
        input: familyInput(
          projection,
          input.memo.memo(resolvePolicies)(input.loaded).policies,
        ),
      };
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
  const policy = policies.get(projection.language);
  if (policy === undefined)
    return {
      complete: false,
      groups: [],
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

function incompleteSelection(code: string, message: string) {
  return {
    status: "incomplete" as const,
    issue: { code, message },
  };
}

function sourceAvailability(projection: VueI18nMessageProjection) {
  if (projection.source.status === "absent")
    return { status: "not-applicable" as const };
  if (projection.source.status === "unavailable")
    return incompleteSelection(
      "sourceUnavailable",
      "原文正文不可用，消息族检查未执行。",
    );
  return undefined;
}

function targetAvailability(projection: VueI18nMessageProjection) {
  if (projection.target.status === "missing")
    return { status: "not-applicable" as const };
  if (projection.target.status === "unavailable")
    return incompleteSelection(
      "targetUnavailable",
      "目标消息正文不可用，消息族检查未执行。",
    );
  return undefined;
}
