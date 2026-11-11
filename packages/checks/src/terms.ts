import {
  assertJsonValue,
  defineChecker,
  QualityCheckerContractError,
  StandardSchemaContractError,
  type Awaitable,
  type CheckerDefinition,
  type CheckerLoadInput,
  type CheckerPrepareInput,
  type QualityCheckDefinition,
  type QualityIssue,
  type QualityLocation,
  type QualityObject,
  type StandardSchemaV1,
  type TranslationUnitInput,
} from "@lioni/core";
import {
  analyzeTermUse,
  assessTermUse,
  rejectForbiddenTranslation,
  requireAllowedTranslation,
  termComparisonInputSchema,
  type CompiledTerms,
  type JsonValue,
  TermContractError,
  type TermComparisonInput,
  type TermMatch,
  type TermRule,
  type TermRuleId,
  type TermUseAnalysis,
} from "@lioni/terminology";

export type TermCheckerLoaded<TContext> = {
  /** 编译器对象只在本次检查运行中交接，不进入指纹或报告。 */
  readonly terms: CompiledTerms;
  /** 术语规则适配器按需读取的附加运行时上下文。 */
  readonly context: TContext;
};

export type TermCheckerPreparation<TSubject> =
  | { readonly status: "not-applicable" }
  | { readonly status: "incomplete"; readonly issue: QualityIssue }
  | {
      readonly status: "ready";
      readonly comparison: TermComparisonInput;
      readonly subject: TSubject;
    };

export type TermCheckerLocationInput<TSubject> = {
  readonly ref: JsonValue;
  readonly language: string;
  readonly sourceKey: string;
  readonly side: "source" | "target";
  readonly subject: TSubject;
  readonly groupIndex: number;
  readonly fragmentIndex?: number;
};

export type TermCheckerGroupLocations = {
  readonly source: readonly QualityLocation[];
  readonly target: readonly QualityLocation[];
  readonly targetFallback: QualityLocation;
};

/** check 消费的固定 JSON 输入；完整分析保留命中、歧义、缺失和覆盖信息。 */
export type TermCheckerInput = {
  readonly sourceKey: string;
  readonly language: string;
  readonly ruleId: TermRuleId;
  /** 完整术语分析的固定 JSON 快照，运行时交给术语判断。 */
  readonly analysis: JsonValue;
  readonly locations: readonly TermCheckerGroupLocations[];
};

export type TermCheckerOptions<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TSubject,
  TBody = unknown,
  TUnavailable = never,
  TId extends string | undefined = undefined,
  TRule extends TermRule = TermRule,
  TContext = undefined,
> = {
  /** 普通或可选 string ID 返回 string，并使配置中的检查项联合退化为 string。 */
  readonly id?: TId;
  /** 静态编译结果，或在本次 load 中读取并编译的术语资料。 */
  readonly terms:
    | CompiledTerms
    | ((
        input: CheckerLoadInput<TUnit, TTranslation, TBody, TUnavailable>,
      ) => Awaitable<CompiledTerms>);
  /** 术语规则适配器所需的附加资料；和术语编译结果一并在 load 中准备。 */
  readonly load?: (
    input: CheckerLoadInput<TUnit, TTranslation, TBody, TUnavailable>,
  ) => Awaitable<TContext>;
  readonly rule: TRule;
  /** 将当前候选适配为术语比较；函数只在 prepare 阶段运行。 */
  readonly prepare: (
    input: CheckerPrepareInput<
      TUnit,
      TTranslation,
      TBody,
      TUnavailable,
      TermCheckerLoaded<TContext>
    >,
  ) => Awaitable<TermCheckerPreparation<TSubject>>;
  /** 在 prepare 中把术语片段引用映射为稳定的宿主资源位置。 */
  readonly location?: (
    input: TermCheckerLocationInput<TSubject>,
  ) => QualityLocation;
};

const termCheckerVersion = "checks.terminology-rule/v3";

/** 一次绑定一条规则；加载资料和分析在 prepare 中交接给纯判断。 */
function createTermCheckerImplementation<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TSubject,
  TBody = unknown,
  TUnavailable = never,
  const TRule extends TermRule = TermRule,
  TContext = undefined,
>(
  options: TermCheckerOptions<
    TUnit,
    TTranslation,
    TSubject,
    TBody,
    TUnavailable,
    undefined,
    TRule,
    TContext
  > & { readonly id?: undefined },
): QualityCheckDefinition<
  TUnit,
  TTranslation,
  QualityObject,
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
  TContext = undefined,
