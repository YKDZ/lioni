import { isDeepStrictEqual } from "node:util";

import { readFacts } from "./index.ts";
import type {
  ActualTranslationFact,
  Awaitable,
  CoverageStatus,
  FrameworkConfig,
  FrameworkFacts,
  SourceReadFact,
  SourceUnitFact,
  TranslationAssociationFact,
  TranslationUnitInput,
} from "./index.ts";
import {
  assertJsonValue,
  snapshotJsonValue,
  StandardSchemaContractError,
  validateWithStandardSchema,
} from "./standard-schema.ts";
import type { JsonValue } from "./standard-schema.ts";

export type { JsonValue } from "./standard-schema.ts";

export type SemanticEditTarget = {
  readonly kind: "existing" | "create";
  readonly locator: JsonValue;
};

export type SemanticEditCandidate<TBody = JsonValue> = {
  readonly sourceKey: string;
  readonly language: string;
  readonly content: TBody;
};

export type SemanticEditSourceExpectation =
  | {
      readonly presence: "present";
      readonly range: JsonValue;
      readonly unit: JsonValue;
      readonly content: JsonValue;
    }
  | {
      readonly presence: "removed";
      readonly range: JsonValue;
      readonly historicalContent: JsonValue;
    };

export type SemanticEditTargetExpectation<TBody = JsonValue> =
  | { readonly status: "missing" }
  | {
      readonly status: "present";
      readonly content: TBody;
      readonly range: JsonValue;
      readonly scopes: readonly JsonValue[];
    };

type SemanticEditExpected<TBody = JsonValue> = {
  readonly source: SemanticEditSourceExpectation;
  readonly target: SemanticEditTargetExpectation<TBody>;
  readonly dependencies: JsonValue;
};

type SemanticEditBase<TBody = JsonValue> = {
  readonly createdFromFactsVersion: string;
  readonly sourceKey: string;
  readonly language: string;
  readonly target: SemanticEditTarget;
  readonly expected: SemanticEditExpected<TBody>;
};

export type SemanticEdit<TBody = JsonValue> =
  | (SemanticEditBase<TBody> & {
      readonly formatVersion: "lioni.semantic-edit/v2";
      readonly operation: "write";
      readonly content: TBody;
      readonly target: SemanticEditTarget;
      readonly expected: SemanticEditExpected<TBody> & {
        readonly source: Extract<
          SemanticEditSourceExpectation,
          { presence: "present" }
        >;
      };
    })
  | (SemanticEditBase<TBody> & {
      readonly formatVersion: "lioni.semantic-edit/v2";
      readonly operation: "delete";
      readonly content?: never;
      readonly target: SemanticEditTarget & { readonly kind: "existing" };
      readonly expected: SemanticEditExpected<TBody> & {
        readonly source: Extract<
          SemanticEditSourceExpectation,
          { presence: "removed" }
        >;
        readonly target: Extract<
          SemanticEditTargetExpectation<TBody>,
          { status: "present" }
        >;
      };
    });

export type SemanticEditInput<TBody = JsonValue> = {
  readonly createdFromFactsVersion: string;
  readonly sourceKey: string;
  readonly language: string;
  readonly target: SemanticEditTarget;
  readonly expected: SemanticEditExpected<TBody> & {
    readonly source: Extract<
      SemanticEditSourceExpectation,
      { presence: "present" }
    >;
  };
};

export type SemanticDeleteInput<TBody = JsonValue> = {
  readonly createdFromFactsVersion: string;
  readonly sourceKey: string;
  readonly language: string;
  readonly target: SemanticEditTarget & { readonly kind: "existing" };
  readonly expected: SemanticEditExpected<TBody> & {
    readonly source: Extract<
      SemanticEditSourceExpectation,
      { presence: "removed" }
    >;
    readonly target: Extract<
      SemanticEditTargetExpectation<TBody>,
      { status: "present" }
    >;
  };
};

export type SemanticEditSubject = {
  readonly sourceKey: string;
  readonly language: string;
};

export type EditTargetResolution =
  | { readonly status: "located"; readonly locator: JsonValue }
  | { readonly status: "notWritable"; readonly reason: string };

type AvailableTranslationFact<TTranslation, TBody, TUnavailable> = Extract<
  ActualTranslationFact<TTranslation, TBody, TUnavailable>,
  { readonly bodyAvailability: "available" }
>;

export type TranslationWritebackAdapter<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody = JsonValue,
  TUnavailable = never,
> = {
  readonly locateExistingTarget: (input: {
    readonly sourceUnit: SourceUnitFact<TUnit>;
    readonly translation: AvailableTranslationFact<
      TTranslation,
      TBody,
      TUnavailable
    >;
  }) => Awaitable<EditTargetResolution>;
  readonly locateNewTarget: (input: {
    readonly sourceUnit: SourceUnitFact<TUnit>;
    readonly language: string;
  }) => Awaitable<EditTargetResolution>;
  readonly dependencies?: (input: {
    readonly sourceUnit: SourceUnitFact<TUnit>;
    readonly language: string;
    readonly association: TranslationAssociationFact;
    readonly translations: readonly AvailableTranslationFact<
      TTranslation,
      TBody,
      TUnavailable
    >[];
  }) => Awaitable<JsonValue | undefined>;
  readonly write?: (input: {
    readonly edit: SemanticEdit<TBody>;
    readonly sourceUnit: SourceUnitFact<TUnit>;
    readonly target: SemanticEditTarget;
    readonly currentTranslation?: AvailableTranslationFact<
      TTranslation,
      TBody,
      TUnavailable
    >;
  }) => Awaitable<void>;
};

export type SemanticEditPreparation<TBody = JsonValue> =
  | { readonly status: "prepared"; readonly edit: SemanticEdit<TBody> }
  | { readonly status: "notWritable"; readonly reason: string };

export type SemanticEditInputResolution<TBody = JsonValue> =
  | { readonly status: "resolved"; readonly input: SemanticEditInput<TBody> }
  | { readonly status: "notWritable"; readonly reason: string };

export type SemanticDeleteInputResolution<TBody = JsonValue> =
  | { readonly status: "resolved"; readonly input: SemanticDeleteInput<TBody> }
  | { readonly status: "notWritable"; readonly reason: string };

export type SemanticEditObservation<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody = JsonValue,
  TUnavailable = never,
> = {
  readonly factsVersion: string;
  readonly sourceReadStatus: SourceReadFact["status"];
  readonly translationReadStatus: CoverageStatus | null;
  readonly sourceUnit: SourceUnitFact<TUnit> | null;
  readonly association: TranslationAssociationFact | null;
  readonly translations: readonly ActualTranslationFact<
    TTranslation,
    TBody,
    TUnavailable
  >[];
};

