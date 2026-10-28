import type {
  QualityCheckOutcome,
  QualityEvidence,
  TranslationUnitInput,
} from "@lioni/core";
import { quantityProfile } from "@lioni/text-analysis";
import type { QuantityOptions, QuantityProfile } from "@lioni/text-analysis";

import { compareProtectedLiterals } from "../../protected-literals.ts";
import { compareQuantityBranches } from "../../quantities.ts";
import { vueI18nDependencies } from "../dependencies.ts";
import { memoizedVueI18nMessage } from "../message-memo.ts";
import type {
  VueI18nCheckIdentity,
  VueI18nMessageProjection,
  VueI18nPolicy,
  VueI18nProjector,
  VueI18nQuantityPolicy,
} from "../quality-types.ts";
import {
  VUE_I18N_PROTECTED_LITERAL_COMPARISON_VERSION,
  VUE_I18N_QUANTITY_COMPARISON_VERSION,
} from "../versions.ts";
import type {
  VueI18nMessage,
  VueI18nMessageBranch,
} from "../vue-i18n-messages.ts";
import { VUE_I18N_MESSAGE_COMPILER_VERSION } from "../vue-i18n-messages.ts";
import {
  completeOutcome,
  createVueI18nMessageCheck,
  finding,
  incompleteOutcome,
  issue,
  sourceObject,
  translationObject,
} from "./common.ts";

export function createProtectedLiteralCheck<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable = never,
>(options: {
  readonly identity: VueI18nCheckIdentity;
  readonly project: VueI18nProjector<TUnit, TTranslation, TBody, TUnavailable>;
}) {
  const hostVersion = options.identity.hostVersion;
  const version = [
    "vue-i18n-suite/protected-literals/v1",
    VUE_I18N_PROTECTED_LITERAL_COMPARISON_VERSION,
    ...(hostVersion ? [hostVersion] : []),
  ].join("+");
  return createVueI18nMessageCheck({
    id: options.identity.id,
    version,
    project: options.project,
    requiresSource: true,
    requiresTarget: true,
    targetMustContainText: true,
    applies: (projection, policy) =>
      (policy.protectedLiterals[projection.key]?.length ?? 0) > 0,
    check: (input) =>
      evaluateProtectedLiterals(
        input.projected,
        vueI18nDependencies(input).policies.get(input.projected.language)!,
      ),
  });
}

export function createQuantityCheck<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable = never,
>(options: {
  readonly identity: VueI18nCheckIdentity;
  readonly project: VueI18nProjector<TUnit, TTranslation, TBody, TUnavailable>;
}) {
  const hostVersion = options.identity.hostVersion;
  const version = [
    "vue-i18n-suite/quantities/v1",
    `@intlify/message-compiler@${VUE_I18N_MESSAGE_COMPILER_VERSION}`,
    VUE_I18N_QUANTITY_COMPARISON_VERSION,
    ...(hostVersion ? [hostVersion] : []),
  ].join("+");
  return createVueI18nMessageCheck({
    id: options.identity.id,
    version,
    project: options.project,
    requiresSource: true,
    requiresTarget: true,
    targetMustContainText: true,
    check: (input) =>
      evaluateQuantities(
        input.projected,
        vueI18nDependencies(input).policies.get(input.projected.language)!,
        input.memo,
      ),
  });
}

function evaluateProtectedLiterals(
  projection: VueI18nMessageProjection,
  policy: VueI18nPolicy,
): QualityCheckOutcome {
  if (
    projection.source.status !== "available" ||
    projection.target.status !== "available"
  )
    return incompleteOutcome([
      issue("messageBodyUnavailable", "原文或目标消息正文不可用。", projection),
    ]);
  const literals = policy.protectedLiterals[projection.key] ?? [];
  const issues = compareProtectedLiterals({
    source: projection.source.text,
    target: projection.target.text,
    literals,
  });
  const span = fullRange(projection.target.text);
  const evidence: readonly QualityEvidence[] = [
    {
      role: "source-message",
      object: sourceObject(projection.key),
      location: projection.locations.source,
      value: projection.source.text,
    },
    {
      role: "target-message",
      object: translationObject(projection),
      location: projection.locations.target,
      value: projection.target.text,
    },
  ];
  return completeOutcome(
    issues.map(({ literal }) =>
      finding(
        projection,
        "protected-literal-missing",
        `译文没有保留技术字面值 ${literal}。`,
        span,
        [
          ...evidence,
          {
            role: "protected-literal",
            object: translationObject(projection),
            location: projection.locations.target,
            value: literal,
          },
        ],
      ),
    ),
  );
}

