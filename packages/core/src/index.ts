import {
  beginQualityProfile,
  type QualityProfiler,
} from "./quality/profiler.ts";
import { readStatus } from "./read-coverage.ts";
export { createQualityProfiler } from "./quality/profiler.ts";
export type {
  QualityProfiler,
  QualityProfilerOptions,
  QualityProfileReport,
  QualityProfileCheck,
  QualityProfileCandidate,
  QualityProfileTiming,
  QualityProfileStage,
  QualityProfileCandidateStatus,
  QualityProfileCache,
} from "./quality/profiler.ts";
import { createHash } from "node:crypto";

import { createMemoScope, type MemoScope } from "@lioni/memo";

import type { Compare } from "./comparison.ts";
import {
  resolveLanguageSelection,
  type LanguageSelectionOptions,
} from "./language-scope.ts";
import { isPlainRecord, isRecord } from "./object-guards.ts";
import type { UpdatePolicy } from "./plans.ts";
import {
  savedTranslationCandidates,
  validateQualityCandidateScope,
} from "./quality/candidate-contract.ts";
import {
  assertQaSuppressionBindings,
  validateQaSuppressions,
} from "./quality/qa-suppressions.ts";
import type {
  QaSuppression,
  QaSuppressionStore,
} from "./quality/qa-suppressions.ts";
import {
  assertReadableSnapshot,
  assertSelectedAssociationsComplete,
  createQualityDataReader,
  pruneCleanExecutions,
  runQualityChecksWithQualityData,
  type QualityCheckDefinition,
  type QualityRunResult,
  type QualityObject,
  type QualityRelationship,
} from "./quality/qa.ts";
import type { QualityCheckResultCache } from "./quality/quality-cache.ts";
import { validateTranslationCandidate } from "./semantic-edits.ts";
import type {
  JsonValue,
  TranslationCandidate,
  TranslationWritebackAdapter,
} from "./semantic-edits.ts";
import {
  assertJsonValue,
  freezeJsonValue,
  isStandardSchema,
  StandardSchemaContractError,
  validateWithStandardSchema,
} from "./standard-schema.ts";
import type {
  PreservingStandardSchema,
  StandardSchemaV1,
  StandardSchemaTypes,
} from "./standard-schema.ts";
import { associateSnapshot } from "./translation-associations.ts";
import { readTranslationSnapshot } from "./translation-snapshot.ts";

export type { LanguageSelectionOptions } from "./language-scope.ts";

export {
  validateTranslationCandidate,
  validateTranslationWriteRequest,
  writeTranslationRequests,
} from "./semantic-edits.ts";
export type {
  JsonValue,
  TranslationCandidate,
  TranslationWriteTarget,
  TranslationWriteSourceExpectation,
  TranslationWriteTargetExpectation,
  TranslationWriteRequest,
  TranslationWritebackTarget,
  TranslationWritebackResolution,
  TranslationWritebackAdapter,
  TranslationWritebackInput,
  TranslationWriteConditionInput,
  TranslationWriteConditionResult,
  TranslationWriteCondition,
  TranslationWriteStatus,
  TranslationWriteResult,
  TranslationWriteBatchResult,
} from "./semantic-edits.ts";
export {
  assertJsonValue,
  StandardSchemaContractError,
  snapshotJsonValue,
} from "./standard-schema.ts";
export { TranslationIdentityContractError } from "./translation-snapshot.ts";
export type {
  StandardSchemaFailureKind,
  StandardSchemaV1,
  StandardSchemaV1Issue,
  StandardSchemaV1Result,
} from "./standard-schema.ts";
export {
  createQaSuppression,
  qaSuppressionMatchesExecution,
  upsertQaSuppressionFromReport,
  QaSuppressionFormatError,
  validateQaSuppression,
  validateQaSuppressionFile,
  validateQaSuppressions,
} from "./quality/qa-suppressions.ts";
export type {
  CreateQaSuppressionInput,
  QaSuppression,
  QaSuppressionExecution,
  QaSuppressionFile,
  QaSuppressionFingerprintSummary,
  QaSuppressionFormatErrorReason,
  QaSuppressionStore,
  UpsertQaSuppressionFromReportInput,
} from "./quality/qa-suppressions.ts";
export {
  QualityCheckerContractError,
  QualityDataReaderContractError,
  defineChecker,
  runQualityChecks,
} from "./quality/qa.ts";
export type {
  CheckerDefinition,
  CheckerLoadInput,
  CheckerPrepareInput,
  QualityObject,
  QualityLocation,
  QualitySubject,
  QualityRelationship,
  QualityDiagnosticHandling,
  QualityEvidence,
  QualityDiagnostic,
  QualityFinding,
  QualityCoverage,
  QualityInputFingerprintSummary,
  QualityCheckExecution,
  QualityCheckRequest,
  StandardSchemaInput,
  StandardSchemaOutput,
  QualityCheckDefinition,
  QualityCheckResult,
  QualityDataLoadInput,
  QualityDataReader,
  QualityCheckScope,
  QualityReadCoverage,
  TranslationProgress,
  QualityRunResult,
  QualityExecutionOptions,
} from "./quality/qa.ts";
export {
  decideQualityReport,
  formatQualityReport,
  isQualityReportPassing,
} from "./quality/report.ts";
export type {
  QualityReportDecision,
  QualityReportDecisionStatus,
} from "./quality/report.ts";
export type {
  CachedQualityFindings,
  QualityCheckResultCache,
} from "./quality/quality-cache.ts";
export {
  compareSnapshots,
  defaultCompare,
  ComparisonContractError,
  validateComparisonInput,
  validateComparisonResult,
} from "./comparison.ts";
export type {
  Compare,
  CompareInput,
  ComparisonContractErrorReason,
  ComparisonResult,
  ComparisonStatus,
  SnapshotReadEvidence,
  SourceChange,
  TranslationChange,
} from "./comparison.ts";
export {
  ComparisonBaselineFormatError,
  ComparisonBaselineIncompleteSnapshotError,
  recordComparisonBaseline,
  replaceComparisonBaseline,
  validateComparisonBaseline,
} from "./baselines.ts";
export type {
  ComparisonBaseline,
  ComparisonBaselineSelection,
  ComparisonBaselineStore,
  RecordComparisonBaselineResult,
} from "./baselines.ts";