export type SemanticEditResult<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody = JsonValue,
  TUnavailable = never,
> = {
  readonly sourceKey: string;
  readonly language: string;
  readonly status:
    | "written"
    | "writeUnconfirmed"
    | "conflict"
    | "notWritable"
    | "writeFailed"
    | "unprocessed";
  readonly reason?: string;
  readonly before?: SemanticEditObservation<
    TUnit,
    TTranslation,
    TBody,
    TUnavailable
  >;
  readonly after?: SemanticEditObservation<
    TUnit,
    TTranslation,
    TBody,
    TUnavailable
  >;
};

export type SemanticEditBatchResult<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody = JsonValue,
  TUnavailable = never,
> = {
  readonly results: readonly SemanticEditResult<
    TUnit,
    TTranslation,
    TBody,
    TUnavailable
  >[];
};

export async function resolveSemanticEditInput<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  facts: FrameworkFacts<TUnit, TTranslation, TBody, TUnavailable>,
  subject: SemanticEditSubject,
  config: FrameworkConfig<TUnit, TTranslation, TBody, TUnavailable>,
): Promise<SemanticEditInputResolution<TBody>> {
  const adapter = config.translationWriteback;
  if (adapter === undefined)
    return {
      status: "notWritable",
      reason: "宿主没有提供译文目标解析能力。",
    };

  const sourceUnit = facts.source.units.find(
    ({ key }) => key === subject.sourceKey,
  );
  if (sourceUnit === undefined)
    return { status: "notWritable", reason: "找不到候选对应的原文单元。" };
  if (sourceUnit.bodyAvailability !== "available")
    return {
      status: "notWritable",
      reason: "原文正文不可用，无法核对编辑输入。",
    };
  const sourceScope = facts.source.read.scopes[sourceUnit.scopeIndex];
  if (sourceScope === undefined)
    return {
      status: "notWritable",
      reason: "找不到原文单元对应的读取范围。",
    };

  const association = facts.associations.find(
    ({ sourceKey, language }) =>
      sourceKey === subject.sourceKey && language === subject.language,
  );
  if (association === undefined)
    return {
      status: "notWritable",
      reason: `目标语言 ${subject.language} 不在当前源译事实中。`,
    };
  if (association.status === "unknown")
    return {
      status: "notWritable",
      reason: "目标范围读取不完整，无法确认唯一写入目标。",
    };
  if (association.status === "conflict")
    return {
      status: "notWritable",
      reason: "当前义务匹配到多条译文，无法确定唯一写入目标。",
    };
  if (association.status === "unavailable")
    return {
      status: "notWritable",
      reason: "现有译文正文不可用，无法核对目标输入。",
    };
  if (
    (association.status === "matched" || association.status === "missing") &&
    association.coverageStatus !== "complete"
  )
    return {
      status: "notWritable",
      reason: "目标范围读取不完整，无法确认唯一写入目标。",
    };

  let currentTranslation:
    | AvailableTranslationFact<TTranslation, TBody, TUnavailable>
    | undefined;
  let targetScopes: JsonValue[] = [];
  if (association.status === "matched") {
    if (association.translationIndexes.length !== 1)
      return {
        status: "notWritable",
        reason: "关联结果没有唯一译文索引。",
      };
    const matchedTranslation =
      facts.translations.records[association.translationIndexes[0] as number];
    if (
      matchedTranslation === undefined ||
      matchedTranslation.bodyAvailability !== "available"
    )
      return {
        status: "notWritable",
        reason: "现有译文正文不可用，无法核对目标输入。",
      };
    currentTranslation = matchedTranslation;
    const translationRead = facts.translations.reads.find(
      ({ language }) => language === subject.language,
    );
    targetScopes = association.scopeIndexes.flatMap((scopeIndex) => {
      const scope = translationRead?.scopes[scopeIndex];
      return scope === undefined
        ? []
        : [snapshotJson(scope.range, "目标译文范围")];
    });
  }

  const translations =
    currentTranslation === undefined ? [] : [currentTranslation];
  let target: SemanticEditTarget;
  let expectedTarget: SemanticEditTargetExpectation<TBody>;
  try {
    const resolution =
      currentTranslation === undefined
        ? await adapter.locateNewTarget({
            sourceUnit,
            language: subject.language,
          })
        : await adapter.locateExistingTarget({
            sourceUnit,
            translation: currentTranslation,
          });
    if (resolution.status === "notWritable")
      return { status: "notWritable", reason: resolution.reason };
    target = {
      kind: currentTranslation === undefined ? "create" : "existing",
      locator: snapshotJson(resolution.locator, "目标定位"),
    };
    expectedTarget =
      currentTranslation === undefined
        ? { status: "missing" }
        : {
            status: "present",
            content: snapshotValue(currentTranslation.content, "现有译文正文"),
            range: snapshotJson(currentTranslation.range, "目标译文范围"),
            scopes: targetScopes,
          };
    const dependencies = await adapter.dependencies?.({
      sourceUnit,
      language: subject.language,
      association,
      translations,
    });
    return {
      status: "resolved",
      input: {
        createdFromFactsVersion: facts.version,
        sourceKey: subject.sourceKey,
        language: subject.language,
        target,
        expected: {
          source: {
            presence: "present",
            range: snapshotJson(sourceScope.range, "原文范围"),
            unit: snapshotJson(sourceUnit.unit, "完整原文单元"),
            content: snapshotJson(sourceUnit.unit.source, "原文正文"),
          },
          target: expectedTarget,
          dependencies: snapshotJson(dependencies ?? null, "编辑依赖"),
        },
      },
    };
  } catch (error) {
    rethrowContractError(error);
    return {
      status: "notWritable",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/** 根据明确的历史原文及当前目标事实，纯解析可执行删除所需输入。 */
export async function resolveSemanticDeleteInput<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  facts: FrameworkFacts<TUnit, TTranslation, TBody, TUnavailable>,
  subject: SemanticEditSubject,
  historicalSource: TUnit,
  sourceRange: unknown,
  targetScopeRanges: readonly unknown[],
  config: FrameworkConfig<TUnit, TTranslation, TBody, TUnavailable>,
): Promise<SemanticDeleteInputResolution<TBody>> {
  const adapter = config.translationWriteback;
  const matches = config.translations?.matches;
  if (adapter === undefined || matches === undefined)
    return {
      status: "notWritable",
      reason: "宿主没有提供删除目标解析能力。",
    };
  if (facts.source.units.some(({ key }) => key === subject.sourceKey))
    return {
      status: "notWritable",
      reason: "原文仍然存在，不能准备删除译文。",
    };

  let sourceRangeSnapshot: JsonValue;
  let historicalSourceSnapshot: JsonValue;
  try {
    sourceRangeSnapshot = snapshotJson(sourceRange, "历史原文范围");
    historicalSourceSnapshot = snapshotJson(historicalSource, "历史原文单元");
  } catch (error) {
    rethrowContractError(error);
    return {
      status: "notWritable",
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  const sourceScopeIndexes = facts.source.read.scopes.flatMap((scope, index) =>
    isDeepStrictEqual(scope.range, sourceRangeSnapshot) ? [index] : [],
  );
  if (
    sourceScopeIndexes.length === 0 ||
    sourceScopeIndexes.some(
      (index) => facts.source.read.scopes[index]?.enumeration !== "complete",
    )
  )
    return {
      status: "notWritable",
      reason: "当前原文范围读取不完整，无法确认原文已移除。",
    };

  const translationRead = facts.translations.reads.find(
    ({ language }) => language === subject.language,
  );
  const scopeRanges: JsonValue[] = [];
  for (const value of targetScopeRanges) {
    let range: JsonValue;
    try {
      range = snapshotJson(value, "目标译文范围");
    } catch (error) {
      rethrowContractError(error);
      return {
        status: "notWritable",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    if (scopeRanges.some((existing) => isDeepStrictEqual(existing, range)))
      continue;
    scopeRanges.push(range);
  }
  const targetScopeIndexes = (translationRead?.scopes ?? []).flatMap(
    (scope, index) =>
      scopeRanges.some((range) => isDeepStrictEqual(scope.range, range))
        ? [index]
        : [],
  );
  if (
    translationRead === undefined ||
    scopeRanges.length === 0 ||
    scopeRanges.some(
      (range) =>
        !translationRead.scopes.some((scope) =>
          isDeepStrictEqual(scope.range, range),
        ),
    ) ||
    targetScopeIndexes.some(
      (index) => translationRead.scopes[index]?.enumeration !== "complete",
    )
  )
    return {
      status: "notWritable",
      reason: "目标译文范围读取不完整，无法确认删除目标。",
    };

  const sourceScopeIndex = sourceScopeIndexes[0];
  if (sourceScopeIndex === undefined)
    return {
      status: "notWritable",
      reason: "找不到历史原文对应的读取范围。",
    };
  // 仅为宿主重定位和依赖计算保留的历史输入，不加入当前原文事实。
  const historicalSourceUnit: SourceUnitFact<TUnit> = {
    key: subject.sourceKey,
    unit: historicalSource,
    bodyAvailability: "available",
    scopeIndex: sourceScopeIndex,
  };
  let targetTranslations: ActualTranslationFact<
    TTranslation,
    TBody,
    TUnavailable
  >[];
  try {
    targetTranslations = facts.translations.records.filter(
      (translation) =>
        translation.language === subject.language &&
        scopeRanges.some((range) =>
          isDeepStrictEqual(range, translation.range),
        ) &&
        matches(historicalSource, translation.translation),
    );
  } catch (error) {
    rethrowContractError(error);
    return {
      status: "notWritable",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  if (targetTranslations.length !== 1)
    return {
      status: "notWritable",
      reason:
        targetTranslations.length === 0
          ? "没有可关联到历史原文的现存删除目标。"
          : "历史原文匹配到多条现存译文，无法确定删除目标。",
    };
  const currentTranslation = targetTranslations[0];
  if (
    currentTranslation === undefined ||
    currentTranslation.bodyAvailability !== "available"
  )
    return {
      status: "notWritable",
      reason: "删除目标正文不可用，无法核对预期输入。",
    };

  const association: TranslationAssociationFact = {
    sourceKey: subject.sourceKey,
    language: subject.language,
    status: "matched",
    coverageStatus: "complete",
    scopeIndexes: targetScopeIndexes,
    translationIndexes: [currentTranslation.index],
  };
  try {
    const resolution = await adapter.locateExistingTarget({
      sourceUnit: historicalSourceUnit,
      translation: currentTranslation,
    });
    if (resolution.status === "notWritable")
      return { status: "notWritable", reason: resolution.reason };
    const dependencies = await adapter.dependencies?.({
      sourceUnit: historicalSourceUnit,
      language: subject.language,
      association,
      translations: [currentTranslation],
    });
    const targetContent = snapshotValue(
      currentTranslation.content,
      "待删除译文正文",
    );
    return {
      status: "resolved",
      input: {
        createdFromFactsVersion: facts.version,
        sourceKey: subject.sourceKey,
        language: subject.language,
        target: {
          kind: "existing",
          locator: snapshotJson(resolution.locator, "删除目标位置"),
        },
        expected: {
          source: {
            presence: "removed",
            range: sourceRangeSnapshot,
            historicalContent: historicalSourceSnapshot,
          },
          target: {
            status: "present",
            content: targetContent,
            range: snapshotJson(currentTranslation.range, "目标译文范围"),
            scopes: scopeRanges,
          },
          dependencies: snapshotJson(dependencies ?? null, "编辑依赖"),
        },
      },
    };
  } catch (error) {
    rethrowContractError(error);
    return {
      status: "notWritable",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function validateSemanticEditCandidate<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  value: unknown,
  config: FrameworkConfig<TUnit, TTranslation, TBody, TUnavailable>,
): Promise<SemanticEditCandidate<TBody>> {
  if (
    !isRecord(value) ||
    typeof value.sourceKey !== "string" ||
    typeof value.language !== "string" ||
    !Object.hasOwn(value, "content")
  )
    throw new TypeError(
      "译文候选必须包含字符串 sourceKey、language 和 content。",
    );

  const contentSchema = config.translations?.contentSchema;
  if (contentSchema === undefined)
    throw new TypeError("验证译文候选需要 translations.contentSchema。");
  const content = await validateWithStandardSchema(
    contentSchema,
    value.content,
    "译文候选正文",
    { preserveValue: true, requireJson: true },
  );
  return {
    sourceKey: value.sourceKey,
    language: value.language,
    content: snapshotValue(content, "译文候选正文"),
  };
}

/** 根据已经解析的输入和候选纯计算可保存的语义编辑。 */
export async function prepareSemanticEdit<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  input: SemanticEditInput<TBody>,
  candidateValue: SemanticEditCandidate<TBody>,
  config: FrameworkConfig<TUnit, TTranslation, TBody, TUnavailable>,
): Promise<SemanticEditPreparation<TBody>> {
  const candidate = await validateSemanticEditCandidate(candidateValue, config);
  if (
    input.sourceKey !== candidate.sourceKey ||
    input.language !== candidate.language
  )
    return {
      status: "notWritable",
      reason: "候选与已解析的编辑输入不匹配。",
    };

  try {
    const snapshot = snapshotValue(input, "已解析编辑输入");
    return {
      status: "prepared",
      edit: {
        ...snapshot,
        formatVersion: "lioni.semantic-edit/v2",
        operation: "write",
        content: snapshotValue(candidate.content, "候选内容"),
      },
    };
  } catch (error) {
    rethrowContractError(error);
    return {
      status: "notWritable",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/** 将已经解析的删除输入固化为不含伪造内容值的语义编辑。 */
export function prepareSemanticDeletion<TBody = JsonValue>(
  input: SemanticDeleteInput<TBody>,
): SemanticEditPreparation<TBody> {
  try {
    const snapshot = snapshotValue(input, "已解析删除输入");
    return {
      status: "prepared",
      edit: {
        ...snapshot,
        formatVersion: "lioni.semantic-edit/v2",
        operation: "delete",
      },
    };
  } catch (error) {
    rethrowContractError(error);
    return {
      status: "notWritable",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export type ValidatedSemanticEdit<TUnit extends TranslationUnitInput, TBody> =
  | {
      readonly operation: "write";
      readonly edit: Extract<SemanticEdit<TBody>, { operation: "write" }>;
    }
  | {
      readonly operation: "delete";
      readonly edit: Extract<SemanticEdit<TBody>, { operation: "delete" }>;
      readonly historicalSource: TUnit;
    };

/** 从未知持久数据建立可安全进入当前语义编辑回调的视图。 */
export async function validateSemanticEditHistory<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  value: unknown,
  config: FrameworkConfig<TUnit, TTranslation, TBody, TUnavailable>,
): Promise<ValidatedSemanticEdit<TUnit, TBody>> {
  const snapshot = snapshotValue(value, "保存的语义编辑");
  if (
    !isRecord(snapshot) ||
    snapshot.formatVersion !== "lioni.semantic-edit/v2" ||
    typeof snapshot.createdFromFactsVersion !== "string" ||
    typeof snapshot.sourceKey !== "string" ||
    typeof snapshot.language !== "string" ||
    (snapshot.operation !== "write" && snapshot.operation !== "delete") ||
    !isRecord(snapshot.target) ||
    (snapshot.target.kind !== "existing" &&
      snapshot.target.kind !== "create") ||
    !isRecord(snapshot.expected) ||
    !isRecord(snapshot.expected.source) ||
    !isRecord(snapshot.expected.target) ||
    !Object.hasOwn(snapshot.expected, "dependencies")
  )
    invalidSavedSemanticEdit("结构无效。");

  const expectedSource = snapshot.expected.source;
  const expectedTarget = snapshot.expected.target;
  const targetLocator = snapshot.target.locator;
  const dependencies = snapshot.expected.dependencies;
  const sourceRange = expectedSource.range;
  const targetKind = snapshot.target.kind;
  assertJsonValue(targetLocator, "保存的语义编辑位置");
  assertJsonValue(dependencies, "保存的语义编辑依赖");
  assertJsonValue(sourceRange, "保存的语义编辑原文范围");
  let validatedSourceUnit: TUnit | undefined;
  let validatedSourceContent: JsonValue | undefined;
  let validatedSourceSnapshot: JsonValue | undefined;
  if (expectedSource.presence === "present") {
    if (!Object.hasOwn(expectedSource, "unit"))
      invalidSavedSemanticEdit("正文编辑缺少完整历史原文。");
    validatedSourceUnit = await validateWithStandardSchema(
      config.source.schema,
      expectedSource.unit,
      "保存的语义编辑完整原文",
      { preserveValue: true, requireJson: true },
    );
    validatedSourceSnapshot = snapshotJsonValue(
      validatedSourceUnit,
      "保存的语义编辑完整原文",
    );
    const sourceContent: unknown = validatedSourceUnit.source;
    assertJsonValue(sourceContent, "保存的语义编辑原文正文");
    if (!isDeepStrictEqual(sourceContent, expectedSource.content))
      invalidSavedSemanticEdit("原文正文与完整历史原文不一致。");
    validatedSourceContent = sourceContent;
  }
  const target: SemanticEditTarget = {
    kind: targetKind,
    locator: targetLocator,
  };

  if (expectedTarget.status === "missing") {
    if (snapshot.operation !== "write" || target.kind !== "create")
      invalidSavedSemanticEdit("缺少目标只能用于新建正文编辑。");
    if (Object.hasOwn(expectedTarget, "content"))
      invalidSavedSemanticEdit("缺失目标不能包含预期正文。");
    if (expectedSource.presence !== "present")
      invalidSavedSemanticEdit("正文编辑必须保留当前原文依据。");
    if (
      validatedSourceUnit === undefined ||
      validatedSourceContent === undefined ||
      validatedSourceSnapshot === undefined
    )
      invalidSavedSemanticEdit("正文编辑缺少可验证的完整历史原文。");
    const candidate = await validateSemanticEditCandidate(
      {
        sourceKey: snapshot.sourceKey,
        language: snapshot.language,
        content: snapshot.content,
      },
      config,
    );
    return {
      operation: "write",
      edit: {
        formatVersion: "lioni.semantic-edit/v2",
        operation: "write",
        createdFromFactsVersion: snapshot.createdFromFactsVersion,
        sourceKey: snapshot.sourceKey,
        language: snapshot.language,
        content: candidate.content,
        target,
        expected: {
          source: {
            presence: "present",
            range: sourceRange,
            unit: validatedSourceSnapshot,
            content: validatedSourceContent,
          },
          target: { status: "missing" },
          dependencies,
        },
      },
    };
  }

  if (
    expectedTarget.status !== "present" ||
    !Object.hasOwn(expectedTarget, "content") ||
    !Object.hasOwn(expectedTarget, "range") ||
    !Array.isArray(expectedTarget.scopes)
  )
    invalidSavedSemanticEdit("预期目标结构无效。");
  assertJsonValue(expectedTarget.content, "保存的语义编辑目标正文");
  assertJsonValue(expectedTarget.range, "保存的语义编辑目标范围");
  for (const range of expectedTarget.scopes) {
    assertJsonValue(range, "保存的语义编辑目标范围");
  }
  const contentSchema = config.translations?.contentSchema;
  if (contentSchema === undefined)
    throw new TypeError("验证保存的语义编辑需要 translations.contentSchema。");
  const expectedContent = await validateWithStandardSchema(
    contentSchema,
    expectedTarget.content,
    "保存的语义编辑目标正文",
    { preserveValue: true, requireJson: true },
  );
  const scopes = expectedTarget.scopes;

  if (snapshot.operation === "write") {
    if (target.kind !== "existing" || expectedSource.presence !== "present")
      invalidSavedSemanticEdit("正文编辑的历史目标结构无效。");
    if (
      validatedSourceUnit === undefined ||
      validatedSourceContent === undefined ||
      validatedSourceSnapshot === undefined
    )
      invalidSavedSemanticEdit("正文编辑缺少可验证的完整历史原文。");
    const candidate = await validateSemanticEditCandidate(
      {
        sourceKey: snapshot.sourceKey,
        language: snapshot.language,
        content: snapshot.content,
      },
      config,
    );
    return {
      operation: "write",
      edit: {
        formatVersion: "lioni.semantic-edit/v2",
        operation: "write",
        createdFromFactsVersion: snapshot.createdFromFactsVersion,
        sourceKey: snapshot.sourceKey,
        language: snapshot.language,
        content: candidate.content,
        target,
        expected: {
          source: {
            presence: "present",
            range: sourceRange,
            unit: validatedSourceSnapshot,
            content: validatedSourceContent,
          },
          target: {
            status: "present",
            content: expectedContent,
            range: expectedTarget.range,
            scopes,
          },
          dependencies,
        },
      },
    };
  }

  if (
    snapshot.operation !== "delete" ||
    target.kind !== "existing" ||
    expectedSource.presence !== "removed" ||
    Object.hasOwn(snapshot, "content")
  )
    invalidSavedSemanticEdit("删除编辑的历史目标结构无效。");
  if (!Object.hasOwn(expectedSource, "historicalContent"))
    invalidSavedSemanticEdit("删除编辑缺少历史原文。");
  const historicalSource = await validateWithStandardSchema(
    config.source.schema,
    expectedSource.historicalContent,
    "保存的删除历史原文",
    { preserveValue: true, requireJson: true },
  );
  assertJsonValue(historicalSource, "保存的删除历史原文");
  return {
    operation: "delete",
    edit: {
      formatVersion: "lioni.semantic-edit/v2",
      operation: "delete",
      createdFromFactsVersion: snapshot.createdFromFactsVersion,
      sourceKey: snapshot.sourceKey,
      language: snapshot.language,
      target: { kind: "existing", locator: target.locator },
      expected: {
        source: {
          presence: "removed",
          range: sourceRange,
          historicalContent: historicalSource,
        },
        target: {
          status: "present",
          content: expectedContent,
          range: expectedTarget.range,
          scopes,
        },
        dependencies,
      },
    },
    historicalSource,
  };
}

export async function applySemanticEdits<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  edits: readonly SemanticEdit<TBody>[],
  config: FrameworkConfig<TUnit, TTranslation, TBody, TUnavailable>,
): Promise<SemanticEditBatchResult<TUnit, TTranslation, TBody, TUnavailable>> {
  const results: SemanticEditResult<
    TUnit,
    TTranslation,
    TBody,
    TUnavailable
  >[] = [];
  for (const unvalidatedEdit of edits) {
    const validatedEdit = await validateSemanticEditHistory(
      unvalidatedEdit,
      config,
    );
    const edit = validatedEdit.edit;
    const historicalSource =
      validatedEdit.operation === "delete"
        ? validatedEdit.historicalSource
        : undefined;
    const base = { sourceKey: edit.sourceKey, language: edit.language };
    const adapter = config.translationWriteback;
    if (adapter === undefined || adapter.write === undefined) {
      results.push({
        ...base,
        status: "notWritable",
        reason: "宿主没有提供语义编辑写入能力。",
      });
      continue;
    }

    let facts: FrameworkFacts<TUnit, TTranslation, TBody, TUnavailable>;
    try {
      facts = await readFacts(config);
    } catch (error) {
      rethrowContractError(error);
      results.push({
        ...base,
        status: "unprocessed",
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    const beforeObservation =
      edit.operation === "delete"
        ? readDeleteEditObservation(
            facts,
            edit,
            config,
            requiredHistoricalSource(historicalSource),
          )
        : readEditObservation(facts, edit.sourceKey, edit.language);
    const before = snapshotEditObservation(beforeObservation);
    const validation = await validateSemanticEdit(
      edit,
      beforeObservation,
      facts,
      config,
      historicalSource,
    );
    if (validation.status !== "ready") {
      results.push({
        ...base,
        status: validation.status,
        reason: validation.reason,
        before,
      });
      continue;
    }

    try {
      await adapter.write({
        edit,
        sourceUnit: validation.sourceUnit,
        target: edit.target,
        ...(validation.currentTranslation === undefined
          ? {}
          : { currentTranslation: validation.currentTranslation }),
      });
    } catch (error) {
      rethrowContractError(error);
      let after:
        | SemanticEditObservation<TUnit, TTranslation, TBody, TUnavailable>
        | undefined;
      try {
        const afterFacts = await readFacts(config);
        after = snapshotEditObservation(
          edit.operation === "delete"
            ? readDeleteEditObservation(
                afterFacts,
                edit,
                config,
                requiredHistoricalSource(historicalSource),
              )
            : readEditObservation(afterFacts, edit.sourceKey, edit.language),
        );
      } catch (error) {
        rethrowContractError(error);
        // 保留写入失败结果；回读错误不会覆盖更直接的写入故障。
      }
      results.push({
        ...base,
        status: "writeFailed",
        reason: error instanceof Error ? error.message : String(error),
        before,
        ...(after === undefined ? {} : { after }),
      });
      continue;
    }

    try {
      const afterFacts = await readFacts(config);
      const afterObservation =
        edit.operation === "delete"
          ? readDeleteEditObservation(
              afterFacts,
              edit,
              config,
              requiredHistoricalSource(historicalSource),
            )
          : readEditObservation(afterFacts, edit.sourceKey, edit.language);
      const after = snapshotEditObservation(afterObservation);
      if (
        await confirmsSemanticEdit(
          edit,
          afterObservation,
          afterFacts,
          config,
          historicalSource,
        )
      ) {
        results.push({ ...base, status: "written", before, after });
      } else {
        results.push({
          ...base,
          status: "writeUnconfirmed",
          reason:
            edit.operation === "delete"
              ? "写入已返回成功，但回读未确认明确目标已删除。"
              : "写入已返回成功，但回读结果未确认候选内容。",
          before,
          after,
        });
      }
    } catch (error) {
      rethrowContractError(error);
      results.push({
        ...base,
        status: "writeUnconfirmed",
        reason: `写入已返回成功，但回读失败：${error instanceof Error ? error.message : String(error)}`,
        before,
      });
    }
  }
  return { results };
}

async function validateSemanticEdit<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  edit: SemanticEdit<TBody>,
  observation: SemanticEditObservation<
    TUnit,
    TTranslation,
    TBody,
    TUnavailable
  >,
  facts: FrameworkFacts<TUnit, TTranslation, TBody, TUnavailable>,
  config: FrameworkConfig<TUnit, TTranslation, TBody, TUnavailable>,
  historicalSource: TUnit | undefined,
): Promise<
  | {
      readonly status: "ready";
      readonly sourceUnit: SourceUnitFact<TUnit>;
      readonly currentTranslation?: AvailableTranslationFact<
        TTranslation,
        TBody,
        TUnavailable
      >;
    }
  | {
      readonly status: "conflict" | "notWritable" | "unprocessed";
      readonly reason: string;
    }
> {
  if (edit.formatVersion !== "lioni.semantic-edit/v2")
    return { status: "unprocessed", reason: "不支持的语义编辑版本。" };

  if (edit.operation === "delete")
    return validateSemanticDeletion(
      edit,
      facts,
      config,
      requiredHistoricalSource(historicalSource),
    );

  const adapter = config.translationWriteback;
  if (adapter === undefined)
    return { status: "notWritable", reason: "宿主没有提供译文写回适配器。" };

  const sourceUnit = observation.sourceUnit;
  if (sourceUnit === null) {
    return observation.sourceReadStatus === "complete"
      ? { status: "conflict", reason: "候选对应的原文单元已不存在。" }
      : { status: "unprocessed", reason: "当前原文读取不足，无法核对编辑。" };
  }
  if (sourceUnit.bodyAvailability !== "available")
    return { status: "unprocessed", reason: "当前原文正文不可用。" };

  const currentSourceScope = facts.source.read.scopes[sourceUnit.scopeIndex];
  if (
    currentSourceScope === undefined ||
    !isDeepStrictEqual(currentSourceScope.range, edit.expected.source.range)
  )
    return { status: "conflict", reason: "原文所在范围已变化。" };

  let currentSource: JsonValue;
  try {
    currentSource = snapshotJson(sourceUnit.unit.source, "当前原文正文");
  } catch (error) {
    rethrowContractError(error);
    return {
      status: "unprocessed",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  if (!isDeepStrictEqual(currentSource, edit.expected.source.content))
    return { status: "conflict", reason: "原文正文已变化。" };

  const association = observation.association;
  if (association === null)
    return {
      status: "unprocessed",
      reason:
        observation.translationReadStatus === "failed"
          ? "当前目标语言读取失败，无法核对编辑。"
          : "当前目标语言关联尚未读取。",
    };
  if (association.status === "unknown")
    return {
      status: "unprocessed",
      reason: "目标读取不完整，无法核对唯一写入目标。",
    };
  if (association.status === "conflict")
    return {
      status: "conflict",
      reason: "当前原文匹配到多条实际译文，拒绝写入。",
    };
  if (association.status === "unavailable")
    return {
      status: "unprocessed",
      reason: "当前译文正文不可用，无法核对目标输入。",
    };

  let currentTranslation:
    | AvailableTranslationFact<TTranslation, TBody, TUnavailable>
    | undefined;
  if (edit.expected.target.status === "missing") {
    if (edit.target.kind !== "create")
      return {
        status: "unprocessed",
        reason: "编辑目标类型与预期输入不一致。",
      };
    if (association.status !== "missing")
      return { status: "conflict", reason: "原先缺失的目标现在已存在。" };
    if (association.coverageStatus !== "complete")
      return { status: "unprocessed", reason: "当前目标范围读取不完整。" };
  } else {
    if (edit.target.kind !== "existing")
      return {
        status: "unprocessed",
        reason: "编辑目标类型与预期输入不一致。",
      };
    if (association.status === "missing")
      return { status: "conflict", reason: "原先的目标译文现在已缺失。" };
    if (association.status !== "matched")
      return { status: "conflict", reason: "当前译文不再是唯一匹配目标。" };
    if (association.coverageStatus !== "complete")
      return { status: "unprocessed", reason: "当前目标范围读取不完整。" };
    if (association.translationIndexes.length !== 1)
      return { status: "conflict", reason: "当前译文不再是唯一匹配目标。" };
    const matchedTranslation = observation.translations[0];
    if (
      matchedTranslation === undefined ||
      matchedTranslation.bodyAvailability !== "available"
    )
      return { status: "unprocessed", reason: "当前译文正文不可用。" };
    currentTranslation = matchedTranslation;
    if (
      !isDeepStrictEqual(currentTranslation.range, edit.expected.target.range)
    )
      return { status: "conflict", reason: "目标译文所在范围已变化。" };
    let currentTargetContent: TBody;
    try {
      currentTargetContent = snapshotValue(
        currentTranslation.content,
        "当前译文正文",
      );
    } catch (error) {
      rethrowContractError(error);
      return {
        status: "unprocessed",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    if (!isDeepStrictEqual(currentTargetContent, edit.expected.target.content))
      return { status: "conflict", reason: "目标译文内容已变化。" };
  }

  let dependencies: JsonValue;
  let resolution: EditTargetResolution;
  try {
    dependencies = snapshotJson(
      (await adapter.dependencies?.({
        sourceUnit,
        language: edit.language,
        association,
        translations:
          currentTranslation === undefined ? [] : [currentTranslation],
      })) ?? null,
      "当前编辑依赖",
    );
    resolution =
      currentTranslation === undefined
        ? await adapter.locateNewTarget({ sourceUnit, language: edit.language })
        : await adapter.locateExistingTarget({
            sourceUnit,
            translation: currentTranslation,
          });
  } catch (error) {
    rethrowContractError(error);
    return {
      status: "notWritable",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  if (resolution.status === "notWritable")
    return { status: "notWritable", reason: resolution.reason };
  if (!isDeepStrictEqual(dependencies, edit.expected.dependencies))
    return { status: "conflict", reason: "候选声明的上下文依赖已变化。" };
  if (!isDeepStrictEqual(resolution.locator, edit.target.locator))
    return { status: "conflict", reason: "宿主解析出的实际目标位置已变化。" };

  return {
    status: "ready",
    sourceUnit,
    ...(currentTranslation === undefined ? {} : { currentTranslation }),
  };
}

async function validateSemanticDeletion<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  edit: Extract<SemanticEdit<TBody>, { operation: "delete" }>,
  facts: FrameworkFacts<TUnit, TTranslation, TBody, TUnavailable>,
  config: FrameworkConfig<TUnit, TTranslation, TBody, TUnavailable>,
  historicalSource: TUnit,
): Promise<
  | {
      readonly status: "ready";
      readonly sourceUnit: SourceUnitFact<TUnit>;
      readonly currentTranslation: AvailableTranslationFact<
        TTranslation,
        TBody,
        TUnavailable
      >;
    }
  | {
      readonly status: "conflict" | "notWritable" | "unprocessed";
      readonly reason: string;
    }
> {
  const adapter = config.translationWriteback;
  const matches = config.translations?.matches;
  if (adapter === undefined || matches === undefined)
    return { status: "notWritable", reason: "宿主没有提供删除写回适配器。" };

  if (facts.source.units.some(({ key }) => key === edit.sourceKey))
    return { status: "conflict", reason: "已移除的原文单元重新出现。" };
  const sourceScopeIndexes = facts.source.read.scopes.flatMap((scope, index) =>
    isDeepStrictEqual(scope.range, edit.expected.source.range) ? [index] : [],
  );
  if (
    sourceScopeIndexes.length === 0 ||
    sourceScopeIndexes.some(
      (index) => facts.source.read.scopes[index]?.enumeration !== "complete",
    )
  )
    return {
      status: "unprocessed",
      reason: "当前原文范围读取不足，无法确认原文仍已移除。",
    };

  const relation = removedSourceRelation(
    edit,
    facts,
    matches,
    historicalSource,
  );
  if (relation.association.status === "unknown")
    return {
      status: "unprocessed",
      reason: "当前目标范围读取不足，无法核对删除目标。",
    };
  if (relation.association.status === "conflict")
    return {
      status: "conflict",
      reason: "历史原文当前匹配到多条译文，拒绝删除。",
    };
  if (relation.association.status === "unavailable")
    return {
      status: "unprocessed",
      reason: "当前删除目标正文不可用。",
    };
  if (relation.association.status !== "matched")
    return {
      status: "conflict",
      reason: "预期存在的删除目标已不存在。",
    };
  const matchedTranslation = relation.translations[0];
  if (
    matchedTranslation === undefined ||
    matchedTranslation.bodyAvailability !== "available"
  )
    return {
      status: "unprocessed",
      reason: "当前删除目标无法唯一定位。",
    };
  const currentTranslation = matchedTranslation;

  let currentContent: TBody;
  let dependencies: JsonValue;
  let resolution: EditTargetResolution;
  try {
    currentContent = snapshotValue(
      currentTranslation.content,
      "当前删除目标正文",
    );
    dependencies = snapshotJson(
      (await adapter.dependencies?.({
        sourceUnit: relation.historicalSourceUnit,
        language: edit.language,
        association: relation.association,
        translations: [currentTranslation],
      })) ?? null,
      "当前编辑依赖",
    );
    resolution = await adapter.locateExistingTarget({
      sourceUnit: relation.historicalSourceUnit,
      translation: currentTranslation,
    });
  } catch (error) {
    rethrowContractError(error);
    return {
      status: "notWritable",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  if (resolution.status === "notWritable")
    return { status: "notWritable", reason: resolution.reason };
  if (!isDeepStrictEqual(currentContent, edit.expected.target.content))
    return { status: "conflict", reason: "目标译文内容已变化。" };
  if (!isDeepStrictEqual(currentTranslation.range, edit.expected.target.range))
    return { status: "conflict", reason: "目标译文所在范围已变化。" };
  if (!isDeepStrictEqual(dependencies, edit.expected.dependencies))
    return { status: "conflict", reason: "候选声明的上下文依赖已变化。" };
  if (!isDeepStrictEqual(resolution.locator, edit.target.locator))
    return { status: "conflict", reason: "宿主解析出的实际目标位置已变化。" };

  return {
    status: "ready",
    sourceUnit: relation.historicalSourceUnit,
    currentTranslation,
  };
}

function readDeleteEditObservation<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  facts: FrameworkFacts<TUnit, TTranslation, TBody, TUnavailable>,
  edit: Extract<SemanticEdit<TBody>, { operation: "delete" }>,
  config: FrameworkConfig<TUnit, TTranslation, TBody, TUnavailable>,
  historicalSource: TUnit,
): SemanticEditObservation<TUnit, TTranslation, TBody, TUnavailable> {
  const relation = removedSourceRelation(
    edit,
    facts,
    config.translations?.matches,
    historicalSource,
  );
  return {
    factsVersion: facts.version,
    sourceReadStatus: facts.source.read.status,
    translationReadStatus:
      facts.translations.reads.find(
        ({ language }) => language === edit.language,
      )?.status ?? null,
    sourceUnit:
      facts.source.units.find(({ key }) => key === edit.sourceKey) ?? null,
    association: relation.association,
    translations: relation.translations,
  };
}

function removedSourceRelation<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  edit: Extract<SemanticEdit<TBody>, { operation: "delete" }>,
  facts: FrameworkFacts<TUnit, TTranslation, TBody, TUnavailable>,
  matches:
    | ((unit: TUnit, translation: TTranslation | TUnavailable) => boolean)
    | undefined,
  historicalSource: TUnit,
): {
  readonly historicalSourceUnit: SourceUnitFact<TUnit>;
  readonly association: TranslationAssociationFact;
  readonly translations: readonly ActualTranslationFact<
    TTranslation,
    TBody,
    TUnavailable
  >[];
} {
  const expectedSource = edit.expected.source;
  const sourceScopeIndex = facts.source.read.scopes.findIndex(({ range }) =>
    isDeepStrictEqual(range, expectedSource.range),
  );
  // 仅供显式历史匹配、定位和依赖回调使用，不伪装为当前 source 记录。
  const historicalSourceUnit: SourceUnitFact<TUnit> = {
    key: edit.sourceKey,
    unit: historicalSource,
    bodyAvailability: "available",
    scopeIndex: sourceScopeIndex,
  };
  const translationRead = facts.translations.reads.find(
    ({ language }) => language === edit.language,
  );
  const expectedScopeIndexes = (translationRead?.scopes ?? []).flatMap(
    (scope, index) =>
      edit.expected.target.scopes.some((range) =>
        isDeepStrictEqual(range, scope.range),
      )
        ? [index]
        : [],
  );
  const scopesComplete =
    translationRead !== undefined &&
    edit.expected.target.scopes.length > 0 &&
    edit.expected.target.scopes.every((range) =>
      translationRead.scopes.some(
        (scope) =>
          isDeepStrictEqual(scope.range, range) &&
          scope.enumeration === "complete",
      ),
    );
  const coverageStatus: CoverageStatus =
    translationRead === undefined
      ? "notRead"
      : translationRead.error !== undefined
        ? "failed"
        : scopesComplete
          ? "complete"
          : translationRead.scopes.some((scope) =>
                edit.expected.target.scopes.some(
                  (range) =>
                    isDeepStrictEqual(range, scope.range) &&
                    scope.enumeration === "failed",
                ),
              )
            ? "failed"
            : "incomplete";
  let translations: ActualTranslationFact<TTranslation, TBody, TUnavailable>[] =
    [];
  let relationshipReadFailed = matches === undefined;
  if (matches !== undefined) {
    try {
      translations = facts.translations.records.filter(
        (translation) =>
          translation.language === edit.language &&
          matches(historicalSource, translation.translation),
      );
    } catch (error) {
      rethrowContractError(error);
      relationshipReadFailed = true;
    }
  }
  const status =
    translations.length > 1
      ? "conflict"
      : relationshipReadFailed || coverageStatus !== "complete"
        ? "unknown"
        : translations.length === 0
          ? "missing"
          : translations[0]?.bodyAvailability === "available"
            ? "matched"
            : "unavailable";
  return {
    historicalSourceUnit,
    association: {
      sourceKey: edit.sourceKey,
      language: edit.language,
      status,
      coverageStatus,
      scopeIndexes: expectedScopeIndexes,
      translationIndexes: translations.map(({ index }) => index),
    },
    translations,
  };
}

function readEditObservation<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  facts: FrameworkFacts<TUnit, TTranslation, TBody, TUnavailable>,
  sourceKey: string,
  language: string,
): SemanticEditObservation<TUnit, TTranslation, TBody, TUnavailable> {
  const sourceUnit =
    facts.source.units.find(({ key }) => key === sourceKey) ?? null;
  const association =
    facts.associations.find(
      (item) => item.sourceKey === sourceKey && item.language === language,
    ) ?? null;
  const translations = (association?.translationIndexes ?? []).flatMap(
    (index) => {
      const fact = facts.translations.records[index];
      return fact === undefined ? [] : [fact];
    },
  );
  return {
    factsVersion: facts.version,
    sourceReadStatus: facts.source.read.status,
    translationReadStatus:
      facts.translations.reads.find((read) => read.language === language)
        ?.status ?? null,
    sourceUnit,
    association,
    translations,
  };
}

function snapshotEditObservation<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  observation: SemanticEditObservation<
    TUnit,
    TTranslation,
    TBody,
    TUnavailable
  >,
): SemanticEditObservation<TUnit, TTranslation, TBody, TUnavailable> {
  return snapshotValue(observation, "编辑事实观察");
}

async function confirmsSemanticEdit<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  edit: SemanticEdit<TBody>,
  observation: SemanticEditObservation<
    TUnit,
    TTranslation,
    TBody,
    TUnavailable
  >,
  facts: FrameworkFacts<TUnit, TTranslation, TBody, TUnavailable>,
  config: FrameworkConfig<TUnit, TTranslation, TBody, TUnavailable>,
  historicalSource: TUnit | undefined,
): Promise<boolean> {
  if (edit.operation === "write") return confirmsEditContent(edit, observation);

  if (observation.sourceUnit !== null) return false;
  const sourceScopeIsComplete = facts.source.read.scopes.some(
    (scope) =>
      isDeepStrictEqual(scope.range, edit.expected.source.range) &&
      scope.enumeration === "complete",
  );
  const relation = removedSourceRelation(
    edit,
    facts,
    config.translations?.matches,
    requiredHistoricalSource(historicalSource),
  );
  if (
    sourceScopeIsComplete &&
    relation.association.coverageStatus === "complete" &&
    relation.association.status === "missing"
  )
    return confirmsSemanticDeletionTargetAbsent(edit, facts, relation, config);
  return false;
}

async function confirmsSemanticDeletionTargetAbsent<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  edit: Extract<SemanticEdit<TBody>, { operation: "delete" }>,
  facts: FrameworkFacts<TUnit, TTranslation, TBody, TUnavailable>,
  relation: ReturnType<
    typeof removedSourceRelation<TUnit, TTranslation, TBody, TUnavailable>
  >,
  config: FrameworkConfig<TUnit, TTranslation, TBody, TUnavailable>,
): Promise<boolean> {
  const locateExistingTarget =
    config.translationWriteback?.locateExistingTarget;
  if (locateExistingTarget === undefined) return false;

  const targetRecords = facts.translations.records.filter(
    (translation) =>
      translation.language === edit.language &&
      isDeepStrictEqual(translation.range, edit.expected.target.range),
  );
  for (const translation of targetRecords) {
    if (translation.bodyAvailability !== "available") return false;
    let resolution: EditTargetResolution;
    try {
      resolution = await locateExistingTarget({
        sourceUnit: relation.historicalSourceUnit,
        translation,
      });
    } catch (error) {
      rethrowContractError(error);
      return false;
    }
    if (resolution.status !== "located") return false;
    if (
      isDeepStrictEqual(translation.range, edit.expected.target.range) &&
      isDeepStrictEqual(resolution.locator, edit.target.locator)
    )
      return false;
  }
  return true;
}

function confirmsEditContent<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  edit: Extract<SemanticEdit<TBody>, { operation: "write" }>,
  observation: SemanticEditObservation<
    TUnit,
    TTranslation,
    TBody,
    TUnavailable
  >,
): boolean {
  if (
    observation.association?.status !== "matched" ||
    observation.association.translationIndexes.length !== 1
  )
    return false;
  const translation = observation.translations[0];
  if (translation === undefined || translation.bodyAvailability !== "available")
    return false;
  return isDeepStrictEqual(
    snapshotValue(translation.content, "回读译文正文"),
    edit.content,
  );
}

function snapshotJson(value: unknown, description: string): JsonValue {
  return snapshotJsonValue(value, description);
}

function snapshotValue<TValue>(value: TValue, description: string): TValue {
  assertJsonValue(value, description);
  return JSON.parse(JSON.stringify(value)) as TValue;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rethrowContractError(error: unknown): void {
  if (error instanceof StandardSchemaContractError) throw error;
}

function invalidSavedSemanticEdit(message: string): never {
  throw new StandardSchemaContractError(
    "保存的语义编辑",
    "schema-mismatch",
    `保存的语义编辑${message}`,
  );
}

function requiredHistoricalSource<TUnit extends TranslationUnitInput>(
  source: TUnit | undefined,
): TUnit {
  if (source === undefined) invalidSavedSemanticEdit("缺少已验证的历史原文。");
  return source;
}
