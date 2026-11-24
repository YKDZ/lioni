import { createHash, type Hash } from "node:crypto";

import { createMemoScope, type MemoScope } from "@lioni/memo";

import type {
  Translation,
  Awaitable,
  ProjectSnapshot,
  SourceReadCoverage,
  SourceUnit,
  TranslationAssociation,
  TranslationReadCoverage,
  TranslationUnitInput,
} from "../index.ts";
import { isRecord } from "../object-guards.ts";
import type { JsonValue, TranslationCandidate } from "../semantic-edits.ts";
import { stableStringifyJson } from "../stable-json.ts";
import {
  freezeJsonValue,
  isStandardSchema,
  snapshotJsonValue,
  StandardSchemaContractError,
  validateWithStandardSchema,
} from "../standard-schema.ts";
import type {
  IsSameType,
  PreservingStandardSchema,
  StandardSchemaV1,
} from "../standard-schema.ts";
import {
  savedTranslationCandidates,
  validateQualityCandidateScope,
} from "./candidate-contract.ts";
import type {
  QualityProfileSession,
  QualityProfileCandidateSession,
} from "./profiler.ts";
import {
  qaSuppressionMatchesExecution,
  validateQaSuppressions,
  type QaSuppression,
} from "./qa-suppressions.ts";
import {
  isCachedQualityFindings,
  type CachedQualityFindings,
  type QualityCheckResultCache,
} from "./quality-cache.ts";

export type QualityCheckStatus = "not-run" | "failed" | "complete";

export type QualityObject = {
  readonly kind: string;
  readonly key: string;
  readonly language?: string;
  readonly [field: string]: unknown;
};

export type QualityLocation = {
  readonly language: string | null;
  /** 宿主提供的资源范围；具体含义由相应适配器决定。 */
  readonly range: unknown;
  /** 宿主定义的资源内定位键，与逻辑对象身份分开提供。 */
  readonly key?: string;
  readonly [field: string]: unknown;
};

export type QualitySubject = {
  readonly key: string;
  readonly language: string;
};

export type QualityRelationship = {
  readonly kind: string;
  readonly key: string;
  readonly members: readonly QualitySubject[];
  readonly [field: string]: unknown;
};

export type QualityDiagnosticHandling =
  | { readonly status: "active" }
  | {
      readonly status: "suppressed";
      readonly suppressionId: string;
      readonly reason: string;
    };

export type QualityEvidence<TObject extends QualityObject = QualityObject> = {
  readonly role: string;
  readonly object: TObject;
  readonly location: QualityLocation;
  readonly value: unknown;
};

export type QualityDiagnostic<TObject extends QualityObject = QualityObject> =
  ReadonlyQualityValue<{
    readonly checkId: string;
    readonly executionId: number;
    readonly severity: "error" | "warning" | "info";
    readonly object: TObject;
    readonly location: QualityLocation;
    readonly message: string;
    readonly evidence: readonly QualityEvidence<TObject>[];
    readonly handling: QualityDiagnosticHandling;
  }>;

export type QualityFinding<TObject extends QualityObject = QualityObject> =
  Omit<QualityDiagnostic<TObject>, "checkId" | "executionId" | "handling">;

export type QualityCoverage = {
  readonly selected: number;
  readonly evaluated: number;
  readonly failed: number;
};

/** JsonValue 联合本身已递归只读；普通可赋值对象仍须逐层变为只读。 */
type ReadonlyQualityValue<TValue> =
  IsSameType<TValue, JsonValue> extends true
    ? TValue
    : TValue extends object
      ? { readonly [TKey in keyof TValue]: ReadonlyQualityValue<TValue[TKey]> }
      : TValue;

export type QualityCheckRequest<TBody = JsonValue> = {
  readonly candidates?: readonly TranslationCandidate<TBody>[];
  readonly relationships?: readonly QualityRelationship[];
  readonly suppressions?: readonly QaSuppression[];
};