export {
  createUpdatePlan,
  defaultUpdatePolicy,
  previewUpdate,
  validateUpdatePlan,
} from "./plans.ts";
export type {
  UpdatePlan,
  UpdatePlanAction,
  UpdatePlanAssociations,
  UpdatePlanComparisons,
  UpdatePlanData,
  UpdatePlanInput,
  UpdatePlanItem,
  UpdatePlanSourceChange,
  UpdatePlanTranslationChange,
  UpdatePlanWriteRequest,
  UpdatePolicy,
  UpdateSourceExpectation,
  UpdateTargetExpectation,
} from "./plans.ts";
export { applyUpdatePlan, update } from "./apply-plans.ts";
export type {
  UpdateBaselineResult,
  UpdatePlanApplyResult,
  UpdatePlanExecutionItemResult,
  UpdatePlanExecutionStatus,
  UpdateResult,
} from "./apply-plans.ts";

export type Awaitable<T> = T | Promise<T>;

export type TranslationUnitInput = {
  readonly source: unknown;
  readonly context?: unknown;
};

export type BodyAvailability = "available" | "unavailable";
export type EnumerationCompleteness = "complete" | "partial" | "failed";

export type ReadRecord<TValue, TUnavailable = TValue> =
  | { readonly value: TValue; readonly bodyAvailability: "available" }
  | { readonly value: TUnavailable; readonly bodyAvailability: "unavailable" };

export type ReadScope<TValue, TUnavailable = TValue> = {
  readonly range: unknown;
  readonly enumeration: EnumerationCompleteness;
  readonly records: readonly ReadRecord<TValue, TUnavailable>[];
  readonly error?: string;
};

export type SourceRead<TUnit extends TranslationUnitInput> = {
  readonly scopes: readonly ReadScope<TUnit>[];
};

export type SourceAdapter<TUnit extends TranslationUnitInput> = {
  readonly schema: StandardSchemaV1<TUnit, TUnit>;
  read(): Awaitable<SourceRead<TUnit>>;
};

export type TranslationReadScope<
  TTranslation,
  TUnavailable = never,
> = ReadScope<TTranslation, TUnavailable> & {
  readonly covers: readonly string[];
};

export type TranslationRead<TTranslation, TUnavailable = never> = {
  readonly scopes: readonly TranslationReadScope<TTranslation, TUnavailable>[];
};

export type TranslationAdapter<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody = JsonValue,
  TUnavailable = never,
  TTranslationSchema = StandardSchemaV1<TTranslation, TTranslation>,
  TUnavailableSchema = StandardSchemaV1<TUnavailable, TUnavailable>,
  TContentSchema = StandardSchemaV1<TBody, TBody>,
> = {
  readonly languages: readonly string[];
  readonly schema: TTranslationSchema &
    StandardSchemaV1<TTranslation, TTranslation> &
    PreservingStandardSchema<TTranslation, TTranslationSchema>;
  readonly unavailableSchema?: TUnavailableSchema &
    StandardSchemaV1<TUnavailable, TUnavailable> &
    PreservingStandardSchema<TUnavailable, TUnavailableSchema>;
  readonly contentSchema: TContentSchema &
    StandardSchemaV1<TBody, TBody> &
    PreservingStandardSchema<TBody, TContentSchema>;
  readonly contentOf: (translation: NoInfer<TTranslation>) => NoInfer<TBody>;
  /** 返回与原文相同键空间中的消息键；同一语言内唯一，语言由框架补入译文身份。 */
  readonly keyOf: (
    translation: NoInfer<TTranslation | TUnavailable>,
    language: string,
  ) => string;
  read(
    language: string,
    sourceUnits: readonly SourceUnit<TUnit>[],
  ): Awaitable<TranslationRead<TTranslation, TUnavailable>>;
};

