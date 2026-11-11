import { createHash, type Hash } from "node:crypto";

import { createMemoScope, type MemoScope } from "@lioni/memo";

import type {
  ActualTranslationFact,
  Awaitable,
  FrameworkFacts,
  SourceReadFact,
  SourceUnitFact,
  TranslationAssociationFact,
  TranslationReadFact,
  TranslationUnitInput,
} from "../index.ts";
import { isRecord } from "../object-guards.ts";
import type { JsonValue, SemanticEditCandidate } from "../semantic-edits.ts";
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
import { validateQualityCandidateScope } from "./candidate-contract.ts";
import type {
  QualityProfileSession,
  QualityProfileCandidateSession,
} from "./profiler.ts";
import {
  isCacheableQualityCheckOutcome,
  isQualityCheckOutcome,
  isQualityIssue,
  isReusableQualityCheckOutcome,
  type CacheableQualityCheckOutcome,
  type QualityCheckResultCache,
} from "./quality-cache.ts";
import {
  evaluateQualityExceptionApplicability,
  qualityExceptionMatchesExecution,
  validateQualityExceptions,
} from "./quality-exceptions.ts";
import type {
  QualityException,
  QualityExceptionApplicability,
} from "./quality-exceptions.ts";

export type QualityCheckStatus =
  | "not-run"
  | "not-applicable"
  | "incomplete"
  | "failed"
  | "complete";

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
      readonly status: "excepted";
      readonly exceptionId: string;
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

export type QualityIssue<TObject extends QualityObject = QualityObject> =
  ReadonlyQualityValue<{
    readonly code: string;
    readonly message: string;
    readonly object?: TObject;
    readonly location?: QualityLocation;
    readonly evidence?: readonly QualityEvidence<TObject>[];
  }>;

export type QualityCoverage = {
  readonly selected: number;
  readonly evaluated: number;
  readonly notApplicable: number;
  readonly incomplete: number;
  readonly failed: number;
};

/** JsonValue 联合本身已递归只读；普通可赋值对象仍须逐层变为只读。 */
type ReadonlyQualityValue<TValue> =
  IsSameType<TValue, JsonValue> extends true
    ? TValue
    : TValue extends object
      ? { readonly [TKey in keyof TValue]: ReadonlyQualityValue<TValue[TKey]> }
      : TValue;

type MutableQualityCoverage = {
  -readonly [TKey in keyof QualityCoverage]: QualityCoverage[TKey];
};

type AcceptedQualityCheckOutcome = {
  readonly outcome: QualityCheckOutcome;
  readonly cacheableOutcome?: CacheableQualityCheckOutcome;
};

type QualityCheckOutcomeResolution =
  | { readonly outcome: QualityCheckOutcome }
  | {
      readonly execute: () => Awaitable<QualityCheckOutcome>;
      readonly cache?: QualityCheckResultCache;
      readonly cacheKey?: string;
    };

/**
 * 检查器返回的原始结果。QA 在接入时隔离一次，之后缓存与报告共享只读数据；
 * 检查器完成返回后不得继续修改原对象。
 */
export type QualityCheckOutcome<TObject extends QualityObject = QualityObject> =
  {
    readonly status: Exclude<QualityCheckStatus, "not-run">;
    readonly diagnostics: readonly QualityFinding<TObject>[];
    readonly issues: readonly QualityIssue<TObject>[];
    readonly coverage: QualityCoverage;
  };