/** 同一次 QA 的明确共享读取器；同一函数对象与同一参数共享结果及失败。 */
export type QualityDataReader = {
  readonly read: <TArguments extends readonly unknown[], TValue>(
    reader: (...args: TArguments) => Awaitable<TValue>,
    ...args: TArguments
  ) => Promise<TValue>;
};

type QualityDataReaderScope = {
  readonly dispose: () => void;
  readonly reader: QualityDataReader;
};

/** 动态接入未提供有效读取函数时直接报告的契约错误。 */
export class QualityDataReaderContractError extends TypeError {
  constructor() {
    super("qualityData.read 的读取函数必须是函数。");
    this.name = "QualityDataReaderContractError";
  }
}

/** 创建仅覆盖当前 QA 运行的检查资料读取范围。 */
function createQualityDataReader(): QualityDataReaderScope {
  const memo = createMemoScope();
  const operations = new WeakMap<
    object,
    (...args: readonly unknown[]) => Promise<JsonValue>
  >();
  const qualityData: QualityDataReader = {
    read<TArguments extends readonly unknown[], TValue>(
      reader: (...args: TArguments) => Awaitable<TValue>,
      ...args: TArguments
    ): Promise<TValue> {
      if (typeof reader !== "function")
        throw new QualityDataReaderContractError();
      let snapshotReader = operations.get(reader);
      if (snapshotReader === undefined) {
        snapshotReader = async (...readerArgs: readonly unknown[]) => {
          const value = await reader(...(readerArgs as unknown as TArguments));
          const snapshot = snapshotJsonValue(value, "QA 检查资料");
          freezeJsonValue(snapshot);
          return snapshot;
        };
        operations.set(reader, snapshotReader);
      }
      return memo.memo(snapshotReader)(...args) as Promise<TValue>;
    },
  };
  return {
    reader: qualityData,
    dispose: () => memo.dispose(),
  };
}

export type QualityDataLoadInput<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
> = {
  readonly snapshot: ProjectSnapshot<TUnit, TTranslation, TBody, TUnavailable>;
  /** 纯计算可跨本次检查运行复用；不用于缓存动态检查资料。 */
  readonly memo: MemoScope;
  readonly qualityData: QualityDataReader;
};

/** 一次加载所需的上下文。项目快照、候选和关系由本次运行共享，按只读约定使用。 */
export type CheckerLoadInput<
  TUnit extends TranslationUnitInput = TranslationUnitInput,
  TTranslation = unknown,
  TBody = unknown,
  TUnavailable = unknown,
> = QualityDataLoadInput<TUnit, TTranslation, TBody, TUnavailable> & {
  readonly candidates: readonly TranslationCandidate<TBody>[];
  readonly relationships: readonly QualityRelationship[];
};

/** 为当前检查对象准备规则消费的完整业务输入。 */
export type CheckerPrepareInput<
  TUnit extends TranslationUnitInput = TranslationUnitInput,
  TTranslation = unknown,
  TBody = unknown,
  TUnavailable = unknown,
  TLoaded = undefined,
> = Omit<
  CheckerLoadInput<TUnit, TTranslation, TBody, TUnavailable>,
  "qualityData"
> & {
  readonly candidate: TranslationCandidate<TBody> | null;
  readonly sourceUnit: SourceUnit<TUnit>;
  /** 同键同语言的现存记录。空值的读取依据见 association。 */
  readonly translation: Translation<TTranslation, TBody, TUnavailable> | null;
  readonly association: TranslationAssociation;
  /** 只读使用。其生命周期为当前运行，未声明 load 时为 undefined。 */
  readonly loaded: TLoaded;
};

export type CheckerDefinition<
  TSchema extends StandardSchemaV1<unknown, unknown>,
  TLoaded = undefined,
  TUnit extends TranslationUnitInput = TranslationUnitInput,
  TTranslation = unknown,
  TBody = unknown,
  TUnavailable = unknown,
  TObject extends QualityObject = QualityObject,
  TId extends string = string,