export type FrameworkConfig<
  TUnit extends TranslationUnitInput,
  TTranslation = unknown,
  TBody = JsonValue,
  TUnavailable = never,
  TCheckId extends string = string,
  TGroups extends Readonly<Record<string, readonly NoInfer<TCheckId>[]>> =
    Readonly<Record<string, readonly TCheckId[]>>,
> = {
  readonly source: SourceAdapter<TUnit>;
  /** 返回非空、唯一的消息键；每种目标语言通过相同键与原文唯一关联。 */
  readonly keyOf: (unit: TUnit) => string;
  readonly translations?: TranslationAdapter<
    TUnit,
    TTranslation,
    TBody,
    TUnavailable
  >;
  readonly compare?: Compare<TUnit, TTranslation, TBody, TUnavailable>;
  readonly translationWriteback?: TranslationWritebackAdapter<
    TUnit,
    TTranslation,
    TBody,
    TUnavailable
  >;
  /**
   * 同步纯填充函数：仅接收原文正文并返回目标正文。默认直接使用已读取的原文正文；
   * 默认值与自定义结果都会按 contentSchema 保值验证。
   */
  readonly createPlaceholderContent?: (
    source: NoInfer<TUnit["source"]>,
  ) => NoInfer<TBody>;
  readonly updatePolicy?: UpdatePolicy<
    TUnit,
    TTranslation,
    TBody,
    TUnavailable
  >;
  readonly quality?: QualityConfiguration<
    TUnit,
    TTranslation,
    TBody,
    TUnavailable,
    TCheckId,
    TGroups
  >;
};

type QualityGroupMap<TCheckId extends string> = Readonly<
  Record<string, readonly NoInfer<TCheckId>[]>
>;

type QualityRunSelectionOptions<
  TCheckId extends string,
  TGroupName extends string,
> =
  | { readonly checkIds?: undefined; readonly groups?: undefined }
  | {
      readonly checkIds: readonly NoInfer<TCheckId>[];
      readonly groups?: never;
    }
  | {
      readonly checkIds?: never;
      readonly groups: readonly NoInfer<TGroupName>[];
    };

export type QualityConfiguration<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody = JsonValue,
  TUnavailable = never,
  TCheckId extends string = string,
  TGroups extends QualityGroupMap<TCheckId> = QualityGroupMap<TCheckId>,
> = {
  /** 直接声明本次运行使用的检查器；检查器的校验与执行由 SDK 管理。 */
  readonly checks?: readonly QualityCheckDefinition<
    NoInfer<TUnit>,
    NoInfer<TTranslation>,
    QualityObject,
    NoInfer<TBody>,
    NoInfer<TUnavailable>,
    TCheckId
  >[];
  /** 项目自定义分组；每个成员只能引用 checks 中声明的检查项 ID。 */
  readonly groups?: TGroups;
  /** 关系上下文不随候选筛选裁剪。 */
  readonly relationships?: readonly QualityRelationship[];
  /** 显式启用原始结果缓存；命中后仍应用当前 QA 豁免，存储故障不阻断检查。 */
  readonly resultCache?: QualityCheckResultCache;
  readonly suppressionStore?: QaSuppressionStore;
};

type DefineConfigInput<
  TUnit extends TranslationUnitInput,
  TSchema,
  TTranslationSchema,
  TUnavailableSchema,
  TContentSchema,
  TCheckId extends string,
  TGroups extends QualityGroupMap<TCheckId>,
> = Omit<
  FrameworkConfig<
    NoInfer<TUnit>,
    NoInfer<SchemaOutput<TTranslationSchema>>,
    NoInfer<SchemaOutput<TContentSchema>>,
    NoInfer<SchemaOutput<TUnavailableSchema>>,
    TCheckId,
    TGroups
  >,
  "source" | "translations"
> & {
  readonly source: {
    readonly schema: TSchema &
      StandardSchemaV1<TUnit, TUnit> &
      PreservingStandardSchema<TUnit, TSchema>;
    read(): Awaitable<SourceRead<NoInfer<TUnit>>>;
  };
  readonly translations?: TranslationAdapterInput<
    NoInfer<TUnit>,
    TTranslationSchema,
    TUnavailableSchema,
    TContentSchema
  >;
};

type TranslationAdapterInput<
  TUnit extends TranslationUnitInput,
  TTranslationSchema,
  TUnavailableSchema,
  TContentSchema,