>(
  options: TermCheckerOptions<
    TUnit,
    TTranslation,
    TSubject,
    TBody,
    TUnavailable,
    TId,
    TRule,
    TContext
  > & { readonly id: TId },
): QualityCheckDefinition<
  TUnit,
  TTranslation,
  QualityObject,
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
  TContext = undefined,
>(
  options: TermCheckerOptions<
    TUnit,
    TTranslation,
    TSubject,
    TBody,
    TUnavailable,
    string | undefined,
    TermRule,
    TContext
  >,
): QualityCheckDefinition<
  TUnit,
  TTranslation,
  QualityObject,
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
  TContext = undefined,
>(
  options: TermCheckerOptions<
    TUnit,
    TTranslation,
    TSubject,
    TBody,
    TUnavailable,
    TId,
    TRule,
    TContext
  >,
): QualityCheckDefinition<
  TUnit,
  TTranslation,
  QualityObject,
  TBody,
  TUnavailable,
  string
> {
  validateTermCheckerOptions(options);
  const ruleId = options.rule.id;
  const checkerId = options.id ?? `terminology/${ruleId}`;
  const load = async (
    input: CheckerLoadInput<TUnit, TTranslation, TBody, TUnavailable>,
  ): Promise<TermCheckerLoaded<TContext>> => {
    try {
      const [terms, context] = await Promise.all([
        typeof options.terms === "function"
          ? options.terms(input)
          : options.terms,
        options.load?.(input),
      ]);
      return { terms, context: context as TContext };
    } catch (error) {
      if (error instanceof TermContractError)
        throw new StandardSchemaContractError(
          "术语检查资料",
          "schema-mismatch",
          "术语检查资料不符合术语 schema。",
          undefined,
          { cause: error },
        );
      throw error;
    }
  };
  const prepare = async (
    input: CheckerPrepareInput<
      TUnit,
      TTranslation,
      TBody,
      TUnavailable,
      TermCheckerLoaded<TContext>
    >,
  ) => {
    const prepared = await options.prepare(input);
    if (!isTermCheckerPreparation(prepared))
      throw new QualityCheckerContractError(
        checkerId,
        "prepare",
        "的 prepare 返回了无效结果。",
      );
    if (prepared.status !== "ready") return prepared;

    const comparison = await validateComparisonInput(prepared.comparison);
    const analysis = await analyzeTermUse(input.loaded.terms, comparison, {
      memo: input.memo,
    });
    const sourceRange =
      input.facts.source.read.scopes[input.sourceUnit.scopeIndex]?.range ??
      null;
    const targetRange = input.translation?.range ?? null;
    const locations = comparison.groups.map((group, groupIndex) => {
      const mapLocation = (
        ref: JsonValue,
        language: string,
        side: "source" | "target",
        fragmentIndex?: number,
      ) =>
        options.location?.({
          ref,
          language,
          side,
          sourceKey: input.candidate.sourceKey,
          subject: prepared.subject,
          groupIndex,
          ...(fragmentIndex === undefined ? {} : { fragmentIndex }),
        }) ?? {
          language: side === "source" ? null : language,
          range: side === "source" ? sourceRange : targetRange,
          key: input.candidate.sourceKey,
        };
      const source = group.source.fragments.map((fragment, fragmentIndex) =>
        mapLocation(
          fragment.ref,
          group.source.language,
          "source",
          fragmentIndex,
        ),
      );
      const target = group.target.fragments.map((fragment, fragmentIndex) =>
        mapLocation(
          fragment.ref,
          group.target.language,
          "target",
          fragmentIndex,
        ),
      );
      const targetFallback =
        target[0] ??
        mapLocation(group.ref ?? null, group.target.language, "target");
      return { source, target, targetFallback };
    });
    return {
      status: "ready" as const,
      input: {
        sourceKey: input.candidate.sourceKey,
        language: input.candidate.language,
        ruleId,
        analysis,
        locations,
      },
    };
  };
  const definition: CheckerDefinition<
    typeof termCheckerInputSchema,
    TermCheckerLoaded<TContext>,
    TUnit,
    TTranslation,
    TBody,
    TUnavailable
  > = {
    id: checkerId,
    version: termCheckerVersion,
    inputSchema: termCheckerInputSchema,
    load,
    prepare,
    check: checkTermUse,
  };
  return defineChecker.withTypes<TUnit, TTranslation, TBody, TUnavailable>()(
    definition,
  ) as QualityCheckDefinition<
    TUnit,
    TTranslation,
    QualityObject,
    TBody,
    TUnavailable,
    string
  >;
}

function createTermCheckerWithTypes<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TSubject,
  TBody = unknown,
  TUnavailable = never,