function evaluateQuantities(
  projection: VueI18nMessageProjection,
  policy: VueI18nPolicy,
  memo: import("@lioni/memo").MemoScope,
): QualityCheckOutcome {
  if (
    projection.source.status !== "available" ||
    projection.target.status !== "available"
  )
    return incompleteOutcome([
      issue("messageBodyUnavailable", "原文或目标消息正文不可用。", projection),
    ]);
  const quantityPolicy = policy.quantities;
  const sourceId = quantityPolicy?.source.profile;
  const targetId = quantityPolicy?.target.profile;
  const sourceProfile = quantityProfile(sourceId, policy.sourceLanguage);
  const targetProfile = quantityProfile(targetId, policy.targetLanguage);
  if (!sourceProfile)
    return incompleteOutcome([
      issue(
        "unsupported-language-profile",
        `源语言 ${policy.sourceLanguage} 没有已声明的数值分析能力。`,
        projection,
      ),
    ]);
  if (!targetProfile)
    return incompleteOutcome([
      issue(
        "unsupported-language-profile",
        `目标语言 ${policy.targetLanguage} 没有已声明的数值分析能力。`,
        projection,
      ),
    ]);

  const source = memoizedVueI18nMessage(projection.source.text, memo);
  const target = memoizedVueI18nMessage(projection.target.text, memo);
  if (source.errors.length > 0 || target.errors.length > 0)
    return incompleteOutcome([
      issue(
        "invalid-message-syntax",
        "原文或译文消息语法无效，数量检查未执行。",
        projection,
      ),
    ]);

  const sourceOptions = quantityOptions(quantityPolicy!.source, projection.key);
  const targetOptions = quantityOptions(quantityPolicy!.target, projection.key);
  const sourceText = projection.source.text;
  const targetText = projection.target.text;
  const sourceBranches = source.branches.map((branch) => ({
    values: [
      ...branchFacts(sourceProfile, source, sourceText, branch, sourceOptions),
    ],
  }));
  const targetBranches = target.branches.map((branch) => ({
    values: [
      ...branchFacts(targetProfile, target, targetText, branch, targetOptions),
    ],
  }));
  const differences = compareQuantityBranches({
    source: sourceBranches,
    target: targetBranches,
  });
  const sourceObjectValue = sourceObject(projection.key);
  const targetObjectValue = translationObject(projection);
  const diagnostics = differences.map((difference) => {
    const targetBranch = target.branches[difference.targetBranchIndex]!;
    const targetLocation = {
      ...projection.locations.target,
      span: targetBranch.range,
    };
    return {
      severity: "error" as const,
      object: translationObject(projection, "quantity-mismatch"),
      location: targetLocation,
      message: `译文分支 ${difference.targetBranchIndex + 1} 的数值或时间单位与原文不对应。`,
      evidence: [
        {
          role: "source-quantity-branches",
          object: sourceObjectValue,
          location: projection.locations.source,
          value: { text: sourceText, branches: sourceBranches },
        },
        {
          role: "target-quantity-branches",
          object: targetObjectValue,
          location: targetLocation,
          value: { text: targetText, branches: targetBranches },
        },
        {
          role: "quantity-difference",
          object: targetObjectValue,
          location: targetLocation,
          value: difference,
        },
      ],
    };
  });
  return completeOutcome(diagnostics);
}

function quantityOptions(
  policy: VueI18nQuantityPolicy,
  key: string,
): QuantityOptions {
  const specific = policy.byKey?.[key];
  return {
    ...(policy.aliases === undefined && specific?.aliases === undefined
      ? {}
      : {
          aliases: {
            ...policy.aliases,
            ...specific?.aliases,
          },
        }),
    ...((specific?.defaultUnit ?? policy.defaultUnit) === undefined
      ? {}
      : { defaultUnit: specific?.defaultUnit ?? policy.defaultUnit }),
    ...((policy.ignoredLiterals?.length ?? 0) === 0 &&
    (specific?.ignoredLiterals?.length ?? 0) === 0
      ? {}
      : {
          ignoredLiterals: [
            ...(policy.ignoredLiterals ?? []),
            ...(specific?.ignoredLiterals ?? []),
          ],
        }),
  };
}

function branchFacts(
  profile: QuantityProfile,
  message: VueI18nMessage,
  text: string,
  branch: VueI18nMessageBranch,
  options: QuantityOptions,
): Set<string> {
  const values = profile.facts(branch.text, options);
  for (const token of message.tokens) {
    if (token.start < branch.range.start || token.end > branch.range.end)
      continue;
    const unit = profile.unitAfter(text.slice(token.end), options);
    if (unit) values.add(`变量单位:${token.identity}:${unit}`);
  }
  return values;
}

function fullRange(text: string) {
  return { start: 0, end: text.length };
}