> = {
  readonly languages: readonly string[];
  readonly schema: TTranslationSchema &
    StandardSchemaV1<
      SchemaOutput<TTranslationSchema>,
      SchemaOutput<TTranslationSchema>
    > &
    PreservingStandardSchema<
      SchemaOutput<TTranslationSchema>,
      TTranslationSchema
    >;
  readonly unavailableSchema?: TUnavailableSchema &
    StandardSchemaV1<
      SchemaOutput<TUnavailableSchema>,
      SchemaOutput<TUnavailableSchema>
    > &
    PreservingStandardSchema<
      SchemaOutput<TUnavailableSchema>,
      TUnavailableSchema
    >;
  readonly contentSchema: TContentSchema &
    StandardSchemaV1<
      SchemaOutput<TContentSchema>,
      SchemaOutput<TContentSchema>
    > &
    PreservingStandardSchema<SchemaOutput<TContentSchema>, TContentSchema>;
  readonly contentOf: (
    translation: NoInfer<SchemaOutput<TTranslationSchema>>,
  ) => NoInfer<SchemaOutput<TContentSchema>>;
  readonly keyOf: (
    translation: NoInfer<
      SchemaOutput<TTranslationSchema> | SchemaOutput<TUnavailableSchema>
    >,
    language: string,
  ) => string;
  read(
    language: string,
    sourceUnits: readonly SourceUnit<NoInfer<TUnit>>[],
  ): Awaitable<
    TranslationRead<
      NoInfer<SchemaOutput<TTranslationSchema>>,
      NoInfer<SchemaOutput<TUnavailableSchema>>
    >
  >;
};

type SchemaOutput<TSchema> = TSchema extends never
  ? never
  : StandardSchemaTypes<TSchema> extends { readonly output: infer TOutput }
    ? TOutput
    : never;

export type SourceUnit<TUnit extends TranslationUnitInput> = {
  readonly key: string;
  readonly unit: TUnit;
  readonly bodyAvailability: BodyAvailability;
  readonly scopeIndex: number;
};

export type SourceReadCoverage = {
  readonly status: CoverageStatus;
  readonly scopes: readonly {
    readonly range: unknown;
    readonly enumeration: EnumerationCompleteness;
    readonly recordCount: number;
    readonly error?: string;
  }[];
  readonly error?: string;
};

export type SourceSnapshot<TUnit extends TranslationUnitInput> = {
  readonly version: string;
  readonly read: SourceReadCoverage;
  readonly totalUnitCount: number | null;
  readonly units: readonly SourceUnit<TUnit>[];
};

export type TranslationAssociationStatus =
  | "matched"
  | "missing"
  | "unavailable"
  | "unknown";

export type CoverageStatus = "complete" | "incomplete" | "failed" | "notRead";

export type TranslationReadScopeCoverage = {
  readonly range: unknown;
  readonly covers: readonly string[];
  readonly enumeration: EnumerationCompleteness;
  readonly translationIndexes: readonly number[];
  readonly error?: string;
};

export type TranslationReadCoverage = {
  readonly language: string;
  readonly status: CoverageStatus;
  readonly scopes: readonly TranslationReadScopeCoverage[];
  readonly error?: string;
};

type TranslationBase = {
  readonly index: number;
  readonly language: string;
  readonly scopeIndex: number;
  readonly range: unknown;
};

export type Translation<
  TTranslation,
  TBody = JsonValue,
  TUnavailable = never,
> =
  | (TranslationBase & {
      readonly record: TTranslation;
      readonly identity: TranslationIdentity;
      readonly content: TBody;
      readonly bodyAvailability: "available";
    })
  | (TranslationBase & {
      readonly record: TUnavailable;
      readonly identity: TranslationIdentity;
      readonly content?: never;
      readonly bodyAvailability: "unavailable";
    });

export type TranslationAssociation = {
  readonly sourceKey: string;
  readonly language: string;
  readonly status: TranslationAssociationStatus;
  readonly coverageStatus: CoverageStatus;
  readonly scopeIndexes: readonly number[];
  /** 对应同键译文的索引，至多一项；空数组的含义由读取完整性决定。 */
  readonly translationIndexes: readonly number[];
};

/** 语言与消息键共同构成译文身份；消息键同时用于和原文唯一关联。 */
export type TranslationIdentity = {
  readonly language: string;
  readonly key: string;
};

export type ComparisonSnapshot<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody = JsonValue,
  TUnavailable = never,
> = {
  readonly version: string;
  readonly source: SourceSnapshot<TUnit>;
  readonly translations: {
    readonly reads: readonly TranslationReadCoverage[];
    readonly records: readonly Translation<TTranslation, TBody, TUnavailable>[];
  };
};

export type ProjectSnapshot<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody = JsonValue,
  TUnavailable = never,
> = ComparisonSnapshot<TUnit, TTranslation, TBody, TUnavailable> & {
  readonly associations: readonly TranslationAssociation[];
};

export class DuplicateTranslationUnitKeyError extends Error {
  readonly key: string;
  readonly firstIndex: number;
  readonly duplicateIndex: number;

  constructor(key: string, firstIndex: number, duplicateIndex: number) {
    super(
      `原文单元身份重复：${JSON.stringify(key)}（第 ${firstIndex + 1} 与第 ${duplicateIndex + 1} 个单元）`,
    );
    this.name = "DuplicateTranslationUnitKeyError";
    this.key = key;
    this.firstIndex = firstIndex;
    this.duplicateIndex = duplicateIndex;
  }
}

