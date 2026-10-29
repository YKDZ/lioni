import type { StandardSchemaV1 } from "@standard-schema/spec";
import { z } from "zod";

import {
  contractIssue,
  contractIssues,
  TermContractError,
  type TermConceptData,
} from "./data.ts";
import {
  comparisonSnapshot,
  sameJson,
  type TermComparisonInput,
} from "./input.ts";
import {
  findTerms,
  resolveTermMatches,
  type CompiledTerms,
  type TermMatch,
  type TermMatches,
  type TermRuntime,
} from "./matching.ts";

export const termRuleIdSchema = z.enum([
  "require-allowed-translation",
  "reject-forbidden-translation",
]);
const termRuleSchema = z.object({ id: termRuleIdSchema }).readonly();
export type TermRuleId =
  | "require-allowed-translation"
  | "reject-forbidden-translation";
export type TermRule = { readonly id: TermRuleId };

const termRulesSchema = z.array(termRuleSchema);

const allowedRule: TermRule = Object.freeze({
  id: "require-allowed-translation",
});
const forbiddenRule: TermRule = Object.freeze({
  id: "reject-forbidden-translation",
});
const defaultRules = Object.freeze([allowedRule, forbiddenRule]);

export function requireAllowedTranslation(): TermRule {
  return allowedRule;
}
export function rejectForbiddenTranslation(): TermRule {
  return forbiddenRule;
}

export const rulesConfigurationContract = z
  .object({ rules: z.array(termRuleIdSchema).readonly() })
  .readonly();
export type TermRulesConfiguration = { readonly rules: readonly TermRuleId[] };
export const termRulesConfigurationSchema: StandardSchemaV1<TermRulesConfiguration> =
  {
    "~standard": rulesConfigurationContract["~standard"],
  };

export type TermGroupAnalysis = {
  readonly source: TermMatches;
  readonly target: TermMatches;
  readonly applicableConcepts: readonly TermConceptData[];
};

export type TermUseAnalysis = {
  readonly input: TermComparisonInput;
  readonly groups: readonly TermGroupAnalysis[];
};

/** 识别信息独立于规则；目标端只解释源端确定适用的概念。 */
export async function analyzeTermUse(
  terms: CompiledTerms,
  input: TermComparisonInput,
  runtime: TermRuntime = {},
): Promise<TermUseAnalysis> {
  const snapshot = comparisonSnapshot(input);
  const groups: TermGroupAnalysis[] = [];
  for (const group of snapshot.groups) {
    const source = await findTerms(terms, group.source, runtime);
    const ids = [...new Set(source.certain.map((match) => match.conceptId))];
    const target = ids.length
      ? await findTerms(terms, group.target, { ...runtime, conceptIds: ids })
      : resolveTermMatches([]);
    groups.push(
      Object.freeze({
        source,
        target,
        applicableConcepts: Object.freeze(
          ids.map((id) => terms.termbase.getConcept(id)!),
        ),
      }),
    );
  }
  return Object.freeze({ input: snapshot, groups: Object.freeze(groups) });
}

export type TermProblem = {
  readonly code: "missing-allowed-translation" | "forbidden-translation";
  readonly ruleId: TermRuleId;
  readonly message: string;
  readonly groupIndex: number;
  readonly conceptId: string;
  readonly sourceMatches: readonly TermMatch[];
  readonly targetMatches: readonly TermMatch[];
};

export type TermAssessmentIssue = {
  readonly code: string;
  readonly message: string;
  readonly groupIndex: number;
  readonly conceptId?: string;
  readonly ruleId?: TermRuleId;
};

export type TermAssessment = {
  readonly status: "complete" | "incomplete";
  readonly problems: readonly TermProblem[];
  readonly issues: readonly TermAssessmentIssue[];
};

export type TermAssessmentOptions = { readonly rules?: readonly TermRule[] };
export type EvaluateTermsOptions = TermAssessmentOptions & TermRuntime;

function selectedRules(options: TermAssessmentOptions): readonly TermRule[] {
  const rules = options.rules ?? defaultRules;
  const result = termRulesSchema.safeParse(rules);
  if (!result.success)
    throw new TermContractError("input", contractIssues(result.error));
  return [...new Map(rules.map((rule) => [rule.id, rule])).values()];
}