> = {
  readonly id: TId;
  readonly version: string;
  readonly inputSchema: TSchema &
    PreservingStandardSchema<StandardSchemaOutput<TSchema>, NoInfer<TSchema>>;
  /** 已选中且有检查对象时调用一次。动态资料可通过 qualityData.read 显式共享。 */
  readonly load?: (
    input: CheckerLoadInput<TUnit, TTranslation, TBody, TUnavailable>,
  ) => Awaitable<TLoaded>;
  readonly prepare: (
    input: CheckerPrepareInput<
      TUnit,
      TTranslation,
      TBody,
      TUnavailable,
      NoInfer<TLoaded>
    >,
  ) => Awaitable<NoInfer<StandardSchemaInput<TSchema>>>;
  /** 只消费已校验并固定的输入。缓存命中时不调用。 */
  readonly check: (
    input: ReadonlyQualityValue<NoInfer<StandardSchemaOutput<TSchema>>>,
  ) => Awaitable<readonly QualityFinding<TObject>[]>;
} & (undefined extends NoInfer<TLoaded> ? unknown : { readonly load: unknown });

/** 检查器声明或阶段返回结构不符合正式检查契约。 */
export class QualityCheckerContractError extends TypeError {
  readonly checkId: string;
  readonly stage: "definition" | "prepare" | "check";

  constructor(
    checkId: string,
    stage: "definition" | "prepare" | "check",
    message: string,
  ) {
    super(`QA 检查项 ${checkId} ${message}`);
    this.name = "QualityCheckerContractError";
    this.checkId = checkId;
    this.stage = stage;
  }
}

const qualityInputFingerprintFormat = "lioni.check-input/v2";
export type QualityInputFingerprintSummary = {
  readonly version: string;
  readonly inputFingerprint: string;
};

export type QualityCheckExecution = {
  readonly executionId: number;
  readonly candidateIndex?: number;
  readonly checkId: string;
  readonly sourceKey: string;
  readonly language: string;
  readonly status: "complete" | "failed";
  readonly error?: string;
  readonly inputFingerprint?: string;
  readonly fingerprintSummary?: QualityInputFingerprintSummary;
};

type QualityInputFingerprint = Pick<
  QualityCheckExecution,
  "inputFingerprint" | "fingerprintSummary"
>;

export type StandardSchemaInput<
  TSchema extends StandardSchemaV1<unknown, unknown>,
> = NonNullable<TSchema["~standard"]["types"]>["input"];

export type StandardSchemaOutput<
  TSchema extends StandardSchemaV1<unknown, unknown>,
> = NonNullable<TSchema["~standard"]["types"]>["output"];

type PreparedQualityCheck<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TObject extends QualityObject,
  TBody = unknown,
  TUnavailable = never,
> = {
  readonly version: string;
  readonly load?: (
    input: CheckerLoadInput<TUnit, TTranslation, TBody, TUnavailable>,
  ) => Awaitable<unknown>;
  readonly prepareInput: (
    input: CheckerPrepareInput<
      TUnit,
      TTranslation,
      TBody,
      TUnavailable,
      unknown
    >,
    context: QualityInputPreparationContext,
  ) => Awaitable<QualityCheckExecutionPreparation<TObject>>;
};

type QualityInputPreparationContext = {
  readonly sourceKey: string;
  readonly language: string;
  readonly startFingerprint: () => void;
  readonly endFingerprint: () => void;
};

type QualityCheckExecutionPreparation<TObject extends QualityObject> = {
  readonly fingerprint: Required<QualityInputFingerprint>;
  readonly cacheKey: string;
  readonly execute: () => Awaitable<readonly QualityFinding<TObject>[]>;
};

const qualityCheckDefinitionBrand: unique symbol = Symbol(
  "qualityCheckDefinition",
);

/** 不透明的检查器契约；私有函数类型仅保留宿主与检查输入的类型关系。 */
export type QualityCheckDefinition<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TObject extends QualityObject = QualityObject,
  TBody = unknown,
  TUnavailable = never,
  TId extends string = string,
