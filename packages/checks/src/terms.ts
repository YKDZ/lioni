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
  type QualityCheckDefinition,
  type QualityDataLoadInput,
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
  TId extends string | undefined = undefined,
  TRule extends TermRule = TermRule,
> = {
  readonly id?: TId;
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
  /** 只在检查项已选且存在候选时读取；可用同一 qualityData reader 显式共享。 */
  readonly loadDependencies?: (
    input: QualityDataLoadInput<TUnit, TTranslation, TBody, TUnavailable>,
  ) => Awaitable<unknown>;
  readonly rule: TRule;
  /**
   * 显式替换默认业务依据；须涵盖投影、检查对象、位置映射及其他实际依赖。
   * 工厂额外纳入本次使用的术语库数据，核心保留检查身份、版本和配置。
   * 未提供时沿用核心的完整事实依据；函数行为变化须更新 hostVersion。
   * 回调返回后核心立即校验并摘要；此处只读访问共享输入。
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
function createTermCheckerImplementation<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TSubject,
  TBody = unknown,
  TUnavailable = never,
  const TRule extends TermRule = TermRule,
>(
  options: TermCheckerOptions<
    TUnit,
    TTranslation,
    TSubject,
    TBody,
    TUnavailable,
    undefined,
    TRule
  > & { readonly id?: undefined },
): QualityCheckDefinition<
  TUnit,
  TTranslation,
  import("@lioni/core").QualityObject,
  TBody,
  TUnavailable,
  `terminology/${TRule["id"]}`
>;
function createTermCheckerImplementation<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TSubject,
  TBody = unknown,
  TUnavailable = never,
  const TRule extends TermRule = TermRule,
  const TId extends string = string,
>(
  options: TermCheckerOptions<
    TUnit,
    TTranslation,
    TSubject,
    TBody,
    TUnavailable,
    TId,
    TRule
  > & { readonly id: TId },
): QualityCheckDefinition<
  TUnit,
  TTranslation,
  import("@lioni/core").QualityObject,
  TBody,
  TUnavailable,
  TId
>;
function createTermCheckerImplementation<
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
    TUnavailable,
    string | undefined,
    TermRule
  >,
): QualityCheckDefinition<
  TUnit,
  TTranslation,
  import("@lioni/core").QualityObject,
  TBody,
  TUnavailable,
  string
>;
function createTermCheckerImplementation<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TSubject,
  TBody = unknown,
  TUnavailable = never,
  TRule extends TermRule = TermRule,
  TId extends string | undefined = undefined,
>(
  options: TermCheckerOptions<
    TUnit,
    TTranslation,
    TSubject,
    TBody,
    TUnavailable,
    TId,
    TRule
  >,
): QualityCheckDefinition<
  TUnit,
  TTranslation,
  import("@lioni/core").QualityObject,
  TBody,
  TUnavailable,
  string
> {
  const rule = options.rule;
  const fingerprintInput = options.fingerprintInput;
  const loadDependencies = options.loadDependencies;
  return bindQualityCheck<
    TUnit,
    TTranslation,
    typeof termRulesConfigurationSchema,
    typeof termComparisonInputSchema,
    { readonly value: TSubject; readonly terms: CompiledTerms },
    import("@lioni/core").QualityObject,
    TBody,
    TUnavailable,
    string
  >({
    id: options.id ?? `terminology/${rule.id}`,
    version: `checks.terminology-rule/v2+${options.hostVersion}`,
    configurationSchema: termRulesConfigurationSchema,
    configuration: { rules: [rule.id] },
    inputSchema: termComparisonInputSchema,
    ...(loadDependencies === undefined ? {} : { loadDependencies }),
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

function createTermCheckerWithTypes<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TSubject,
  TBody = unknown,
  TUnavailable = never,
>() {
  function create<const TRule extends TermRule>(
    options: TermCheckerOptions<
      TUnit,
      TTranslation,
      TSubject,
      TBody,
      TUnavailable,
      undefined,
      TRule
    >,
  ): QualityCheckDefinition<
    TUnit,
    TTranslation,
    import("@lioni/core").QualityObject,
    TBody,
    TUnavailable,
    `terminology/${TRule["id"]}`
  >;
  function create<const TRule extends TermRule, const TId extends string>(
    options: TermCheckerOptions<
      TUnit,
      TTranslation,
      TSubject,
      TBody,
      TUnavailable,
      TId,
      TRule
    > & { readonly id: TId },
  ): QualityCheckDefinition<
    TUnit,
    TTranslation,
    import("@lioni/core").QualityObject,
    TBody,
    TUnavailable,
    TId
  >;
  function create(
    options: TermCheckerOptions<
      TUnit,
      TTranslation,
      TSubject,
      TBody,
      TUnavailable,
      string | undefined,
      TermRule
    >,
  ): QualityCheckDefinition<
    TUnit,
    TTranslation,
    import("@lioni/core").QualityObject,
    TBody,
    TUnavailable,
    string
  > {
    return createTermCheckerImplementation<
      TUnit,
      TTranslation,
      TSubject,
      TBody,
      TUnavailable
    >(options);
  }
  return create;
}

/** 术语规则工厂；显式业务泛型先经 withTypes 绑定，规则与覆盖 ID 由本次调用推断。 */
export const createTermChecker = Object.assign(
  createTermCheckerImplementation,
  {
    withTypes: createTermCheckerWithTypes,
  },
);