export type QualityCheckRequest<TBody = JsonValue> = {
  readonly candidates: readonly SemanticEditCandidate<TBody>[];
  readonly relationships?: readonly QualityRelationship[];
  readonly exceptions?: readonly QualityException[];
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
export function createQualityDataReader(): QualityDataReaderScope {
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
  readonly facts: FrameworkFacts<TUnit, TTranslation, TBody, TUnavailable>;
  /** 纯计算可跨本次检查运行复用；不用于缓存动态检查资料。 */
  readonly memo: MemoScope;
  readonly qualityData: QualityDataReader;
};

/** 一次加载所需的上下文。事实、候选和关系由本次运行共享，按只读约定使用。 */
export type CheckerLoadInput<
  TUnit extends TranslationUnitInput = TranslationUnitInput,
  TTranslation = unknown,
  TBody = unknown,
  TUnavailable = unknown,
> = QualityDataLoadInput<TUnit, TTranslation, TBody, TUnavailable> & {
  readonly candidates: readonly SemanticEditCandidate<TBody>[];
  readonly relationships: readonly QualityRelationship[];
};

/** 为当前候选准备规则消费的完整业务输入。 */
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
  readonly candidate: SemanticEditCandidate<TBody>;
  readonly sourceUnit: SourceUnitFact<TUnit>;
  /** 同键同语言的现存记录。空值的读取依据见 association。 */
  readonly translation: ActualTranslationFact<
    TTranslation,
    TBody,
    TUnavailable
  > | null;
  readonly association: TranslationAssociationFact;
  /** 只读使用。其生命周期为当前运行，未声明 load 时为 undefined。 */
  readonly loaded: TLoaded;
};

export type CheckerPreparation<
  TInput,
  TObject extends QualityObject = QualityObject,
> =
  | { readonly status: "ready"; readonly input: TInput }
  | { readonly status: "not-applicable" }
  | { readonly status: "incomplete"; readonly issue: QualityIssue<TObject> };

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
  /** 已选中且有候选时调用一次。动态资料可通过 qualityData.read 显式共享。 */
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
  ) => Awaitable<
    CheckerPreparation<NoInfer<StandardSchemaInput<TSchema>>, TObject>
  >;
  /** 只消费已校验并固定的输入。缓存命中时不调用。 */
  readonly check: (
    input: ReadonlyQualityValue<NoInfer<StandardSchemaOutput<TSchema>>>,
  ) => Awaitable<QualityCheckOutcome<TObject>>;
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
  readonly candidateIndex: number;
  readonly checkId: string;
  readonly sourceKey: string;
  readonly language: string;
  readonly status: QualityCheckStatus;
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

type QualityCheckPreparer = () => Promise<unknown>;

type QualityCheckExecutionPreparation<TObject extends QualityObject> =
  | {
      readonly status: "not-applicable" | "incomplete";
      readonly outcome: QualityCheckOutcome<TObject>;
    }
  | {
      readonly status: "ready";
      readonly fingerprint: Required<QualityInputFingerprint>;
      readonly cacheKey: string;
      readonly execute: () => Awaitable<QualityCheckOutcome<TObject>>;
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
  ) => QualityCheckOutcome<TObject>;
  readonly id: TId;
  readonly version: string;
};

/** 将执行状态与公开检查器对象分离，避免暴露内部准备和执行协议。 */
const qualityCheckPreparers = new WeakMap<object, QualityCheckPreparer>();

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
        if (!isCheckerPreparation(preparation))
          throw new QualityCheckerContractError(
            id,
            "prepare",
            "的 prepare 返回了无效结果。",
          );
        if (preparation.status === "not-applicable")
          return {
            status: "not-applicable",
            outcome: checkerOutcome<TObject>("not-applicable"),
          };
        if (preparation.status === "incomplete")
          return {
            status: "incomplete",
            outcome: checkerOutcome<TObject>("incomplete", preparation.issue),
          };

        const finalInput = await validateWithStandardSchema(
          inputSchema,
          preparation.input,
          `QA 检查器 ${id} 的输入`,
          { snapshotInput: true },
        );
        freezeJsonValue(finalInput);
        context.startFingerprint();
        try {
          return {
            status: "ready",
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
    qualityCheckPreparers.set(qualityCheck, async () => prepared);
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
 * 声明一次共享加载、逐候选准备及规则计算。规则所需的全部业务依据
 * 必须进入准备结果，框架用同一份固定输入计算指纹并执行规则。
 * 相同输入下规则语义变化时应更新 version。
 * 需要明确宿主类型时，可先调用 withTypes，schema、加载结果和 ID 仍由声明推导。
 */
export const defineChecker = Object.assign(defineCheckerFor(), {
  withTypes: defineCheckerFor,
});

function isCheckerPreparation(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.status === "ready") return Object.hasOwn(value, "input");
  if (value.status === "not-applicable") return true;
  return value.status === "incomplete" && isQualityIssue(value.issue);
}

function checkerOutcome<TObject extends QualityObject>(
  status: "not-applicable" | "incomplete",
  issue?: QualityIssue<TObject>,
): QualityCheckOutcome<TObject> {
  return {
    status,
    diagnostics: [],
    issues: issue === undefined ? [] : [issue],
    coverage: {
      selected: 1,
      evaluated: 0,
      notApplicable: status === "not-applicable" ? 1 : 0,
      incomplete: status === "incomplete" ? 1 : 0,
      failed: 0,
    },
  };
}

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
    readonly issues: readonly QualityIssue<TObject>[];
    readonly coverage: QualityCoverage;
    readonly executions: readonly QualityCheckExecution[];
  };