> = {
  readonly [qualityCheckDefinitionBrand]: (
    input: CheckerPrepareInput<
      TUnit,
      TTranslation,
      TBody,
      TUnavailable,
      unknown
    >,
  ) => readonly QualityFinding<TObject>[];
  readonly id: TId;
  readonly version: string;
};

/** 宿主类型由公开定义约束，运行时按同一对象取回对应实现。 */
const qualityCheckImplementations = new WeakMap<object, unknown>();

function defineCheckerFor<
  TUnit extends TranslationUnitInput = TranslationUnitInput,
  TTranslation = unknown,
  TBody = unknown,
  TUnavailable = unknown,
>() {
  function define<
    TSchema extends StandardSchemaV1<unknown, unknown>,
    TObject extends QualityObject = QualityObject,
    const TId extends string = string,
    TLoaded = undefined,
  >(
    definition: CheckerDefinition<
      TSchema,
      TLoaded,
      TUnit,
      TTranslation,
      TBody,
      TUnavailable,
      TObject,
      TId
    >,
  ): QualityCheckDefinition<
    TUnit,
    TTranslation,
    TObject,
    TBody,
    TUnavailable,
    TId
  > {
    const { id, version, inputSchema, load, prepare, check } = definition;
    assertQualityCheckIdentity(id, version);
    if (!isStandardSchema(inputSchema))
      throw new QualityCheckerContractError(
        id,
        "definition",
        "的 inputSchema 必须是 Standard Schema。",
      );
    if (load !== undefined && typeof load !== "function")
      throw new QualityCheckerContractError(
        id,
        "definition",
        "的 load 必须是函数。",
      );
    if (typeof prepare !== "function" || typeof check !== "function")
      throw new QualityCheckerContractError(
        id,
        "definition",
        "必须提供 prepare 和 check 函数。",
      );

    const qualityCheck = {
      [qualityCheckDefinitionBrand]: true,
      id,
      version,
    } as const;
    const prepared: PreparedQualityCheck<
      TUnit,
      TTranslation,
      TObject,
      TBody,
      TUnavailable
    > = {
      version,
      ...(load === undefined ? {} : { load }),
      async prepareInput(input, context) {
        const preparation = await prepare(
          input as CheckerPrepareInput<
            TUnit,
            TTranslation,
            TBody,
            TUnavailable,
            TLoaded
          >,
        );
        const finalInput = await validateWithStandardSchema(
          inputSchema,
          preparation,
          `QA 检查器 ${id} 的输入`,
          { snapshotInput: true },
        );
        freezeJsonValue(finalInput);
        context.startFingerprint();
        try {
          return {
            ...prepareFingerprint(
              id,
              version,
              context,
              fingerprintQualityInputBasis(finalInput as JsonValue),
            ),
            execute: () =>
              check(
                finalInput as ReadonlyQualityValue<
                  StandardSchemaOutput<TSchema>
                >,
              ),
          };
        } finally {
          context.endFingerprint();
        }
      },
    };
    qualityCheckImplementations.set(qualityCheck, prepared);
    return qualityCheck as unknown as QualityCheckDefinition<
      TUnit,
      TTranslation,
      TObject,
      TBody,
      TUnavailable,
      TId
    >;
  }
  return define;
}

/**
 * 声明一次共享加载、逐对象准备及规则计算。规则所需的全部业务依据
 * 必须进入准备结果，框架用同一份固定输入计算指纹并执行规则。
 * 相同输入下规则语义变化时应更新 version。
 * 需要明确宿主类型时，可先调用 withTypes，schema、加载结果和 ID 仍由声明推导。
 */
export const defineChecker = Object.assign(defineCheckerFor(), {
  withTypes: defineCheckerFor,
});

function assertQualityCheckIdentity(id: string, version: string): void {
  if (typeof id !== "string" || id.trim() === "")
    throw new TypeError("QA 检查项必须提供非空 id。");
  if (typeof version !== "string" || version.trim() === "")
    throw new TypeError(`QA 检查项 ${id} 必须提供非空 version。`);
}