>() {
  function create<const TRule extends TermRule, TContext = undefined>(
    options: TermCheckerOptions<
      TUnit,
      TTranslation,
      TSubject,
      TBody,
      TUnavailable,
      undefined,
      TRule,
      TContext
    >,
  ): QualityCheckDefinition<
    TUnit,
    TTranslation,
    QualityObject,
    TBody,
    TUnavailable,
    `terminology/${TRule["id"]}`
  >;
  function create<
    const TRule extends TermRule,
    const TId extends string,
    TContext = undefined,
  >(
    options: TermCheckerOptions<
      TUnit,
      TTranslation,
      TSubject,
      TBody,
      TUnavailable,
      TId,
      TRule,
      TContext
    > & { readonly id: TId },
  ): QualityCheckDefinition<
    TUnit,
    TTranslation,
    QualityObject,
    TBody,
    TUnavailable,
    TId
  >;
  function create<TRule extends TermRule, TContext = undefined>(
    options: TermCheckerOptions<
      TUnit,
      TTranslation,
      TSubject,
      TBody,
      TUnavailable,
      string | undefined,
      TRule,
      TContext
    >,
  ): QualityCheckDefinition<
    TUnit,
    TTranslation,
    QualityObject,
    TBody,
    TUnavailable,
    string
  >;
  function create(
    options: TermCheckerOptions<
      TUnit,
      TTranslation,
      TSubject,
      TBody,
      TUnavailable,
      string | undefined,
      TermRule,
      unknown
    >,
  ): QualityCheckDefinition<
    TUnit,
    TTranslation,
    QualityObject,
    TBody,
    TUnavailable,
    string
  > {
    return createTermCheckerImplementation<
      TUnit,
      TTranslation,
      TSubject,
      TBody,
      TUnavailable,
      unknown
    >(options);
  }
  return create;
}

/**
 * 术语规则工厂；显式宿主泛型先经 withTypes 绑定，规则与覆盖 ID 由调用推断。
 * 规则识别分析由工厂完成；prepare 只适配当前候选的术语比较及宿主上下文。
 */
export const createTermChecker = Object.assign(
  createTermCheckerImplementation,
  {
    withTypes: createTermCheckerWithTypes,
  },
);

function validateTermCheckerOptions(options: {
  readonly id?: string | undefined;
  readonly terms: unknown;
  readonly load?: unknown;
  readonly rule: unknown;
  readonly prepare: unknown;
  readonly location?: unknown;
}): void {
  const ruleId = isRecord(options.rule) ? options.rule.id : undefined;
  if (
    ruleId !== "require-allowed-translation" &&
    ruleId !== "reject-forbidden-translation"
  )
    throw new TypeError("术语检查器 rule 必须是受支持的术语规则。");
  if (typeof options.prepare !== "function")
    throw new TypeError("术语检查器必须提供 prepare 函数。");
  if (options.load !== undefined && typeof options.load !== "function")
    throw new TypeError("术语检查器 load 必须是函数。");
  if (options.location !== undefined && typeof options.location !== "function")
    throw new TypeError("术语检查器 location 必须是函数。");
  if (
    typeof options.terms !== "function" &&
    !isCompiledTermsShape(options.terms)
  )
    throw new TypeError("术语检查器 terms 必须是编译结果或加载函数。");
}

function isCompiledTermsShape(value: unknown): value is CompiledTerms {
  return (
    isRecord(value) &&
    isRecord(value.termbase) &&
    Array.isArray(value.languages) &&
    isRecord(value.analysis)
  );
}

function isTermCheckerPreparation<TSubject>(
  value: unknown,
): value is TermCheckerPreparation<TSubject> {
  return (
    isRecord(value) &&
    (value.status === "not-applicable" ||
      (value.status === "incomplete" && isQualityIssue(value.issue)) ||
      (value.status === "ready" &&
        Object.hasOwn(value, "comparison") &&
        Object.hasOwn(value, "subject")))
  );
}

function isQualityIssue(value: unknown): value is QualityIssue {
  return (
    isRecord(value) &&
    typeof value.code === "string" &&
    typeof value.message === "string"
  );
}

async function validateComparisonInput(
  value: unknown,
): Promise<TermComparisonInput> {
  assertJsonValue(value, "术语投影输入");
  let result: Awaited<
    ReturnType<(typeof termComparisonInputSchema)["~standard"]["validate"]>
  >;
  try {
    result = await termComparisonInputSchema["~standard"].validate(value);
  } catch (error) {
    throw new StandardSchemaContractError(
      "术语投影输入",
      "schema-threw",
      "术语投影输入的 Standard Schema 执行失败。",
      undefined,
      { cause: error },
    );
  }
  if ("issues" in result) {
    const issues = result.issues ?? [];
    throw new StandardSchemaContractError(
      "术语投影输入",
      "schema-mismatch",
      `术语投影输入不符合 Standard Schema：${issues
        .map(({ message }) => message)
        .join("；")}`,
      issues,
    );
  }
  if (!Object.hasOwn(result, "value"))
    throw new StandardSchemaContractError(
      "术语投影输入",
      "invalid-schema-result",
      "术语投影输入的 Standard Schema 返回了无效结果。",
    );
  assertJsonValue(result.value, "术语分析输入");
  return result.value;
}