function defineConfigImplementation<
  TUnit extends TranslationUnitInput,
  TSchema = StandardSchemaV1<TUnit, TUnit>,
  TTranslationSchema = StandardSchemaV1<unknown, unknown>,
  TUnavailableSchema = never,
  TContentSchema = StandardSchemaV1<JsonValue, JsonValue>,
  TCheckId extends string = never,
  const TGroups extends QualityGroupMap<TCheckId> = {},
>(
  config: DefineConfigInput<
    TUnit,
    TSchema,
    TTranslationSchema,
    TUnavailableSchema,
    TContentSchema,
    TCheckId,
    TGroups
  >,
): FrameworkConfig<
  TUnit,
  SchemaOutput<TTranslationSchema>,
  SchemaOutput<TContentSchema>,
  SchemaOutput<TUnavailableSchema>,
  TCheckId,
  TGroups
> {
  return config;
}

/**
 * 声明宿主配置。显式业务泛型通过 withTypes 预先绑定，以便从配置内容推断检查项与分组。
 * 静态字面量 ID 保留精确选择类型；混入普通 string ID 会使检查项联合退化为 string，
 * 此时检查项、分组成员和运行选项依赖 QA 入口的运行时目录校验。
 */
export const defineConfig = Object.assign(defineConfigImplementation, {
  withTypes<
    TUnit extends TranslationUnitInput,
    TSchema = StandardSchemaV1<TUnit, TUnit>,
    TTranslationSchema = StandardSchemaV1<unknown, unknown>,
    TUnavailableSchema = never,
    TContentSchema = StandardSchemaV1<JsonValue, JsonValue>,
  >() {
    return <
      TCheckId extends string = never,
      const TGroups extends QualityGroupMap<TCheckId> = {},
    >(
      config: DefineConfigInput<
        TUnit,
        TSchema,
        TTranslationSchema,
        TUnavailableSchema,
        TContentSchema,
        TCheckId,
        TGroups
      >,
    ) =>
      defineConfigImplementation<
        TUnit,
        TSchema,
        TTranslationSchema,
        TUnavailableSchema,
        TContentSchema,
        TCheckId,
        TGroups
      >(config);
  },
});

export function validateFrameworkConfig(value: unknown): void {
  validateSourceConfig(value);
}

function validateSourceConfig(value: unknown): void {
  if (!isRecord(value)) invalidFrameworkConfig("宿主配置必须是对象。");
  if (!isRecord(value.source) || typeof value.source.read !== "function")
    invalidFrameworkConfig("defineConfig 的 source.read 必须是函数。");
  if (!isStandardSchema(value.source.schema))
    invalidFrameworkConfig(
      "defineConfig 的 source.schema 必须符合 Standard Schema v1。",
    );
  if (typeof value.keyOf !== "function")
    invalidFrameworkConfig("defineConfig 的 keyOf 必须是函数。");
  validateQualityConfiguration(value.quality);
}

function validateQualityConfiguration(value: unknown): void {
  if (value === undefined) return;
  if (!isRecord(value))
    invalidFrameworkConfig("defineConfig 的 quality 必须是对象。");
  if (Object.hasOwn(value, "prepare"))
    invalidFrameworkConfig(
      "defineConfig 的 quality.prepare 已移除；请直接配置 quality.checks。",
    );
  if (value.checks !== undefined && !Array.isArray(value.checks))
    invalidFrameworkConfig("defineConfig 的 quality.checks 必须是检查器数组。");
  if (Object.hasOwn(value, "buildCandidates"))
    invalidFrameworkConfig(
      "defineConfig 的 quality.buildCandidates 已移除；请在 runQa 前构造 candidates。",
    );
  if (value.relationships !== undefined && !Array.isArray(value.relationships))
    invalidFrameworkConfig(
      "defineConfig 的 quality.relationships 必须是数组。",
    );
  if (
    value.resultCache !== undefined &&
    (!isRecord(value.resultCache) ||
      typeof value.resultCache.get !== "function" ||
      typeof value.resultCache.set !== "function")
  )
    invalidFrameworkConfig(
      "defineConfig 的 quality.resultCache 必须提供 get 与 set 函数。",
    );
  if (
    value.suppressionStore !== undefined &&
    (!isRecord(value.suppressionStore) ||
      typeof value.suppressionStore.load !== "function" ||
      typeof value.suppressionStore.upsert !== "function")
  )
    invalidFrameworkConfig(
      "defineConfig 的 quality.suppressionStore 必须提供 load 与 upsert 函数。",
    );
}

function invalidFrameworkConfig(message: string): never {
  throw new StandardSchemaContractError(
    "defineConfig 配置",
    "schema-mismatch",
    message,
  );
}