function prepareFingerprint(
  id: string,
  version: string,
  context: QualityInputPreparationContext,
  inputBasisFingerprint: string,
): {
  readonly fingerprint: Required<QualityInputFingerprint>;
  readonly cacheKey: string;
} {
  const fingerprint = qualityInputFingerprint(
    id,
    version,
    inputBasisFingerprint,
  );
  return {
    fingerprint,
    cacheKey: qualityCheckCacheKey(
      id,
      context.sourceKey,
      context.language,
      fingerprint.inputFingerprint,
    ),
  };
}

export type QualityCheckResult<TObject extends QualityObject = QualityObject> =
  {
    readonly checkId: string;
    readonly version: string;
    readonly status: QualityCheckStatus;
    readonly diagnostics: readonly QualityDiagnostic<TObject>[];
    readonly coverage: QualityCoverage;
    readonly executions: readonly QualityCheckExecution[];
  };

export type QualityCheckScope = {
  readonly configuredCount: number;
  readonly selectedIds: readonly string[];
};

export type QualityReadCoverage = {
  readonly source: SourceReadCoverage;
  readonly translations: readonly TranslationReadCoverage[];
  readonly associations: readonly (TranslationAssociation & {
    readonly subjectSelected: boolean;
  })[];
};

export type TranslationProgress = {
  readonly language: string;
  readonly completed: number;
  readonly total: number;
  readonly percentage?: number;
};

export type QualityRunResult<
  TObject extends QualityObject = QualityObject,
  TBody = JsonValue,
> = {
  readonly version: string;
  readonly candidates: readonly TranslationCandidate<TBody>[];
  readonly readCoverage: QualityReadCoverage;
  readonly checkScope: QualityCheckScope;
  readonly relationships: readonly QualityRelationship[];
  readonly suppressions: readonly QaSuppression[];
  readonly progress?: readonly TranslationProgress[];
  readonly status: QualityCheckStatus;
  readonly diagnostics: readonly QualityDiagnostic<TObject>[];
  readonly checks: readonly QualityCheckResult<TObject>[];
};

export type QualityExecutionOptions = {
  /** 由正式 QA 入口持有的内部采集运行。 */
  readonly profile?: QualityProfileSession;
  /** 传入的范围由调用方管理；省略时由本次 QA 创建并关闭。 */
  readonly memo?: MemoScope;
  /** 只复用已完成检查的原始结果；豁免仍按本次运行重新处理。 */
  readonly qualityCheckResultCache?: QualityCheckResultCache;
};