/** 只消费已有信息，不分词、查缓存或访问外部资料。 */
export function assessTermUse(
  input: TermComparisonInput,
  analysis: TermUseAnalysis,
  options: TermAssessmentOptions = {},
): TermAssessment {
  if (
    !sameJson(input, analysis.input) ||
    input.groups.length !== analysis.groups.length
  )
    throw new TermContractError("input", [
      contractIssue(
        "analysis-input-mismatch",
        "术语分析与本次比较输入不一致。",
      ),
    ]);
  const rules = selectedRules(options);
  if (!rules.length)
    return Object.freeze({
      status: "complete",
      problems: Object.freeze([]),
      issues: Object.freeze([]),
    });
  const problems: TermProblem[] = [];
  const issues: TermAssessmentIssue[] = [];
  const issueKeys = new Set<string>();
  const addIssue = (issue: TermAssessmentIssue) => {
    const key = JSON.stringify([
      issue.groupIndex,
      issue.conceptId,
      issue.ruleId,
      issue.code,
    ]);
    if (!issueKeys.has(key)) {
      issueKeys.add(key);
      issues.push(Object.freeze(issue));
    }
  };
  for (const [groupIndex, group] of input.groups.entries()) {
    const evidence = analysis.groups[groupIndex]!;
    if (group.source.complete === false)
      addIssue({
        code: "incomplete-source-scope",
        message: "原文比较范围不完整，可能还有未识别的适用概念。",
        groupIndex,
      });
    for (const issue of evidence.source.issues.filter(
      ({ code }) => code !== "incomplete-scope",
    ))
      addIssue({
        code: issue.code,
        message: issue.message,
        groupIndex,
        ...(issue.conceptId === undefined
          ? {}
          : { conceptId: issue.conceptId }),
      });
    if (evidence.source.ambiguities.length)
      addIssue({
        code: "ambiguous-source",
        message: "部分原文术语归属不确定，未据此强行触发概念约束。",
        groupIndex,
      });
    for (const concept of evidence.applicableConcepts) {
      const sourceMatches = evidence.source.certain.filter(
        (match) => match.conceptId === concept.id,
      );
      const certain = evidence.target.certain.filter(
        (match) => match.conceptId === concept.id,
      );
      const uncertain = evidence.target.ambiguities
        .flatMap((ambiguity) => ambiguity.matches)
        .filter((match) => match.conceptId === concept.id);
      const expressions =
        concept.languages.find(
          (language) => language.language === group.target.language,
        )?.expressions ?? [];
      const targetIssues = evidence.target.issues.filter(
        (issue) =>
          issue.code !== "incomplete-scope" &&
          (issue.conceptId === undefined || issue.conceptId === concept.id),
      );
      for (const rule of rules) {
        const context = { groupIndex, conceptId: concept.id, ruleId: rule.id };
        if (rule.id === "require-allowed-translation") {
          if (
            !expressions.some((expression) => expression.usage !== "forbidden")
          ) {
            addIssue({
              ...context,
              code: "missing-allowed-expressions",
              message: `概念 ${concept.id} 缺少 ${group.target.language} 的允许表达资料。`,
            });
            continue;
          }
          if (certain.some((match) => match.usage !== "forbidden")) continue;
          let incomplete = false;
          if (group.target.complete === false) {
            incomplete = true;
            addIssue({
              ...context,
              code: "incomplete-target-scope",
              message: "目标范围不完整，不能根据未命中判定缺少允许表达。",
            });
          }
          for (const issue of targetIssues) {
            incomplete = true;
            addIssue({ ...context, code: issue.code, message: issue.message });
          }
          if (uncertain.some((match) => match.usage !== "forbidden")) {
            incomplete = true;
            addIssue({
              ...context,
              code: "ambiguous-target",
              message: "目标表达的概念归属不确定，无法判定允许表达是否满足。",
            });
          }
          if (!incomplete)
            problems.push(
              Object.freeze({
                ...context,
                code: "missing-allowed-translation",
                message: `目标内容缺少概念 ${concept.id} 的允许表达。`,
                sourceMatches: Object.freeze(sourceMatches),
                targetMatches: Object.freeze(certain),
              }),
            );
        } else {
          const forbidden = certain.filter(
            (match) => match.usage === "forbidden",
          );
          if (forbidden.length)
            problems.push(
              Object.freeze({
                ...context,
                code: "forbidden-translation",
                message: `目标内容使用了概念 ${concept.id} 的禁用表达。`,
                sourceMatches: Object.freeze(sourceMatches),
                targetMatches: Object.freeze(forbidden),
              }),
            );
          if (
            !expressions.some((expression) => expression.usage === "forbidden")
          )
            continue;
          if (group.target.complete === false)
            addIssue({
              ...context,
              code: "incomplete-target-scope",
              message: "目标范围不完整，已识别的禁用表达仍单独报告。",
            });
          for (const issue of targetIssues)
            addIssue({ ...context, code: issue.code, message: issue.message });
          if (uncertain.some((match) => match.usage === "forbidden"))
            addIssue({
              ...context,
              code: "ambiguous-target",
              message:
                "目标表达可能属于多个概念，未将不确定的禁用地位判为违规。",
            });
        }
      }
    }
  }
  return Object.freeze({
    status: issues.length ? "incomplete" : "complete",
    problems: Object.freeze(problems),
    issues: Object.freeze(issues),
  });
}

/** 完整入口复用同一分析与判断实现；关闭全部规则时不进行分析。 */
export async function evaluateTerms(
  terms: CompiledTerms,
  input: TermComparisonInput,
  options: EvaluateTermsOptions = {},
): Promise<TermAssessment> {
  const rules = selectedRules(options);
  if (!rules.length) {
    comparisonSnapshot(input);
    return Object.freeze({
      status: "complete",
      problems: Object.freeze([]),
      issues: Object.freeze([]),
    });
  }
  const analysis = await analyzeTermUse(terms, input, options);
  return assessTermUse(input, analysis, { rules });
}