export async function readSourceSnapshot<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  config: FrameworkConfig<TUnit, TTranslation, TBody, TUnavailable>,
): Promise<SourceSnapshot<TUnit>> {
  validateSourceConfig(config);
  let read: SourceRead<TUnit> | undefined;
  let errorMessage: string | undefined;
  try {
    read = await config.source.read();
  } catch (error) {
    if (error instanceof StandardSchemaContractError) throw error;
    errorMessage = error instanceof Error ? error.message : String(error);
  }

  if (errorMessage === undefined) validateSourceRead(read);

  const firstIndexes = new Map<string, number>();
  const units: SourceUnit<TUnit>[] = [];
  const scopes = read?.scopes ?? [];
  for (const [scopeIndex, scope] of scopes.entries()) {
    for (const record of scope.records) {
      const index = units.length;
      const unit = await validateWithStandardSchema(
        config.source.schema,
        record.value,
        `原文单元 ${index + 1}`,
        { preserveValue: true, requireJson: true },
      );
      const key = config.keyOf(unit);
      if (typeof key !== "string" || key.trim().length === 0)
        invalidFrameworkConfig("keyOf 必须返回非空的原文消息键。");
      const firstIndex = firstIndexes.get(key);
      if (firstIndex !== undefined)
        throw new DuplicateTranslationUnitKeyError(key, firstIndex, index);
      firstIndexes.set(key, index);
      units.push({
        key,
        unit,
        bodyAvailability: record.bodyAvailability,
        scopeIndex,
      });
    }
  }

  const scopeCoverage = scopes.map((scope) => ({
    range: scope.range,
    enumeration: scope.enumeration,
    recordCount: scope.records.length,
    ...(scope.error === undefined ? {} : { error: scope.error }),
  }));
  const status = readStatus(scopeCoverage, errorMessage);
  const totalUnitCount = status === "complete" ? units.length : null;
  const readCoverage: SourceReadCoverage = {
    status,
    scopes: scopeCoverage,
    ...(errorMessage === undefined ? {} : { error: errorMessage }),
  };
  const version = snapshotVersion({ read: readCoverage, units });
  return {
    version,
    read: readCoverage,
    totalUnitCount,
    units,
  };
}

/** 读取源、目标事实及读取依据，不计算源译关联或运行 QA。 */
export async function readComparisonSnapshot<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  config: FrameworkConfig<TUnit, TTranslation, TBody, TUnavailable>,
  options: LanguageSelectionOptions = {},
): Promise<ComparisonSnapshot<TUnit, TTranslation, TBody, TUnavailable>> {
  validateFrameworkConfig(config);
  const languages = resolveLanguageSelection(
    config.translations?.languages ?? [],
    options,
  );
  return await collectComparisonSnapshot(config, languages);
}

async function collectComparisonSnapshot<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  config: FrameworkConfig<TUnit, TTranslation, TBody, TUnavailable>,
  languages: readonly string[],
): Promise<ComparisonSnapshot<TUnit, TTranslation, TBody, TUnavailable>> {
  const source = await readSourceSnapshot(config);
  const translations = await readTranslationSnapshot(
    config.translations,
    source.units,
    languages,
  );

  const version = snapshotVersion({ source, translations });
  return { version, source, translations };
}

export async function readProjectSnapshot<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  config: FrameworkConfig<TUnit, TTranslation, TBody, TUnavailable>,
  options: LanguageSelectionOptions = {},
): Promise<ProjectSnapshot<TUnit, TTranslation, TBody, TUnavailable>> {
  validateFrameworkConfig(config);
  const translationAdapter = config.translations;
  const languages = resolveLanguageSelection(
    translationAdapter?.languages ?? [],
    options,
  );
  const snapshot = await collectComparisonSnapshot(config, languages);

  const associations = associateSnapshot(snapshot);

  const version = snapshotVersion({
    source: snapshot.source,
    translations: snapshot.translations,
    associations,
  });
  return { ...snapshot, version, associations };
}

export async function runQa<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
  TCheckId extends string,
  TGroups extends QualityGroupMap<TCheckId>,
