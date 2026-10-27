import type {
  QualityCheckOutcome,
  QualityIssue,
  QualityLocation,
  TranslationUnitInput,
} from "@lioni/core";

import { memoizedVueI18nMessage } from "../message-memo.ts";
import type {
  VueI18nCheckIdentity,
  VueI18nPolicy,
  VueI18nProjector,
} from "../quality-types.ts";
import type { VueI18nUsageIndex } from "../usage-types.ts";
import {
  VUE_I18N_BABEL_PARSER_VERSION,
  VUE_I18N_VUE_COMPILER_VERSION,
} from "../versions.ts";
import { VUE_I18N_MESSAGE_COMPILER_VERSION } from "../vue-i18n-messages.ts";
import {
  completeOutcome,
  createVueI18nMessageCheck,
  finding,
  incompleteOutcome,
  issue,
  messageLocation,
  translationObject,
} from "./common.ts";

export function createCallArgumentCheck<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable = never,
>(options: {
  readonly identity: VueI18nCheckIdentity;
  readonly project: VueI18nProjector<TUnit, TTranslation, TBody, TUnavailable>;
  readonly policies: ReadonlyMap<string, VueI18nPolicy>;
  readonly usages: VueI18nUsageIndex;
}) {
  const version = [
    "vue-i18n-suite/call-arguments/v1",
    `@intlify/message-compiler@${VUE_I18N_MESSAGE_COMPILER_VERSION}`,
    `@babel/parser@${VUE_I18N_BABEL_PARSER_VERSION}`,
    `@vue/compiler-dom@${VUE_I18N_VUE_COMPILER_VERSION}`,
    `@vue/compiler-sfc@${VUE_I18N_VUE_COMPILER_VERSION}`,
    ...(options.identity.hostVersion ? [options.identity.hostVersion] : []),
  ].join("+");
  return createVueI18nMessageCheck({
    id: options.identity.id,
    version,
    project: options.project,
    policies: options.policies,
    requiresSource: false,
    requiresTarget: true,
    applies: (projection) =>
      options.usages.entries.some((usage) => usage.key === projection.key) ||
      options.usages.unresolved.length > 0 ||
      options.usages.errors.length > 0,
    check: (input) =>
      evaluateCallArguments(input.projected, input.memo, options.usages),
  });
}

function evaluateCallArguments(
  projection: import("../quality-types.ts").VueI18nMessageProjection,
  memo: import("@lioni/memo").MemoScope,
  usageIndex: VueI18nUsageIndex,
): QualityCheckOutcome {
  if (projection.target.status !== "available")
    return incompleteOutcome([
      issue("targetUnavailable", "目标消息正文不可用。", projection),
    ]);
  const message = memoizedVueI18nMessage(projection.target.text, memo);
  if (message.errors.length > 0)
    return incompleteOutcome([
      issue(
        "targetMessageSyntaxInvalid",
        "译文语法无效，调用参数检查未执行。",
        projection,
      ),
    ]);

  const diagnostics = [];
  const issues: QualityIssue[] = [];
  const usages = usageIndex.entries.filter(
    (usage) => usage.key === projection.key,
  );
  for (const usage of usages) {
    if (!usage.parametersKnown) {
      issues.push({
        code: "callParametersUnknown",
        message: `调用点 ${usage.file} 的参数无法完整静态确定。`,
      });
      continue;
    }
    for (const branch of message.branches) {
      const variables = new Set(branch.variables);
      for (const variable of variables) {
        if (usage.supplied.includes(variable)) continue;
        const token = message.tokens.find(
          (candidate) =>
            candidate.kind === "variable" &&
            candidate.identity === variable &&
            candidate.start >= branch.range.start &&
            candidate.end <= branch.range.end,
        );
        const range = token ?? branch.range;
        const span = { start: range.start, end: range.end };
        const location = messageLocation(projection, span);
        diagnostics.push(
          finding(
            projection,
            "call-argument-missing",
            `调用点 ${usage.file} 未提供译文使用的变量 ${variable}。`,
            span,
            [
              {
                role: "target-variable",
                object: translationObject(projection),
                location,
                value: variable,
              },
              {
                role: "call-site",
                object: translationObject(projection),
                location: usageLocation(projection.key, usage.file),
                value: usage,
              },
            ],
          ),
        );
      }
    }
  }

  if (usageIndex.unresolved.length > 0 || usageIndex.errors.length > 0) {
    const count = usageIndex.unresolved.length + usageIndex.errors.length;
    issues.push({
      code: "callUsageIndexIncomplete",
      message: `有 ${count} 个调用点无法静态关联到消息键，调用参数覆盖不完整。`,
    });
  }
  return issues.length === 0
    ? completeOutcome(diagnostics)
    : incompleteOutcome(issues, diagnostics);
}

function usageLocation(key: string, file: string): QualityLocation {
  return { language: null, range: file, key };
}
