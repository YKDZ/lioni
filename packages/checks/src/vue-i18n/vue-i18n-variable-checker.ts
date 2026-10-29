import type {
  QualityCheckOutcome,
  QualityCheckProjectionInput,
  QualityEvidence,
  QualityIssue,
  QualityObject,
  TranslationUnitInput,
} from "@lioni/core";
import { bindQualityCheck, snapshotJsonValue } from "@lioni/core";
import type { MemoScope } from "@lioni/memo";
import { z } from "zod";

import { vueI18nDependencies } from "./dependencies.ts";
import { memoizedVueI18nMessage } from "./message-memo.ts";
import {
  memoizedVueI18nProjection,
  vueI18nMessageProjectionSchema,
} from "./quality-projection.ts";
import type {
  VueI18nMessageProjection,
  VueI18nProjector,
} from "./quality-types.ts";
import type { VueI18nMessage } from "./vue-i18n-messages.ts";
import { VUE_I18N_MESSAGE_COMPILER_VERSION } from "./vue-i18n-messages.ts";

type VariableCount = {
  readonly identity: string;
  readonly count: number;
};

type VariablePattern = {
  readonly key: string;
  readonly variables: readonly VariableCount[];
};

export type VueI18nVariableCorrespondenceCheckerOptions<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable = never,
> = {
  readonly id?: string;
  readonly hostVersion: string;
  readonly project: VueI18nProjector<TUnit, TTranslation, TBody, TUnavailable>;
};

const configurationSchema = z.object({
  compilerVersion: z.literal(VUE_I18N_MESSAGE_COMPILER_VERSION),
  comparison: z.literal("branch-variable-count-patterns-v1"),
});
type Configuration = z.output<typeof configurationSchema>;

const configuration: Configuration = {
  compilerVersion: VUE_I18N_MESSAGE_COMPILER_VERSION,
  comparison: "branch-variable-count-patterns-v1",
};

/** 严格比较原译各分支中的命名与位置变量身份及出现次数。 */
export function createVueI18nVariableCorrespondenceChecker<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable = never,
>(
  options: VueI18nVariableCorrespondenceCheckerOptions<
    TUnit,
    TTranslation,
    TBody,
    TUnavailable
  >,
) {
  type Subject = VueI18nMessageProjection;
  return bindQualityCheck<
    TUnit,
    TTranslation,
    typeof configurationSchema,
    typeof vueI18nMessageProjectionSchema,
    Subject,
    QualityObject,
    TBody,
    TUnavailable
  >({
    id: options.id ?? "vue-i18n/variable-correspondence",
    version: `checks.vue-i18n/variable-correspondence/v2+@intlify/message-compiler@${VUE_I18N_MESSAGE_COMPILER_VERSION}+${options.hostVersion}`,
    configurationSchema,
    configuration,
    inputSchema: vueI18nMessageProjectionSchema,
    select: async (input) => {
      if (!vueI18nDependencies(input).policies.has(input.candidate.language))
        return { status: "not-applicable" };
      const projection = await memoizedVueI18nProjection(
        input,
        options.project,
      );
      if (projection.target.status === "missing")
        return { status: "not-applicable" };
      if (projection.target.status === "unavailable")
        return incompleteSelection(
          "candidateBodyUnavailable",
          "目标消息正文不可用，Vue I18n 检查未执行。",
        );
      if (projection.source.status === "absent")
        return { status: "not-applicable" };
      if (projection.source.status === "unavailable")
        return incompleteSelection(
          "sourceUnavailable",
          "原文正文不可用，无法检查变量对应。",
        );
      return { status: "selected", subject: projection };
    },
    project: (
      input: QualityCheckProjectionInput<
        TUnit,
        TTranslation,
        Configuration,
        Subject,
        TBody,
        TUnavailable
      >,
    ) => ({ status: "ready", value: input.subject }),
    fingerprintInput: ({ projected }) =>
      snapshotJsonValue(projected, "Vue I18n 检查投影"),
    check: (input) => compareVariables(input.projected, input.memo),
  });
}