function checkTermUse(input: TermCheckerInput) {
  const analysis = input.analysis as unknown as TermUseAnalysis;
  const assessment = assessTermUse(analysis.input, analysis, {
    rules: [ruleFromId(input.ruleId)],
  });
  const object = {
    kind: "translation",
    key: input.sourceKey,
    language: input.language,
  };
  const location = (
    groupIndex: number,
    side: "source" | "target",
    fragmentIndex: number,
  ) => input.locations[groupIndex]![side][fragmentIndex]!;
  const evidence = (
    match: TermMatch,
    groupIndex: number,
    side: "source" | "target",
  ) => ({
    role: side === "source" ? "source-term" : "target-term",
    object: {
      ...object,
      kind: side === "source" ? "source" : "translation",
      language: match.language,
    },
    location: {
      ...location(groupIndex, side, match.fragmentIndex),
      span: match.range,
    },
    value: match,
  });
  const diagnostics = assessment.problems.map((problem) => {
    const target = problem.targetMatches[0];
    const targetLocation =
      target === undefined
        ? input.locations[problem.groupIndex]!.targetFallback
        : location(problem.groupIndex, "target", target.fragmentIndex);
    return {
      severity: "error" as const,
      object: {
        ...object,
        conceptId: problem.conceptId,
        groupIndex: problem.groupIndex,
        code: problem.code,
      },
      location: {
        ...targetLocation,
        ...(target === undefined ? {} : { span: target.range }),
      },
      message: problem.message,
      evidence: [
        ...problem.sourceMatches.map((match) =>
          evidence(match, problem.groupIndex, "source"),
        ),
        ...problem.targetMatches.map((match) =>
          evidence(match, problem.groupIndex, "target"),
        ),
      ],
    };
  });
  const incomplete = assessment.status === "incomplete";
  const empty = analysis.input.groups.length === 0;
  return {
    status: incomplete
      ? ("incomplete" as const)
      : empty
        ? ("not-applicable" as const)
        : ("complete" as const),
    diagnostics,
    issues: assessment.issues.map((issue) => ({
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
}

function ruleFromId(ruleId: TermRuleId): TermRule {
  return ruleId === "require-allowed-translation"
    ? requireAllowedTranslation()
    : rejectForbiddenTranslation();
}

function isTermCheckerInput(value: unknown): value is TermCheckerInput {
  if (!isRecord(value)) return false;
  const analysis = value.analysis;
  const locations = value.locations;
  const analysisInput = isRecord(analysis) ? analysis.input : undefined;
  const groups = isRecord(analysisInput) ? analysisInput.groups : undefined;
  if (
    typeof value.sourceKey !== "string" ||
    typeof value.language !== "string" ||
    (value.ruleId !== "require-allowed-translation" &&
      value.ruleId !== "reject-forbidden-translation") ||
    !Array.isArray(groups) ||
    !Array.isArray(locations) ||
    locations.length !== groups.length
  )
    return false;
  return locations.every((entry, groupIndex) => {
    const group = groups[groupIndex];
    if (!isRecord(group)) return false;
    const source = isRecord(group.source) ? group.source.fragments : undefined;
    const target = isRecord(group.target) ? group.target.fragments : undefined;
    return (
      Array.isArray(source) &&
      Array.isArray(target) &&
      isRecord(entry) &&
      Array.isArray(entry.source) &&
      entry.source.length === source.length &&
      entry.source.every(isQualityLocation) &&
      Array.isArray(entry.target) &&
      entry.target.length === target.length &&
      entry.target.every(isQualityLocation) &&
      isQualityLocation(entry.targetFallback)
    );
  });
}

function isQualityLocation(value: unknown): value is QualityLocation {
  return (
    isRecord(value) &&
    (value.language === null || typeof value.language === "string") &&
    Object.hasOwn(value, "range")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const termCheckerInputSchema: StandardSchemaV1<
  TermCheckerInput,
  TermCheckerInput
> = {
  "~standard": {
    version: 1,
    vendor: "lioni-checks-terminology",
    validate(value) {
      return isTermCheckerInput(value)
        ? { value }
        : {
            issues: [
              { message: "术语检查输入必须包含固定分析和对应宿主位置。" },
            ],
          };
    },
  },
};
