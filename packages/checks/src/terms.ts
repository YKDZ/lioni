import {
  bindQualityCheck,
  type Awaitable,
  type QualityCheckInput,
  type QualityCheckProjection,
  type QualityCheckProjectionInput,
  type QualityCheckSelection,
  type QualityEvidence,
  type QualityLocation,
  type TranslationUnitInput,
} from "@lioni/core";
import {
  evaluateTerms,
  termComparisonInputSchema,
  termRulesConfigurationSchema,
  type CompiledTerms,
  type JsonValue,
  type TermComparisonInput,
  type TermMatch,
  type TermRule,
  type TermRulesConfiguration,
} from "@lioni/terminology";

export type TermCheckerOptions<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TSubject,
  TBody = unknown,
  TUnavailable = never,
> = {
  readonly id?: string;
  /** 宿主提供的术语资料、选择、投影和位置映射的版本。 */
  readonly hostVersion: string;
  readonly terms: CompiledTerms;
  readonly rule: TermRule;
  readonly select: (
    input: QualityCheckInput<
      TUnit,
      TTranslation,
      TermRulesConfiguration,
      TBody,
      TUnavailable
    >,
  ) => Awaitable<QualityCheckSelection<TSubject>>;
  readonly project: (
    input: QualityCheckProjectionInput<
      TUnit,
      TTranslation,
      TermRulesConfiguration,
      TSubject,
      TBody,
      TUnavailable
    >,
  ) => Awaitable<QualityCheckProjection<TermComparisonInput>>;
  /** 将片段引用映射为宿主位置；字符区间另存于 span，不覆盖宿主资源范围。 */
  readonly location?: (input: {
    readonly ref: JsonValue;
    readonly language: string;
    readonly sourceKey: string;
    readonly side: "source" | "target";
  }) => QualityLocation;
};

/** 一次绑定一条独立术语规则；识别、歧义与规则判断全部由术语包负责。 */
export function createTermChecker<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TSubject,
  TBody = unknown,
  TUnavailable = never,
>(
  options: TermCheckerOptions<
    TUnit,
    TTranslation,
    TSubject,
    TBody,
    TUnavailable
  >,
) {
  const rule = options.rule;
  const terms = options.terms;
  return bindQualityCheck<
    TUnit,
    TTranslation,
    typeof termRulesConfigurationSchema,
    typeof termComparisonInputSchema,
    TSubject,
    import("@lioni/core").QualityObject,
    TBody,
    TUnavailable
  >({
    id: options.id ?? `terminology/${rule.id}`,
    version: `checks.terminology-rule/v1+${options.hostVersion}`,
    configurationSchema: termRulesConfigurationSchema,
    configuration: { rules: [rule.id] },
    inputSchema: termComparisonInputSchema,
    select: options.select,
    project: options.project,
    async check(input) {
      const report = await evaluateTerms(terms, input.projected, {
        rules: [rule],
        memo: input.memo,
      });
      const object = {
        kind: "translation",
        key: input.candidate.sourceKey,
        language: input.candidate.language,
      };
      function location(
        ref: JsonValue,
        language: string,
        side: "source" | "target",
      ) {
        return (
          options.location?.({
            ref,
            language,
            side,
            sourceKey: object.key,
          }) ?? {
            language,
            range: ref,
            key: object.key,
          }
        );
      }
      function evidence(
        match: TermMatch,
        side: "source" | "target",
      ): QualityEvidence {
        return {
          role: side === "source" ? "source-term" : "target-term",
          object: {
            ...object,
            kind: side === "source" ? "source" : "translation",
            language: match.language,
          },
          location: {
            ...location(match.ref, match.language, side),
            span: match.range,
          },
          value: match,
        };
      }
      const diagnostics = report.problems.map((problem) => {
        const group = input.projected.groups[problem.groupIndex]!;
        const target = problem.targetMatches[0];
        const ref =
          target?.ref ?? group.target.fragments[0]?.ref ?? group.ref ?? null;
        return {
          severity: "error" as const,
          object: {
            ...object,
            conceptId: problem.conceptId,
            groupIndex: problem.groupIndex,
            code: problem.code,
          },
          location: {
            ...location(ref, group.target.language, "target"),
            ...(target === undefined ? {} : { span: target.range }),
          },
          message: problem.message,
          evidence: [
            ...problem.sourceMatches.map((match) => evidence(match, "source")),
            ...problem.targetMatches.map((match) => evidence(match, "target")),
          ],
        };
      });
      const incomplete = report.status === "incomplete";
      const empty = input.projected.groups.length === 0;
      return {
        status: incomplete
          ? "incomplete"
          : empty
            ? "not-applicable"
            : "complete",
        diagnostics,
        issues: report.issues.map((issue) => ({
          code: issue.code,
          message: issue.message,
          object: {
            ...object,
            groupIndex: issue.groupIndex,
            ...(issue.conceptId === undefined
              ? {}
              : { conceptId: issue.conceptId }),
            ...(issue.ruleId === undefined ? {} : { ruleId: issue.ruleId }),
          },
        })),
        coverage: {
          selected: 1,
          evaluated: !incomplete && !empty ? 1 : 0,
          notApplicable: empty ? 1 : 0,
          incomplete: incomplete ? 1 : 0,
          failed: 0,
        },
      };
    },
  });
}