function compareVariables(
  projection: VueI18nMessageProjection,
  memo: MemoScope,
): QualityCheckOutcome {
  if (
    projection.source.status !== "available" ||
    projection.target.status !== "available"
  )
    return incompleteOutcome([
      issue(
        "messageBodyUnavailable",
        "变量对应检查所需的原文或译文正文不可用。",
        projection,
      ),
    ]);

  const source = memoizedVueI18nMessage(projection.source.text, memo);
  const target = memoizedVueI18nMessage(projection.target.text, memo);
  const syntaxIssues = invalidSyntaxIssues(projection, source, target);
  if (syntaxIssues.length > 0) return incompleteOutcome(syntaxIssues);

  const sourcePatterns = variablePatterns(source);
  const targetPatterns = variablePatterns(target);
  const sourcePatternKeys = new Set(sourcePatterns.map(({ key }) => key));
  const targetPatternKeys = new Set(targetPatterns.map(({ key }) => key));
  const missing = sourcePatterns.filter(
    ({ key }) => !targetPatternKeys.has(key),
  );
  const extra = targetPatterns.filter(({ key }) => !sourcePatternKeys.has(key));
  if (missing.length === 0 && extra.length === 0) return completeOutcome([]);

  const sourceObject: QualityObject = {
    kind: "source-unit",
    key: projection.key,
  };
  const targetObject: QualityObject = {
    kind: "translation-unit",
    key: projection.key,
    language: projection.language,
  };
  const sourceLocation = { ...projection.locations.source };
  const targetLocation = { ...projection.locations.target };
  const evidence: readonly QualityEvidence[] = [
    {
      role: "source-variable-patterns",
      object: sourceObject,
      location: sourceLocation,
      value: { text: projection.source.text, patterns: sourcePatterns },
    },
    {
      role: "target-variable-patterns",
      object: targetObject,
      location: targetLocation,
      value: { text: projection.target.text, patterns: targetPatterns },
    },
    {
      role: "variable-pattern-difference",
      object: targetObject,
      location: targetLocation,
      value: { missing, extra },
    },
  ];
  return completeOutcome([
    {
      severity: "error",
      object: targetObject,
      location: targetLocation,
      message: describeDifference(missing, extra),
      evidence,
    },
  ]);
}

function variablePatterns(message: VueI18nMessage): readonly VariablePattern[] {
  const patterns = new Map<string, VariablePattern>();
  for (const branch of message.branches) {
    const counts = new Map<string, number>();
    for (const variable of branch.variables)
      counts.set(variable, (counts.get(variable) ?? 0) + 1);
    const variables = [...counts]
      .map(([identity, count]) => ({ identity, count }))
      .sort((left, right) => compareText(left.identity, right.identity));
    const key = JSON.stringify(variables);
    patterns.set(key, { key, variables });
  }
  return [...patterns.values()].sort((left, right) =>
    compareText(left.key, right.key),
  );
}

function invalidSyntaxIssues(
  projection: VueI18nMessageProjection,
  source: VueI18nMessage,
  target: VueI18nMessage,
) {
  const issues: QualityIssue[] = [];
  if (source.errors.length > 0)
    issues.push({
      code: "sourceMessageSyntaxInvalid",
      message: "原文语法无效，变量对应检查未执行。",
      object: { kind: "source-unit", key: projection.key },
      location: projection.locations.source,
    });
  if (target.errors.length > 0)
    issues.push({
      code: "targetMessageSyntaxInvalid",
      message: "译文语法无效，变量对应检查未执行。",
      object: {
        kind: "translation-unit",
        key: projection.key,
        language: projection.language,
      },
      location: projection.locations.target,
    });
  return issues;
}

function describeDifference(
  missing: readonly VariablePattern[],
  extra: readonly VariablePattern[],
): string {
  return [
    ...(missing.length === 0
      ? []
      : [`译文缺少变量模式：${missing.map(describePattern).join("；")}。`]),
    ...(extra.length === 0
      ? []
      : [`译文多出变量模式：${extra.map(describePattern).join("；")}。`]),
  ].join("");
}

function describePattern(pattern: VariablePattern): string {
  return pattern.variables.length === 0
    ? "无变量"
    : pattern.variables
        .map(({ identity, count }) => `${identity} × ${count}`)
        .join("、");
}

function completeOutcome(
  diagnostics: QualityCheckOutcome["diagnostics"],
): QualityCheckOutcome {
  return {
    status: "complete",
    diagnostics,
    issues: [],
    coverage: {
      selected: 1,
      evaluated: 1,
      notApplicable: 0,
      incomplete: 0,
      failed: 0,
    },
  };
}

function incompleteOutcome(
  issues: QualityCheckOutcome["issues"],
): QualityCheckOutcome {
  return {
    status: "incomplete",
    diagnostics: [],
    issues,
    coverage: {
      selected: 1,
      evaluated: 0,
      notApplicable: 0,
      incomplete: 1,
      failed: 0,
    },
  };
}

function issue(
  code: string,
  message: string,
  projection: VueI18nMessageProjection,
): QualityIssue {
  return {
    code,
    message,
    object: {
      kind: "translation-unit",
      key: projection.key,
      language: projection.language,
    },
    location: projection.locations.target,
  };
}

function incompleteSelection(code: string, message: string) {
  return { status: "incomplete" as const, issue: { code, message } };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