export type QualityCheckScope = {
  readonly configuredCount: number;
  readonly selectedIds: readonly string[];
};

export type QualityFactCoverage = {
  readonly source: SourceReadFact;
  readonly translations: readonly TranslationReadFact[];
  readonly associations: readonly (TranslationAssociationFact & {
    readonly candidateSelected: boolean;
  })[];
};

export type QualityRunResult<
  TObject extends QualityObject = QualityObject,
  TBody = JsonValue,
> = {
  readonly version: string;
  readonly candidates: readonly SemanticEditCandidate<TBody>[];
  readonly factCoverage: QualityFactCoverage;
  readonly checkScope: QualityCheckScope;
  readonly relationships: readonly QualityRelationship[];
  readonly exceptions: readonly QualityException[];
  readonly exceptionApplicability: readonly QualityExceptionApplicability[];
  readonly status: QualityCheckStatus;
  readonly diagnostics: readonly QualityDiagnostic<TObject>[];
  readonly checks: readonly QualityCheckResult<TObject>[];
};

export type QualityExecutionOptions = {
  /** 由正式 QA 入口持有的内部采集运行。 */
  readonly profile?: QualityProfileSession;
  /** 传入的范围由调用方管理；省略时由本次 QA 创建并关闭。 */
  readonly memo?: MemoScope;
  /** 只复用已完成检查的原始结果；例外仍按本次运行重新处理。 */
  readonly qualityCheckResultCache?: QualityCheckResultCache;
};

export async function runQualityChecks<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  facts: FrameworkFacts<TUnit, TTranslation, TBody, TUnavailable>,
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
  validateQualityCandidateScope(facts, request.candidates);
  const qualityData = createQualityDataReader();
  try {
    return await runQualityChecksWithQualityData(
      facts,
      request,
      checks,
      options,
      qualityData,
    );
  } finally {
    qualityData.dispose();
  }
}