>(
  config: FrameworkConfig<
    TUnit,
    TTranslation,
    TBody,
    TUnavailable,
    TCheckId,
    TGroups
  >,
  options: LanguageSelectionOptions &
    QualityRunSelectionOptions<
      NoInfer<TCheckId>,
      NoInfer<keyof TGroups & string>
    > & {
      /** 在 QA 前构造候选；身份必须引用本次读取到的原文键和译文语言。 */
      readonly candidates?: readonly TranslationCandidate<TBody>[];
      /** 仅筛选或重排传入的候选；返回项必须来自传入集合且身份不能重复。 */
      readonly selectCandidates?: (
        candidates: readonly TranslationCandidate<TBody>[],
      ) => readonly TranslationCandidate<TBody>[];
      readonly memo?: MemoScope;
      readonly profiler?: QualityProfiler;
      /** 按需包含零诊断执行归属与指纹；默认仅保留产生了实际原始诊断的执行记录。 */
      readonly includeCleanExecutions?: boolean;
    } = {},
): Promise<QualityRunResult<QualityObject, TBody>> {
  const profile =
    options.profiler === undefined
      ? undefined
      : beginQualityProfile(options.profiler);
  let completed = false;
  let stage = profile?.stage("configuration");
  try {
    validateFrameworkConfig(config);
    const quality = config.quality;
    const selectedChecks = resolveQualityCheckSelection(
      quality?.checks ?? [],
      quality?.groups,
      options,
    );
    stage?.();
    stage = profile?.stage("suppressions");
    const suppressions = await loadQaSuppressions(config);
    stage?.();
    stage = profile?.stage("snapshot");
    const snapshot = await readProjectSnapshot(config, options);
    stage?.();
    const memo = options.memo ?? createMemoScope();
    const qualityData = createQualityDataReader();
    try {
      stage = profile?.stage("candidates");
      const isDraft = options.candidates !== undefined;
      assertReadableSnapshot(snapshot, { draft: isDraft });
      let selection: readonly TranslationCandidate<TBody>[] | undefined;
      if (
        options.candidates !== undefined ||
        options.selectCandidates !== undefined
      ) {
        const supplied =
          options.candidates === undefined
            ? savedTranslationCandidates(snapshot)
            : options.candidates;
        if (!Array.isArray(supplied))
          throw new TypeError("candidates 必须是译文候选数组。");
        const candidates: TranslationCandidate<TBody>[] = [];
        for (const candidate of supplied)
          candidates.push(
            freezeJsonValue(
              await validateTranslationCandidate(candidate, config),
            ),
          );
        validateQualityCandidateScope(snapshot, candidates);
        selection = candidates;
        if (options.selectCandidates !== undefined) {
          const selected = options.selectCandidates(Object.freeze(candidates));
          if (!Array.isArray(selected))
            throw new TypeError("selectCandidates 必须返回候选数组。");
          const offered = new Set(candidates);
          if (selected.some((candidate) => !offered.has(candidate)))
            throw new TypeError(
              "selectCandidates 只能筛选或重排传入的候选；请通过 candidates 提供候选。",
            );
          validateQualityCandidateScope(snapshot, selected);
          selection = selected;
        }
        if (!isDraft) {
          const selectedIdentities = new Set(
            selection.map(({ sourceKey, language }) =>
              JSON.stringify([sourceKey, language]),
            ),
          );
          assertSelectedAssociationsComplete(
            snapshot,
            snapshot.associations.filter((association) =>
              selectedIdentities.has(
                JSON.stringify([association.sourceKey, association.language]),
              ),
            ),
          );
        }
      }

      stage?.();
      stage = profile?.stage("checks");
      const result = await runQualityChecksWithQualityData(
        snapshot,
        {
          ...(selection === undefined ? {} : { candidates: selection }),
          relationships: quality?.relationships ?? [],
          suppressions,
        },
        selectedChecks,
        {
          memo,
          includeCleanExecutions: true,
          ...(profile === undefined ? {} : { profile }),
          ...(quality?.resultCache === undefined
            ? {}
            : { qualityCheckResultCache: quality.resultCache }),
        },
        qualityData,
      );
      stage?.();
      const configuredChecks = quality?.checks ?? [];
      const reportedChecks =
        options.includeCleanExecutions === true
          ? result.checks
          : pruneCleanExecutions(result.checks);
      const report = {
        ...result,
        checks: reportedChecks,
        checkScope: {
          configuredCount: configuredChecks.length,
          selectedIds: selectedChecks.map(({ id }) => id),
          evaluatedCount: result.checkScope.evaluatedCount,
        },
      };
      // 只有未筛选对象且覆盖全部已配置规则的已保存资源运行才代表全量范围，其余为草稿或局部调试。
      const isFullScope =
        options.candidates === undefined &&
        options.selectCandidates === undefined &&
        selectedChecks.length === configuredChecks.length;
      if (!isFullScope) {
        completed = true;
        return report;
      }

      // 须先传入未裁剪的完整执行集完成失效豁免核验，再返回裁剪后的公开报告。
      assertQaSuppressionBindings({
        suppressions,
        configuredCheckIds: configuredChecks.map(({ id }) => id),
        configuredLanguages: config.translations?.languages ?? [],
        completeSourceKeys: new Set(
          snapshot.source.units.map(({ key }) => key),
        ),
        savedChecks: result.checks,
        ...(options.languages === undefined
          ? {}
          : { selectedLanguages: options.languages }),
      });
      const activeExecutions = new Set(
        result.diagnostics
          .filter(({ handling }) => handling.status === "active")
          .map(({ executionId }) => executionId),
      );
      const remaining = new Map<string, Set<string>>();
      for (const check of result.checks) {
        for (const { executionId, sourceKey, language } of check.executions) {
          if (!activeExecutions.has(executionId)) continue;
          let keys = remaining.get(language);
          if (!keys) {
            keys = new Set();
            remaining.set(language, keys);
          }
          keys.add(sourceKey);
        }
      }
      const total = snapshot.source.units.length;
      const progress = snapshot.translations.reads.map(({ language }) => {
        const finished = total - (remaining.get(language)?.size ?? 0);
        return {
          language,
          completed: finished,
          total,
          ...(total === 0 ? {} : { percentage: (100 * finished) / total }),
        };
      });
      completed = true;
      return { ...report, progress };
    } finally {
      stage?.();
      stage = profile?.stage("cleanup");
      try {
        qualityData.dispose();
        if (options.memo === undefined) memo.dispose();
      } finally {
        stage?.();
      }
    }
  } finally {
    stage?.();
    profile?.finish(completed ? "completed" : "interrupted");
  }
}