export async function runQualityChecks<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  snapshot: ProjectSnapshot<TUnit, TTranslation, TBody, TUnavailable>,
  request: QualityCheckRequest<TBody>,
  checks: readonly QualityCheckDefinition<
    TUnit,
    TTranslation,
    QualityObject,
    TBody,
    TUnavailable
  >[],
  options: QualityExecutionOptions = {},
): Promise<QualityRunResult<QualityObject, TBody>> {
  const qualityData = createQualityDataReader();
  const memo = options.memo ?? createMemoScope();
  try {
    if (request.candidates !== undefined)
      validateQualityCandidateScope(snapshot, request.candidates);
    const identityKey = (key: {
      readonly sourceKey: string;
      readonly language: string;
    }) => JSON.stringify([key.sourceKey, key.language]);
    const byIdentity = new Map(
      snapshot.associations.map((association) => [
        identityKey(association),
        association,
      ]),
    );
    const sourceUnits = new Map(
      snapshot.source.units.map((unit) => [unit.key, unit]),
    );
    const selectedAssociations =
      request.candidates === undefined
        ? snapshot.associations
        : request.candidates.map((candidate) => {
            const association = byIdentity.get(identityKey(candidate));
            if (!association)
              throw new TypeError("送检候选缺少对应的源译关联。");
            return association;
          });
    const candidates = snapshotQualityData(
      request.candidates ?? savedTranslationCandidates(snapshot),
    );
    const candidateByIdentity = new Map(
      candidates.map((candidate, index) => [
        identityKey(candidate),
        { candidate, index },
      ]),
    );
    const subjects = selectedAssociations.map((association) => {
      const sourceUnit = sourceUnits.get(association.sourceKey);
      if (!sourceUnit) throw new TypeError("送检对象缺少对应的原文单元。");
      const [translationIndex] = association.translationIndexes;
      const entry = candidateByIdentity.get(identityKey(association));
      return {
        sourceUnit,
        association,
        candidateIndex: entry?.index,
        translation:
          translationIndex === undefined
            ? null
            : (snapshot.translations.records[translationIndex] ?? null),
        candidate: entry?.candidate ?? null,
      };
    });
    const selected = new Set(selectedAssociations.map(identityKey));
    const relationships = snapshotQualityData(request.relationships ?? []);
    const suppressions = snapshotQualityData(request.suppressions ?? []);
    validateQaSuppressions(suppressions);
    const preparedChecks: {
      readonly id: string;
      readonly prepared: PreparedQualityCheck<
        TUnit,
        TTranslation,
        QualityObject,
        TBody,
        TUnavailable
      >;
      readonly loaded: unknown;
      readonly loadFailure?: { readonly error: unknown };
    }[] = [];
    const checkIds = new Set<string>();
    for (const definition of checks) {
      options.profile?.configure(
        definition.id,
        options.qualityCheckResultCache !== undefined,
      );
      if (checkIds.has(definition.id))
        throw new TypeError(`QA 检查项 id ${definition.id} 重复。`);
      checkIds.add(definition.id);
      const prepared = qualityCheckImplementations.get(definition) as
        | PreparedQualityCheck<
            TUnit,
            TTranslation,
            QualityObject,
            TBody,
            TUnavailable
          >
        | undefined;
      if (prepared === undefined)
        throw new TypeError(
          `QA 检查项 ${definition.id} 必须由 defineChecker 创建。`,
        );

      let loaded: unknown;
      let loadFailure: { readonly error: unknown } | undefined;
      if (subjects.length > 0 && prepared.load !== undefined) {
        const endLoad = options.profile?.checkStage(definition.id, "load");
        try {
          loaded = await prepared.load({
            snapshot,
            candidates,
            relationships,
            memo,
            qualityData: qualityData.reader,
          });
        } catch (error) {
          if (isQualityContractError(error)) throw error;
          loadFailure = { error };
        } finally {
          endLoad?.();
        }
      }
      preparedChecks.push({
        id: definition.id,
        prepared,
        loaded,
        ...(loadFailure === undefined ? {} : { loadFailure }),
      });
    }

    const results: QualityCheckResult[] = [];
    let nextExecutionId = 0;
    for (const { id, prepared, loaded, loadFailure } of preparedChecks) {
      const diagnostics: QualityDiagnostic[] = [];
      const executions: QualityCheckExecution[] = [];
      for (const [
        subjectIndex,
        { candidateIndex, ...subject },
      ] of subjects.entries()) {
        const { sourceKey, language } = subject.association;
        const candidateProfile = options.profile?.candidate(
          id,
          {
            subjectIndex,
            sourceKey,
            language,
          },
          options.qualityCheckResultCache !== undefined,
        );
        const executionId = nextExecutionId;
        nextExecutionId += 1;
        let fingerprint: QualityInputFingerprint | undefined;
        let errorMessage: string | undefined;
        let findings: readonly QualityFinding[] = [];
        try {
          if (loadFailure !== undefined) throw loadFailure.error;
          const endPreparation = candidateProfile?.stage("prepareInput");
          let endFingerprintStage: (() => void) | undefined;
          const preparationContext: QualityInputPreparationContext = {
            sourceKey,
            language,
            startFingerprint() {
              endPreparation?.();
              endFingerprintStage = candidateProfile?.stage("fingerprint");
            },
            endFingerprint() {
              endFingerprintStage?.();
              endFingerprintStage = undefined;
            },
          };
          let preparation;
          try {
            preparation = await prepared.prepareInput(
              {
                ...subject,
                snapshot,
                candidates,
                relationships,
                loaded,
                memo,
              },
              preparationContext,
            );
          } finally {
            endPreparation?.();
            preparationContext.endFingerprint();
          }
          fingerprint = preparation.fingerprint;
          findings = await resolveQualityFindings(
            id,
            preparation,
            options.qualityCheckResultCache,
            candidateProfile,
          );
        } catch (error) {
          if (isQualityContractError(error)) throw error;
          errorMessage = error instanceof Error ? error.message : String(error);
        }
        const endResults = candidateProfile?.stage("results");
        const status = errorMessage === undefined ? "complete" : "failed";
        const execution: QualityCheckExecution = {
          executionId,
          ...(candidateIndex === undefined ? {} : { candidateIndex }),
          checkId: id,
          sourceKey,
          language,
          status,
          ...(errorMessage === undefined ? {} : { error: errorMessage }),
          ...fingerprint,
        };
        executions.push(execution);
        diagnostics.push(
          ...findings.map((diagnostic) => ({
            ...diagnostic,
            checkId: id,
            executionId,
            handling: handlingFor(execution, suppressions),
          })),
        );
        endResults?.();
        candidateProfile?.finish(status);
      }

      const failed = executions.filter(
        (execution) => execution.status === "failed",
      ).length;
      results.push({
        checkId: id,
        version: prepared.version,
        status: aggregateStatus(executions.map(({ status }) => status)),
        diagnostics,
        coverage: {
          selected: executions.length,
          evaluated: executions.length - failed,
          failed,
        },
        executions,
      });
    }

    return {
      version: snapshot.version,
      candidates,
      relationships,
      checkScope: {
        configuredCount: checks.length,
        selectedIds: checks.map(({ id }) => id),
      },
      suppressions,
      readCoverage: snapshotQualityData({
        source: snapshot.source.read,
        translations: snapshot.translations.reads,
        associations: snapshot.associations.map((association) => ({
          ...association,
          subjectSelected: selected.has(identityKey(association)),
        })),
      }),
      status: aggregateStatus(results.map(({ status }) => status)),
      diagnostics: results.flatMap(({ diagnostics }) => diagnostics),
      checks: results,
    };
  } finally {
    options.profile?.endChecks();
    const endCleanup = options.profile?.stage("cleanup");
    try {
      qualityData.dispose();
      if (options.memo === undefined) memo.dispose();
    } finally {
      endCleanup?.();
    }
  }
}