/** 正式 QA 入口共用其运行级资料 reader；不通过产品索引公开。 */
export async function runQualityChecksWithQualityData<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  facts: FrameworkFacts<TUnit, TTranslation, TBody, TUnavailable>,
  request: QualityCheckRequest<TBody>,
  checks: readonly QualityCheckDefinition<
    TUnit,
    TTranslation,
    QualityObject,
    TBody,
    TUnavailable
  >[],
  options: QualityExecutionOptions = {},
  qualityData: QualityDataReaderScope,
): Promise<QualityRunResult<QualityObject, TBody>> {
  const memo = options.memo ?? createMemoScope();
  try {
    const boundRequest = snapshotQualityData({
      candidates: request.candidates,
      relationships: request.relationships ?? [],
    });
    const exceptionInput = request.exceptions ?? [];
    validateQualityExceptions(exceptionInput);
    const exceptions = snapshotQualityData(exceptionInput);
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
      const prepare = qualityCheckPreparers.get(definition);
      if (prepare === undefined)
        throw new TypeError(
          `QA 检查项 ${definition.id} 必须由 defineChecker 创建。`,
        );
      const prepared = (await prepare()) as PreparedQualityCheck<
        TUnit,
        TTranslation,
        QualityObject,
        TBody,
        TUnavailable
      >;

      let loaded: unknown;
      let loadFailure: { readonly error: unknown } | undefined;
      if (boundRequest.candidates.length > 0 && prepared.load !== undefined) {
        const endLoad = options.profile?.checkStage(definition.id, "load");
        try {
          loaded = await prepared.load({
            facts,
            ...boundRequest,
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
    const sourceUnits = new Map(
      facts.source.units.map((unit) => [unit.key, unit]),
    );
    const associations = new Map<
      string,
      Map<string, TranslationAssociationFact>
    >();
    for (const association of facts.associations) {
      let languageAssociations = associations.get(association.language);
      if (languageAssociations === undefined) {
        languageAssociations = new Map();
        associations.set(association.language, languageAssociations);
      }
      languageAssociations.set(association.sourceKey, association);
    }
    const selectedLanguages = new Map<string, Set<string>>();
    for (const { sourceKey, language } of boundRequest.candidates) {
      const languages = selectedLanguages.get(sourceKey) ?? new Set<string>();
      languages.add(language);
      selectedLanguages.set(sourceKey, languages);
    }
    let nextExecutionId = 0;
    for (const { id, prepared, loaded, loadFailure } of preparedChecks) {
      const diagnostics: QualityDiagnostic[] = [];
      const issues: QualityIssue[] = [];
      const executions: QualityCheckExecution[] = [];
      const coverage: MutableQualityCoverage = {
        selected: 0,
        evaluated: 0,
        notApplicable: 0,
        incomplete: 0,
        failed: 0,
      };
      const statuses: QualityCheckStatus[] = [];

      for (const [
        candidateIndex,
        candidate,
      ] of boundRequest.candidates.entries()) {
        const candidateProfile = options.profile?.candidate(
          id,
          {
            candidateIndex,
            sourceKey: candidate.sourceKey,
            language: candidate.language,
          },
          options.qualityCheckResultCache !== undefined,
        );
        const executionId = nextExecutionId;
        nextExecutionId += 1;
        let fingerprint: QualityInputFingerprint | undefined;
        let outcomeResolution: QualityCheckOutcomeResolution;
        try {
          if (loadFailure !== undefined) throw loadFailure.error;
          const sourceUnit = sourceUnits.get(candidate.sourceKey) ?? null;
          const association = associations
            .get(candidate.language)
            ?.get(candidate.sourceKey);
          if (sourceUnit === null || association === undefined)
            throw new QualityCheckerContractError(
              id,
              "prepare",
              "无法解析候选的源译关联。",
            );
          const translationIndex = association.translationIndexes[0];
          const translation =
            translationIndex === undefined
              ? null
              : (facts.translations.records[translationIndex] ?? null);
          const endPreparation = candidateProfile?.stage("prepareInput");
          let endFingerprintStage: (() => void) | undefined;
          const preparationContext: QualityInputPreparationContext = {
            sourceKey: candidate.sourceKey,
            language: candidate.language,
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
                candidate,
                sourceUnit,
                translation,
                association,
                facts,
                candidates: boundRequest.candidates,
                relationships: boundRequest.relationships,
                loaded,
                memo,
              },
              preparationContext,
            );
          } finally {
            endPreparation?.();
            preparationContext.endFingerprint();
          }
          if (preparation.status === "ready") {
            fingerprint = preparation.fingerprint;
            const key = preparation.cacheKey;
            const execute = preparation.execute.bind(preparation);
            outcomeResolution = {
              execute: async () => {
                try {
                  return await execute();
                } catch (error) {
                  if (isQualityContractError(error)) throw error;
                  return failedQualityCheckOutcome(candidate, error);
                }
              },
              ...(options.qualityCheckResultCache === undefined
                ? {}
                : {
                    cache: options.qualityCheckResultCache,
                    cacheKey: key,
                  }),
            };
          } else {
            outcomeResolution = { outcome: preparation.outcome };
          }
        } catch (error) {
          if (isQualityContractError(error)) throw error;
          outcomeResolution = {
            outcome: failedQualityCheckOutcome(candidate, error),
          };
        }

        const accepted = await resolveQualityCheckOutcome(
          id,
          outcomeResolution,
          candidateProfile,
        );
        const stableOutcome = accepted.outcome;
        const endResults = candidateProfile?.stage("results");
        const findings = stableOutcome.diagnostics;
        issues.push(...stableOutcome.issues);
        statuses.push(stableOutcome.status);
        addCoverage(coverage, stableOutcome.coverage);
        const executionWithoutFingerprint: QualityCheckExecution = {
          executionId,
          candidateIndex,
          checkId: id,
          sourceKey: candidate.sourceKey,
          language: candidate.language,
          status: stableOutcome.status,
        };
        const execution: QualityCheckExecution =
          fingerprint === undefined
            ? executionWithoutFingerprint
            : { ...executionWithoutFingerprint, ...fingerprint };
        executions.push(execution);
        diagnostics.push(
          ...findings.map((diagnostic) => ({
            ...diagnostic,
            checkId: id,
            executionId,
            handling: handlingFor(execution, exceptions),
          })),
        );
        endResults?.();
        candidateProfile?.finish(stableOutcome.status);
      }

      results.push({
        checkId: id,
        version: prepared.version,
        status: aggregateStatus(statuses),
        diagnostics,
        issues,
        coverage,
        executions,
      });
    }

    return {
      version: facts.version,
      ...boundRequest,
      checkScope: {
        configuredCount: checks.length,
        selectedIds: checks.map(({ id }) => id),
      },
      exceptions,
      exceptionApplicability: evaluateQualityExceptionApplicability(
        exceptions,
        results.flatMap(({ executions }) => executions),
      ),
      factCoverage: snapshotQualityData({
        source: facts.source.read,
        translations: facts.translations.reads,
        associations: facts.associations.map((association) => ({
          ...association,
          candidateSelected:
            selectedLanguages
              .get(association.sourceKey)
              ?.has(association.language) ?? false,
        })),
      }),
      status: aggregateStatus(results.map(({ status }) => status)),
      diagnostics: results.flatMap(({ diagnostics }) => diagnostics),
      checks: results,
    };
  } finally {
    options.profile?.endChecks();
    if (options.memo === undefined) memo.dispose();
  }
}

function isQualityContractError(error: unknown): boolean {
  return (
    error instanceof StandardSchemaContractError ||
    error instanceof QualityDataReaderContractError ||
    error instanceof QualityCheckerContractError
  );
}

function addCoverage(
  target: MutableQualityCoverage,
  addition: QualityCoverage,
): void {
  target.selected += addition.selected;
  target.evaluated += addition.evaluated;
  target.notApplicable += addition.notApplicable;
  target.incomplete += addition.incomplete;
  target.failed += addition.failed;
}

function snapshotQualityData<TValue>(
  value: TValue,
  valueDescription = "QA 输入与结果",
): TValue {
  return snapshotJsonValue(value, valueDescription) as TValue;
}

function failedQualityCheckOutcome<TBody>(
  candidate: SemanticEditCandidate<TBody>,
  error: unknown,
): QualityCheckOutcome {
  return {
    status: "failed",
    diagnostics: [],
    issues: [
      {
        code: "checkFailed",
        message: error instanceof Error ? error.message : String(error),
        object: candidateObject(candidate),
      },
    ],
    coverage: {
      selected: 1,
      evaluated: 0,
      notApplicable: 0,
      incomplete: 0,
      failed: 1,
    },
  };
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

async function readCachedQualityOutcome(
  cache: QualityCheckResultCache,
  key: string,
  profile?: QualityProfileCandidateSession,
): Promise<AcceptedQualityCheckOutcome | undefined> {
  const end = profile?.stage("cacheRead");
  try {
    const outcome = await cache.get(key);
    if (outcome === undefined) {
      profile?.read("miss");
      return undefined;
    }
    const accepted = acceptQualityCheckOutcome(outcome, "cache", profile);
    if (accepted === undefined) {
      profile?.read("invalid");
      return undefined;
    }
    profile?.read("hit");
    return accepted;
  } catch {
    profile?.read("error");
    return undefined;
  } finally {
    end?.();
  }
}

/** 缓存读取、规则执行和结果交接共用同一入口。 */
async function resolveQualityCheckOutcome(
  checkId: string,
  resolution: QualityCheckOutcomeResolution,
  profile?: QualityProfileCandidateSession,
): Promise<AcceptedQualityCheckOutcome> {
  if ("outcome" in resolution)
    return acceptQualityCheckOutcome(resolution.outcome, { checkId }, profile);

  const { cache, cacheKey, execute } = resolution;
  if (cache !== undefined && cacheKey !== undefined) {
    const cached = await readCachedQualityOutcome(cache, cacheKey, profile);
    if (cached !== undefined) return cached;
  }

  profile?.executed();
  const endExecute = profile?.stage("execute");
  let outcome: QualityCheckOutcome;
  try {
    outcome = await execute();
  } finally {
    endExecute?.();
  }

  const accepted = acceptQualityCheckOutcome(outcome, { checkId }, profile);
  if (
    cache !== undefined &&
    cacheKey !== undefined &&
    accepted.cacheableOutcome !== undefined
  )
    await writeCachedQualityOutcome(
      cache,
      cacheKey,
      accepted.cacheableOutcome,
      profile,
    );
  return accepted;
}

function acceptQualityCheckOutcome(
  outcome: QualityCheckOutcome,
  source: { readonly checkId: string },
  profile?: QualityProfileCandidateSession,
): AcceptedQualityCheckOutcome;
function acceptQualityCheckOutcome(
  outcome: unknown,
  source: "cache",
  profile?: QualityProfileCandidateSession,
): AcceptedQualityCheckOutcome | undefined;
function acceptQualityCheckOutcome(
  outcome: unknown,
  source: { readonly checkId: string } | "cache",
  profile?: QualityProfileCandidateSession,
): AcceptedQualityCheckOutcome | undefined {
  if (source === "cache" && !isCacheableQualityCheckOutcome(outcome))
    return undefined;

  const endSnapshot = profile?.stage("snapshot");
  try {
    const stableOutcome = snapshotQualityData(outcome) as QualityCheckOutcome;
    if (source !== "cache" && !isQualityCheckOutcome(stableOutcome))
      throw new QualityCheckerContractError(
        source.checkId,
        "check",
        "的 check 返回了无效结果。",
      );
    return {
      outcome: stableOutcome,
      ...(isReusableQualityCheckOutcome(stableOutcome)
        ? { cacheableOutcome: stableOutcome }
        : {}),
    };
  } finally {
    endSnapshot?.();
  }
}

async function writeCachedQualityOutcome(
  cache: QualityCheckResultCache,
  key: string,
  outcome: CacheableQualityCheckOutcome,
  profile?: QualityProfileCandidateSession,
): Promise<void> {
  const end = profile?.stage("cacheWrite");
  try {
    await cache.set(key, outcome);
    profile?.write("completed");
  } catch {
    profile?.write("error");
    // 缓存写入失败只会增加后续检查成本。
  } finally {
    end?.();
  }
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
  exceptions: readonly QualityException[],
): QualityDiagnosticHandling {
  const exception = exceptions.find((candidate) =>
    qualityExceptionMatchesExecution(candidate, execution),
  );
  return exception === undefined
    ? { status: "active" }
    : {
        status: "excepted",
        exceptionId: exception.id,
        reason: exception.reason,
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
  if (statuses.every((status) => status === "not-applicable"))
    return "not-applicable";
  if (statuses.some((status) => status === "failed")) return "failed";
  if (statuses.some((status) => status === "incomplete")) return "incomplete";
  return "complete";
}

function candidateObject<TBody>(
  candidate: SemanticEditCandidate<TBody>,
): QualityObject {
  return {
    kind: "translation-unit",
    key: candidate.sourceKey,
    language: candidate.language,
  };
}
