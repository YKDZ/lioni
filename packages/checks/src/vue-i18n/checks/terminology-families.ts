import type {
  QualityCheckDefinition,
  QualityCheckInput,
  QualityCheckSelection,
  QualityObject,
  TranslationUnitInput,
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
import type {
  MessageFamilyProjection,
  MessageFamilyReferenceProjection,
  MessageFamilySubject,
} from "../../message-family-checker.ts";
import { createTermChecker } from "../../terms.ts";
import { vueI18nDependencies } from "../dependencies.ts";
import { memoizedVueI18nMessage } from "../message-memo.ts";
import { memoizedVueI18nProjection } from "../quality-projection.ts";
import type {
  VueI18nCheckIdentity,
  VueI18nMessageProjection,
  VueI18nPolicy,
  VueI18nProjector,
  VueI18nReferenceProjector,
} from "../quality-types.ts";
import { createVueI18nScopeResolver } from "../scope.ts";
import {
  parseVueI18nMessage,
  VUE_I18N_MESSAGE_COMPILER_VERSION,
} from "../vue-i18n-messages.ts";

type TermSubject = {
  readonly key: string;
  readonly language: string;
  readonly source: string;
  readonly target: string;
  readonly policy: VueI18nPolicy;
  readonly projection: VueI18nMessageProjection;
};

type FamilySubject<
  TUnit extends TranslationUnitInput,
  TBody,
> = MessageFamilySubject<TUnit, TBody> & {
  readonly projection: VueI18nMessageProjection;
};

export function createVueI18nTerminologyChecks<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(options: {
  readonly project: VueI18nProjector<TUnit, TTranslation, TBody, TUnavailable>;
  readonly analysis: TextAnalysis;
  readonly identities: {
    readonly allowedTerminology: VueI18nCheckIdentity;
    readonly forbiddenTerminology: VueI18nCheckIdentity;
  };
}): readonly QualityCheckDefinition<
  TUnit,
  TTranslation,
  QualityObject,
  TBody,
  TUnavailable
>[] {
  const rules = [
    {
      rule: requireAllowedTranslation(),
      identity: options.identities.allowedTerminology,
      name: "allowed-terminology",
    },
    {
      rule: rejectForbiddenTranslation(),
      identity: options.identities.forbiddenTerminology,
      name: "forbidden-terminology",
    },
  ] as const;
  // 两条术语规则共用同一编译任务，按本次依赖缓存一份结果。
  const compile = (data: TermbaseData) =>
    compileTerms(createTermbase(data), { analysis: options.analysis });

  return rules.map(({ rule, identity, name }) =>
    createTermChecker<TUnit, TTranslation, TermSubject, TBody, TUnavailable>({
      id: identity.id,
      hostVersion: terminologyVersion(name, identity),
      terms: (input) => {
        return input.memo.memo(compile)(vueI18nDependencies(input).terms);
      },
      rule,
      select: async (
        input: QualityCheckInput<
          TUnit,
          TTranslation,
          unknown,
          TBody,
          TUnavailable
        >,
      ): Promise<QualityCheckSelection<TermSubject>> => {
        const policy = vueI18nDependencies(input).policies.get(
          input.candidate.language,
        );
        if (policy === undefined) return { status: "not-applicable" };
        const projection = await memoizedVueI18nProjection(
          input,
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
        return {
          status: "selected",
          subject: {
            key: projection.key,
            language: projection.language,
            source: projection.source.text,
            target: projection.target.text,
            policy,
            projection,
          },
        };
      },
      project: (input) => ({
        status: "ready",
        value: {
          groups: [
            {
              ref: input.subject.key,
              source: {
                language: input.subject.policy.sourceLanguage,
                fragments: [
                  {
                    ref: input.subject.key,
                    text: input.subject.source,
                  },
                ],
              },
              target: {
                language: input.subject.policy.targetLanguage,
                fragments: [
                  {
                    ref: input.subject.key,
                    text: input.subject.target,
                  },
                ],
              },
            },
          ],
        },
      }),
      location: ({ side, subject }) => subject.projection.locations[side],
    }),
  );
}

export function createVueI18nMessageFamilyCheck<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable = never,
>(options: {
  readonly project: VueI18nProjector<TUnit, TTranslation, TBody, TUnavailable>;
  readonly reference: VueI18nReferenceProjector<
    TUnit,
    TTranslation,
    TBody,
    TUnavailable
  >;
  readonly analysis: TextAnalysis;
  readonly identity: VueI18nCheckIdentity;
}) {
  const sourceTemplate: TemplateOptions = {
    abstract: (token) =>
      token.kind === "variable" && token.identity
        ? { kind: token.kind, identity: token.identity }
        : undefined,
  };
  const targetTemplate: TemplateOptions = { ...sourceTemplate };

  return createMessageFamilyChecker<
    TUnit,
    TTranslation,
    TUnit,
    TBody,
    TUnavailable,
    FamilySubject<TUnit, TBody>
  >({
    id: options.identity.id,
    hostVersion: familyVersion(options.identity),
    analysis: options.analysis,
    sourceTemplate,
    targetTemplate,
    targetEquivalence: (signature, language, input) =>
      vueI18nDependencies(input).targetEquivalences.get(language)?.(
        signature,
      ) ?? signatureKey(signature),
    select: async (
      input: QualityCheckInput<
        TUnit,
        TTranslation,
        unknown,
        TBody,
        TUnavailable
      >,
    ): Promise<QualityCheckSelection<FamilySubject<TUnit, TBody>>> => {
      const policy = vueI18nDependencies(input).policies.get(
        input.candidate.language,
      );
      if (policy === undefined || input.sourceUnit === null)
        return { status: "not-applicable" };
      const projection = await memoizedVueI18nProjection(
        input,
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
        status: "selected",
        subject: {
          sourceUnit: input.sourceUnit,
          sourceKey: projection.key,
          language: projection.language,
          content: input.candidate.content,
          projection,
        },
      };
    },
    project: async (
      input: MessageFamilyProjection<
        TUnit,
        TUnit,
        TTranslation,
        TBody,
        TUnavailable,
        FamilySubject<TUnit, TBody>
      >,
      context: QualityCheckInput<
        TUnit,
        TTranslation,
        unknown,
        TBody,
        TUnavailable
      >,
    ) => {
      const { configuration: _configuration, ...referenceInput } = context;
      const projection =
        input.kind === "candidate"
          ? input.subject.projection
          : options.reference(
              input as MessageFamilyReferenceProjection<
                TUnit,
                TTranslation,
                TBody,
                TUnavailable
              >,
              referenceInput,
            );
      return familyInput(projection, vueI18nDependencies(context).policies);
    },
    projectCandidate: async (input) =>
      familyInput(
        await memoizedVueI18nProjection(input, options.project),
        vueI18nDependencies(input).policies,
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
  if (projection.target.status !== "available")
    return {
      complete: false,
      groups: [],
      issues: [
        {
          code:
            projection.target.status === "missing"
              ? "targetMissing"
              : "targetBodyUnavailable",
          message: "已保存译文正文不可用，无法完整投影消息族。",
          language: projection.language,
          sourceKey: projection.key,
        },
      ],
    };
  if (
    parseVueI18nMessage(projection.source.text).errors.length > 0 ||
    parseVueI18nMessage(projection.target.text).errors.length > 0
  )
    return { groups: [] };

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
        target: {
          language: policy.targetLanguage,
          fragments: [{ ref: projection.key, text: projection.target.text }],
        },
      },
    ],
  };
}

function terminologyVersion(
  name: string,
  identity: VueI18nCheckIdentity,
): string {
  return [
    `vue-i18n-suite/${name}/v1`,
    `@intlify/message-compiler@${VUE_I18N_MESSAGE_COMPILER_VERSION}`,
    identity.hostVersion,
  ].join("+");
}

function familyVersion(identity: VueI18nCheckIdentity): string {
  return [
    "vue-i18n-suite/message-family/v3",
    `@intlify/message-compiler@${VUE_I18N_MESSAGE_COMPILER_VERSION}`,
    identity.hostVersion,
  ].join("+");
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