function isQualityContractError(error: unknown): boolean {
  return (
    error instanceof StandardSchemaContractError ||
    error instanceof QualityDataReaderContractError ||
    error instanceof QualityCheckerContractError
  );
}

function snapshotQualityData<TValue>(
  value: TValue,
  valueDescription = "QA 输入与结果",
): TValue {
  return snapshotJsonValue(value, valueDescription) as TValue;
}

function qualityInputFingerprint(
  checkId: string,
  version: string,
  inputBasisFingerprint: string,
): Required<QualityInputFingerprint> {
  return {
    inputFingerprint: fingerprintJsonObjectComponents([
      ["checkId", fingerprintJsonValue(checkId)],
      [
        "fingerprintFormat",
        fingerprintJsonValue(qualityInputFingerprintFormat),
      ],
      ["inputFingerprint", inputBasisFingerprint],
      ["version", fingerprintJsonValue(version)],
    ]),
    fingerprintSummary: {
      version,
      inputFingerprint: inputBasisFingerprint,
    },
  };
}

function qualityCheckCacheKey(
  checkId: string,
  sourceKey: string,
  language: string,
  inputFingerprint: string,
): string {
  return fingerprintJsonValue({
    checkId,
    sourceKey,
    language,
    inputFingerprint,
  });
}