function resolveQualityCheckSelection<TCheck extends { readonly id: string }>(
  checks: readonly TCheck[],
  configuredGroups: unknown,
  options: { readonly checkIds?: unknown; readonly groups?: unknown },
): readonly TCheck[] {
  const checksById = new Map<string, TCheck>();
  for (const check of checks) {
    if (typeof check.id !== "string" || check.id.trim() === "")
      throw new TypeError("QA 检查项必须提供非空 id。");
    if (checksById.has(check.id))
      throw new TypeError(`QA 检查项 id ${check.id} 重复。`);
    checksById.set(check.id, check);
  }

  const groupsByName = new Map<string, readonly string[]>();
  if (configuredGroups !== undefined) {
    if (!isPlainRecord(configuredGroups))
      throw new TypeError("defineConfig 的 quality.groups 必须是对象。");
    for (const [groupName, members] of Object.entries(configuredGroups)) {
      if (
        !Array.isArray(members) ||
        members.some((id) => typeof id !== "string")
      )
        throw new TypeError(
          `defineConfig 的 quality.groups.${groupName} 必须是检查项 ID 数组。`,
        );
      for (const id of members) {
        if (!checksById.has(id))
          throw new TypeError(
            `质量检查分组 ${groupName} 引用了未配置的检查项 ${JSON.stringify(id)}。`,
          );
      }
      groupsByName.set(groupName, members);
    }
  }

  const { checkIds, groups } = options;
  if (checkIds !== undefined && groups !== undefined)
    throw new TypeError("质量检查不能同时使用 checkIds 和 groups 选择。");

  let selectedIds: Set<string> | undefined;
  if (checkIds !== undefined) {
    if (
      !Array.isArray(checkIds) ||
      checkIds.some((id) => typeof id !== "string")
    )
      throw new TypeError("checkIds 必须是检查项 ID 数组。");
    if (checkIds.length === 0) throw new TypeError("显式检查项选择不能为空。");
    selectedIds = new Set();
    for (const id of checkIds) {
      if (!checksById.has(id))
        throw new TypeError(`未配置质量检查项 ${JSON.stringify(id)}。`);
      selectedIds.add(id);
    }
  } else if (groups !== undefined) {
    if (
      !Array.isArray(groups) ||
      groups.some((name) => typeof name !== "string")
    )
      throw new TypeError("groups 必须是分组名数组。");
    if (groups.length === 0)
      throw new TypeError("显式检查项分组选择不能为空。");
    selectedIds = new Set();
    for (const name of groups) {
      const members = groupsByName.get(name);
      if (members === undefined)
        throw new TypeError(`未配置质量检查分组 ${JSON.stringify(name)}。`);
      for (const id of members) selectedIds.add(id);
    }
    if (selectedIds.size === 0)
      throw new TypeError("质量检查分组选择结果不能为空。");
  }

  if (selectedIds === undefined) return checks;
  return checks.filter(({ id }) => selectedIds!.has(id));
}

async function loadQaSuppressions<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  config: FrameworkConfig<TUnit, TTranslation, TBody, TUnavailable>,
): Promise<readonly QaSuppression[]> {
  const store = config.quality?.suppressionStore;
  if (store === undefined) return [];
  const suppressions: unknown = await store.load();
  validateQaSuppressions(suppressions);
  return suppressions;
}

function validateSourceRead(value: unknown): void {
  if (!isRecord(value) || !Array.isArray(value.scopes))
    invalidReadStructure("source.read 必须返回包含 scopes 数组的读取结果。");

  for (const [scopeIndex, scope] of value.scopes.entries()) {
    if (
      !isRecord(scope) ||
      !Array.isArray(scope.records) ||
      (scope.enumeration !== "complete" &&
        scope.enumeration !== "partial" &&
        scope.enumeration !== "failed") ||
      (scope.error !== undefined && typeof scope.error !== "string")
    )
      invalidReadStructure(
        `source.read 的第 ${scopeIndex + 1} 个范围结构无效。`,
      );
    assertJsonValue(scope.range, `原文范围 ${scopeIndex + 1}`);
    for (const [recordIndex, record] of scope.records.entries()) {
      if (
        !isRecord(record) ||
        (record.bodyAvailability !== "available" &&
          record.bodyAvailability !== "unavailable")
      )
        invalidReadStructure(
          `source.read 的第 ${scopeIndex + 1} 个范围中，第 ${recordIndex + 1} 条原文记录结构无效。`,
        );
    }
  }
}

function invalidReadStructure(message: string): never {
  throw new StandardSchemaContractError(
    "source.read",
    "schema-mismatch",
    message,
  );
}

function snapshotVersion(value: object): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}
