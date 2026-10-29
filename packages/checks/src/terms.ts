import {
  bindQualityCheck,
  type Awaitable,
  type QualityCheckInput,
  type QualityCheckProjection,
  type QualityCheckProjectionInput,
  type QualityCheckRuleInput,
  type QualityCheckSelection,
  type QualityEvidence,
  type QualityInputBasis,
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
  /** 宿主提供的识别策略、规则、选择、投影和位置映射的语义版本。 */
  readonly hostVersion: string;
  readonly terms:
    | CompiledTerms
    | ((
        input: QualityCheckInput<
          TUnit,
          TTranslation,
          TermRulesConfiguration,
          TBody,
          TUnavailable
        >,
      ) => Awaitable<CompiledTerms>);
  readonly rule: TermRule;
  /**
   * 显式替换默认业务依据；须涵盖投影、检查对象、位置映射及其他实际依赖。
   * 工厂额外纳入本次使用的术语库数据，核心保留检查身份、版本和配置。
   * 未提供时沿用核心的完整事实依据；函数行为变化须更新 hostVersion。
   */
  readonly fingerprintInput?: (
    input: QualityCheckRuleInput<
      TUnit,
      TTranslation,
      TermRulesConfiguration,
      TSubject,
      TermComparisonInput,
      TBody,
      TUnavailable
    >,
  ) => QualityInputBasis;
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
    readonly subject: TSubject;
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
  const fingerprintInput = options.fingerprintInput;
  return bindQualityCheck<
    TUnit,
    TTranslation,
    typeof termRulesConfigurationSchema,
    typeof termComparisonInputSchema,
    { readonly value: TSubject; readonly terms: CompiledTerms },
    import("@lioni/core").QualityObject,
    TBody,
    TUnavailable
  >({
    id: options.id ?? `terminology/${rule.id}`,
    version: `checks.terminology-rule/v2+${options.hostVersion}`,
    configurationSchema: termRulesConfigurationSchema,
    configuration: { rules: [rule.id] },
    inputSchema: termComparisonInputSchema,
    async select(input) {
      const selection = await options.select(input);
      if (selection.status !== "selected") return selection;
      // 在指纹计算前解析资料，指纹与规则计算始终消费同一次加载的结果。
      const terms =
        typeof options.terms === "function"
          ? await options.terms(input)
          : options.terms;
      return {
        status: "selected",
        subject: { value: selection.subject, terms },
      };
    },
    project: (input) =>
      options.project({ ...input, subject: input.subject.value }),
    ...(fingerprintInput === undefined
      ? {}
      : {
          fingerprintInput: (input) => ({
            input: fingerprintInput({ ...input, subject: input.subject.value }),
            termbase: input.subject.terms.termbase.data,
          }),
        }),
    async check(input) {
      const report = await evaluateTerms(input.subject.terms, input.projected, {
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
            subject: input.subject.value,
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