async function resolveQualityFindings(
  checkId: string,
  preparation: QualityCheckExecutionPreparation<QualityObject>,
  cache?: QualityCheckResultCache,
  profile?: QualityProfileCandidateSession,
): Promise<CachedQualityFindings> {
  if (cache) {
    const end = profile?.stage("cacheRead");
    try {
      const cached = await cache.get(preparation.cacheKey);
      if (isCachedQualityFindings(cached)) {
        profile?.read("hit");
        const endSnapshot = profile?.stage("snapshot");
        try {
          return snapshotQualityData(cached);
        } finally {
          endSnapshot?.();
        }
      }
      profile?.read(cached === undefined ? "miss" : "invalid");
    } catch {
      profile?.read("error");
    } finally {
      end?.();
    }
  }
  profile?.executed();
  const endExecute = profile?.stage("execute");
  let findings;
  try {
    findings = await preparation.execute();
  } finally {
    endExecute?.();
  }
  const endSnapshot = profile?.stage("snapshot");
  try {
    if (!isCachedQualityFindings(findings))
      throw new QualityCheckerContractError(
        checkId,
        "check",
        "的 check 必须返回有效的诊断数组。",
      );
    findings = snapshotQualityData(findings);
    freezeJsonValue(findings);
  } finally {
    endSnapshot?.();
  }
  if (cache) {
    const end = profile?.stage("cacheWrite");
    try {
      await cache.set(preparation.cacheKey, findings);
      profile?.write("completed");
    } catch {
      profile?.write("error");
    } finally {
      end?.();
    }
  }
  return findings;
}

function fingerprintQualityInputBasis(value: JsonValue): string {
  if (Array.isArray(value))
    return fingerprintJsonArrayComponents(
      value.map((item, index) => [String(index), fingerprintJsonValue(item)]),
    );
  if (isRecord(value))
    return fingerprintJsonObjectComponents(
      Object.entries(value).map(([key, item]) => [
        key,
        fingerprintJsonValue(item as JsonValue),
      ]),
    );
  return fingerprintJsonValue(value);
}

function fingerprintJsonValue(value: JsonValue): string {
  const type =
    value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  return fingerprintComponents(`json-value:${type}`, [
    ["value", stableStringifyJson(value)],
  ]);
}

function fingerprintJsonObjectComponents(
  components: readonly (readonly [key: string, fingerprint: string])[],
): string {
  return fingerprintComponents(
    "json-object",
    [...components]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, fingerprint]) => [JSON.stringify(key), fingerprint]),
  );
}

function fingerprintJsonArrayComponents(
  components: readonly (readonly [index: string, fingerprint: string])[],
): string {
  return fingerprintComponents("json-array", components);
}

function fingerprintComponents(
  domain: string,
  components: readonly (readonly [key: string, fingerprint: string])[],
): string {
  const hash = createHash("sha256");
  updateFingerprintHash(hash, qualityInputFingerprintFormat);
  updateFingerprintHash(hash, domain);
  for (const [key, fingerprint] of components) {
    updateFingerprintHash(hash, key);
    updateFingerprintHash(hash, fingerprint);
  }
  return `sha256:${hash.digest("hex")}`;
}

function updateFingerprintHash(hash: Hash, value: string): void {
  hash.update(Buffer.byteLength(value).toString(10));
  hash.update(":");
  hash.update(value);
}

function handlingFor(
  execution: QualityCheckExecution,
  suppressions: readonly QaSuppression[],
): QualityDiagnosticHandling {
  const suppression = suppressions.find((candidate) =>
    qaSuppressionMatchesExecution(candidate, execution),
  );
  return suppression === undefined
    ? { status: "active" }
    : {
        status: "suppressed",
        suppressionId: suppression.id,
        reason: suppression.reason,
      };
}

function aggregateStatus(
  statuses: readonly QualityCheckStatus[],
): QualityCheckStatus {
  if (
    statuses[0] === undefined ||
    statuses.every((status) => status === "not-run")
  )
    return "not-run";
  if (statuses.includes("failed")) return "failed";
  return "complete";
}
