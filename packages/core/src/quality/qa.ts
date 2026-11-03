import { createHash, type Hash } from "node:crypto";

import { createMemoScope, type MemoScope } from "@lioni/memo";

import type {
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
  assertJsonValue,
  snapshotJsonValue,
  snapshotJsonValuePreservingShared,
  StandardSchemaContractError,
  validateWithStandardSchema,
} from "../standard-schema.ts";
import type { StandardSchemaV1 } from "../standard-schema.ts";
import type {
  QualityProfileSession,
  QualityProfileCandidateSession,
} from "./profiler.ts";
import {
  isCacheableQualityCheckOutcome,
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

type ReadonlyQualityValue<TValue> = TValue extends readonly (infer TItem)[]
  ? readonly ReadonlyQualityValue<TItem>[]
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
  readonly snapshot: <TValue>(
    value: TValue,
    valueDescription: string,
  ) => TValue;
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
  const sharedValues = new WeakSet<object>();
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
          registerSharedQualityData(snapshot, sharedValues);
          return snapshot;
        };
        operations.set(reader, snapshotReader);
      }
      return memo.memo(snapshotReader)(...args) as Promise<TValue>;
    },
  };
  return {
    reader: qualityData,
    snapshot: <TValue>(value: TValue, valueDescription: string) =>
      snapshotQualityDataPreservingShared(
        value,
        valueDescription,
        sharedValues,
      ),
    dispose: () => memo.dispose(),
  };
}

function registerSharedQualityData(
  value: unknown,
  sharedValues: WeakSet<object>,
): void {
  if (typeof value !== "object" || value === null || sharedValues.has(value))
    return;
  sharedValues.add(value);
  if (Array.isArray(value)) {
    for (const item of value) registerSharedQualityData(item, sharedValues);
  } else {
    for (const item of Object.values(value))
      registerSharedQualityData(item, sharedValues);
  }
  Object.freeze(value);
}

function snapshotQualityDataPreservingShared<TValue>(
  value: TValue,
  valueDescription: string,
  sharedValues: WeakSet<object>,
): TValue {
  return snapshotJsonValuePreservingShared(value, valueDescription, (shared) =>
    sharedValues.has(shared),
  ) as TValue;
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

export type QualityCheckInput<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TConfiguration = unknown,
  TBody = unknown,
  TUnavailable = never,
> = Omit<QualityCheckRequest<TBody>, "candidates" | "exceptions"> & {
  readonly facts: FrameworkFacts<TUnit, TTranslation, TBody, TUnavailable>;
  readonly candidate: SemanticEditCandidate<TBody>;
  readonly sourceUnit: SourceUnitFact<TUnit> | null;
  readonly configuration: TConfiguration;
  readonly dependencies: unknown;
  /** 仅在本次执行中借用；检查器不得关闭此范围。 */
  readonly memo: MemoScope;
};

/** 可作为检查输入依据的 JSON 值；回调结果会由核心在交接前验证并摘要。 */
export type QualityInputBasis = JsonValue;

const qualityInputFingerprintFormat = "lioni.check-input/v1";

export type QualityDefaultInput = {
  readonly facts: unknown;
  readonly candidate: unknown;
  readonly sourceUnit: unknown;
  readonly dependencies: unknown;
  readonly relationships?: readonly unknown[];
};

/**
 * 构造框架默认输入依据。检查作者可以在自定义指纹回调中组合此值与宿主资料。
 */
export function createDefaultQualityInputBasis(
  input: QualityDefaultInput,
): QualityInputBasis {
  const basis = {
    facts: input.facts,
    candidate: input.candidate,
    sourceUnit: input.sourceUnit,
    dependencies: input.dependencies,
    relationships: input.relationships ?? [],
  };
  return snapshotJsonValue(basis, "QA 默认输入指纹依据");
}

export type QualityInputFingerprintSummary = {
  readonly version: string;
  readonly configurationFingerprint: string;
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

export type QualityCheckSelection<
  TSubject,
  TObject extends QualityObject = QualityObject,
> =
  | { readonly status: "not-applicable" }
  | { readonly status: "incomplete"; readonly issue: QualityIssue<TObject> }
  | { readonly status: "selected"; readonly subject: TSubject };

export type QualityCheckProjection<
  TInput,
  TObject extends QualityObject = QualityObject,
> =
  | { readonly status: "ready"; readonly value: TInput }
  | { readonly status: "incomplete"; readonly issue: QualityIssue<TObject> };

export type QualityCheckProjectionInput<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TConfiguration,
  TSubject,
  TBody = unknown,
  TUnavailable = never,
> = QualityCheckInput<
  TUnit,
  TTranslation,
  TConfiguration,
  TBody,
  TUnavailable
> & {
  readonly subject: TSubject;
};

export type QualityCheckRuleInput<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TConfiguration,
  TSubject,
  TProjected,
  TBody = unknown,
  TUnavailable = never,
> = QualityCheckInput<
  TUnit,
  TTranslation,
  TConfiguration,
  TBody,
  TUnavailable
> & {
  readonly subject: TSubject;
  readonly projected: TProjected;
};

export type QualityCheckBindingStage = "selection" | "projection";

export class QualityCheckBindingError extends TypeError {
  readonly qualityCheckId: string;
  readonly stage: QualityCheckBindingStage;

  constructor(
    qualityCheckId: string,
    stage: QualityCheckBindingStage,
    cause: unknown,
  ) {
    super(
      `QA 检查器 ${qualityCheckId} 的${stage === "selection" ? "适用范围选择" : "输入投影"}失败。`,
      { cause },
    );
    this.name = "QualityCheckBindingError";
    this.qualityCheckId = qualityCheckId;
    this.stage = stage;
  }
}

export type StandardSchemaInput<
  TSchema extends StandardSchemaV1<unknown, unknown>,
> = NonNullable<TSchema["~standard"]["types"]>["input"];

export type StandardSchemaOutput<
  TSchema extends StandardSchemaV1<unknown, unknown>,
> = NonNullable<TSchema["~standard"]["types"]>["output"];

type QualityCheckExecutionInput<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody = unknown,
  TUnavailable = never,
> = Omit<
  QualityCheckInput<TUnit, TTranslation, unknown, TBody, TUnavailable>,
  "configuration"
>;

type PreparedQualityCheck<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TObject extends QualityObject,
  TBody = unknown,
  TUnavailable = never,
> = {
  readonly configuration: unknown;
  readonly version: string;
  readonly prepareInput: (
    input: QualityCheckExecutionInput<TUnit, TTranslation, TBody, TUnavailable>,
    context: QualityInputPreparationContext,
  ) => Awaitable<QualityCheckExecutionPreparation<TObject>>;
};

type QualityInputPreparationContext = {
  readonly candidateIndex: number;
  readonly sourceKey: string;
  readonly language: string;
  readonly configurationFingerprint: string;
  readonly validateDefaultInputComponents: () => void;
  readonly getDefaultInputComponents: () => DefaultQualityInputFingerprintComponents;
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

type DefaultQualityInputFingerprintComponents = {
  readonly facts: string;
  readonly dependencies: string;
  readonly relationships: string;
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
    input: QualityCheckInput<TUnit, TTranslation, unknown, TBody, TUnavailable>,
  ) => QualityCheckOutcome<TObject>;
  readonly id: TId;
  readonly version: string;
};

/** 将执行状态与公开检查器对象分离，避免暴露内部准备和执行协议。 */
const qualityCheckPreparers = new WeakMap<object, QualityCheckPreparer>();
const qualityCheckDependencyLoaders = new WeakMap<object, unknown>();

export type QualityCheckBinding<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TConfigurationSchema extends StandardSchemaV1<unknown, unknown>,
  TInputSchema extends StandardSchemaV1<unknown, unknown>,
  TSubject,
  TObject extends QualityObject = QualityObject,
  TBody = unknown,
  TUnavailable = never,
  TId extends string = string,
> = {
  readonly id: TId;
  readonly version: string;
  readonly configurationSchema: TConfigurationSchema;
  readonly configuration: StandardSchemaInput<TConfigurationSchema>;
  /** 只在本项已选且存在候选时加载；可经 qualityData.read 与其他消费者显式共享。 */
  readonly loadDependencies?: (
    input: QualityDataLoadInput<TUnit, TTranslation, TBody, TUnavailable>,
  ) => Awaitable<unknown>;
  /** 同步返回完整依据；核心在回调返回后立即验证、摘要，不保留依据副本。只读使用共享输入。 */
  readonly fingerprintInput?: (
    input: QualityCheckRuleInput<
      TUnit,
      TTranslation,
      StandardSchemaOutput<TConfigurationSchema>,
      TSubject,
      StandardSchemaOutput<TInputSchema>,
      TBody,
      TUnavailable
    >,
  ) => QualityInputBasis;
  readonly inputSchema: TInputSchema;
  readonly select: (
    input: QualityCheckInput<
      TUnit,
      TTranslation,
      StandardSchemaOutput<TConfigurationSchema>,
      TBody,
      TUnavailable
    >,
  ) => Awaitable<QualityCheckSelection<TSubject, TObject>>;
  readonly project: (
    input: QualityCheckProjectionInput<
      TUnit,
      TTranslation,
      StandardSchemaOutput<TConfigurationSchema>,
      TSubject,
      TBody,
      TUnavailable
    >,
  ) => Awaitable<
    QualityCheckProjection<StandardSchemaInput<TInputSchema>, TObject>
  >;
  readonly check: (
    input: QualityCheckRuleInput<
      TUnit,
      TTranslation,
      StandardSchemaOutput<TConfigurationSchema>,
      TSubject,
      StandardSchemaOutput<TInputSchema>,
      TBody,
      TUnavailable
    >,
  ) => Awaitable<QualityCheckOutcome<TObject>>;
};

/** 单次检查项声明的输入类型。 */
type QualityCheckDefinitionInput<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TSchema extends StandardSchemaV1<unknown, unknown>,
  TObject extends QualityObject,
  TBody,
  TUnavailable,
  TId extends string,
> = {
  readonly id: TId;
  readonly version: string;
  readonly configurationSchema: TSchema;
  readonly configuration: StandardSchemaInput<TSchema>;
  /** 只在本项已选且存在候选时加载；可经 qualityData.read 与其他消费者显式共享。 */
  readonly loadDependencies?: (
    input: QualityDataLoadInput<TUnit, TTranslation, TBody, TUnavailable>,
  ) => Awaitable<unknown>;
  /** 同步返回完整依据；核心在回调返回后立即验证、摘要，不保留依据副本。只读使用共享输入。 */
  readonly fingerprintInput?: (
    input: QualityCheckInput<
      TUnit,
      TTranslation,
      StandardSchemaOutput<TSchema>,
      TBody,
      TUnavailable
    >,
  ) => QualityInputBasis;
  readonly check: (
    input: QualityCheckInput<
      TUnit,
      TTranslation,
      StandardSchemaOutput<TSchema>,
      TBody,
      TUnavailable
    >,
  ) => Awaitable<QualityCheckOutcome<TObject>>;
};

function defineQualityCheckImplementation<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TSchema extends StandardSchemaV1<unknown, unknown>,
  TObject extends QualityObject = QualityObject,
  TBody = unknown,
  TUnavailable = never,
  TId extends string = string,
>(
  definition: QualityCheckDefinitionInput<
    TUnit,
    TTranslation,
    TSchema,
    TObject,
    TBody,
    TUnavailable,
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
  const {
    id,
    version,
    configuration,
    configurationSchema,
    loadDependencies,
    fingerprintInput,
    check,
  } = definition;
  assertQualityCheckIdentity(id, version);
  assertQualityDataLoader(loadDependencies, id);
  const qualityCheck = {
    [qualityCheckDefinitionBrand]: true,
    id,
    version,
  } as const;
  qualityCheckPreparers.set(qualityCheck, async () => {
    const configurationDescription = `QA 检查器 ${id} 的配置`;
    const parsedConfiguration = await validateWithStandardSchema(
      configurationSchema,
      configuration,
      configurationDescription,
    );
    assertJsonValue(parsedConfiguration, `QA 检查器 ${id} 的最终配置`);
    return {
      configuration: parsedConfiguration,
      version,
      prepareInput: (
        input: QualityCheckExecutionInput<
          TUnit,
          TTranslation,
          TBody,
          TUnavailable
        >,
        context: QualityInputPreparationContext,
      ) => {
        const checkInput = {
          ...input,
          configuration: parsedConfiguration,
        };
        const preparedFingerprint = prepareQualityInput(
          id,
          version,
          fingerprintInput,
          checkInput,
          context,
        );
        return {
          status: "ready",
          ...preparedFingerprint,
          execute: () => check(checkInput),
        };
      },
    };
  });
  if (loadDependencies !== undefined)
    qualityCheckDependencyLoaders.set(qualityCheck, loadDependencies);
  return qualityCheck as unknown as QualityCheckDefinition<
    TUnit,
    TTranslation,
    TObject,
    TBody,
    TUnavailable,
    TId
  >;
}

/**
 * 声明质量检查项；正式运行会校验配置并调用检查函数，返回值只表达检查项身份。
 * version 应覆盖算法及宿主选择、投影和策略的语义变化。默认指纹包含完整事实、
 * 当前候选、原文、动态依赖及关联关系；fingerprintInput 替换业务依据，检查身份、
 * 版本和最终配置仍始终参与。闭包依赖须由作者显式纳入依据。若需要显式业务泛型，
 * 用 withTypes 先绑定业务类型，再由单次声明推断检查项 ID 字面量。传入普通 string ID
 * 时返回类型为 string，后续配置不能静态枚举该 ID，实际选择依赖运行时目录校验。
 */
export const defineQualityCheck = Object.assign(
  defineQualityCheckImplementation,
  {
    withTypes<
      TUnit extends TranslationUnitInput,
      TTranslation,
      TSchema extends StandardSchemaV1<unknown, unknown>,
      TObject extends QualityObject = QualityObject,
      TBody = unknown,
      TUnavailable = never,
    >() {
      return <const TId extends string>(
        definition: QualityCheckDefinitionInput<
          TUnit,
          TTranslation,
          TSchema,
          TObject,
          TBody,
          TUnavailable,
          TId
        >,
      ) =>
        defineQualityCheckImplementation<
          TUnit,
          TTranslation,
          TSchema,
          TObject,
          TBody,
          TUnavailable,
          TId
        >(definition);
    },
  },
);

/**
 * 将选择、投影和检查绑定为共同检查器契约。
 * 配置与验证器仅供执行准备使用，返回对象不暴露具体 schema 或配置内部成员。
 */
export function bindQualityCheck<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TConfigurationSchema extends StandardSchemaV1<unknown, unknown>,
  TInputSchema extends StandardSchemaV1<unknown, unknown>,
  TSubject,
  TObject extends QualityObject = QualityObject,
  TBody = unknown,
  TUnavailable = never,
  TId extends string = string,
>(
  definition: QualityCheckBinding<
    TUnit,
    TTranslation,
    TConfigurationSchema,
    TInputSchema,
    TSubject,
    TObject,
    TBody,
    TUnavailable,
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
  const {
    id,
    version,
    configuration,
    configurationSchema,
    loadDependencies,
    inputSchema,
    fingerprintInput,
    select,
    project,
    check,
  } = definition;
  assertQualityCheckIdentity(id, version);
  assertQualityDataLoader(loadDependencies, id);
  const qualityCheck = {
    [qualityCheckDefinitionBrand]: true,
    id,
    version,
  } as const;
  qualityCheckPreparers.set(qualityCheck, async () => {
    const configurationDescription = `QA 检查器 ${id} 的配置`;
    const parsedConfiguration = await validateWithStandardSchema(
      configurationSchema,
      configuration,
      configurationDescription,
    );
    assertJsonValue(parsedConfiguration, `QA 检查器 ${id} 的最终配置`);
    return {
      configuration: parsedConfiguration,
      version,
      prepareInput: async (
        input: QualityCheckExecutionInput<
          TUnit,
          TTranslation,
          TBody,
          TUnavailable
        >,
        context: QualityInputPreparationContext,
      ) => {
        const boundInput = { ...input, configuration: parsedConfiguration };
        let selection: QualityCheckSelection<TSubject, TObject>;
        try {
          selection = await select(boundInput);
        } catch (error) {
          throw new QualityCheckBindingError(id, "selection", error);
        }
        if (!isQualityCheckSelection(selection))
          throw new QualityCheckBindingError(
            id,
            "selection",
            new TypeError("适用范围选择返回了无效结果。"),
          );
        if (selection.status === "not-applicable")
          return {
            status: "not-applicable",
            outcome: bindingOutcome<TObject>("not-applicable"),
          };
        if (selection.status === "incomplete")
          return {
            status: "incomplete",
            outcome: bindingOutcome<TObject>("incomplete", selection.issue),
          };

        const projectionInput = {
          ...boundInput,
          subject: selection.subject,
        };
        let projection: QualityCheckProjection<
          StandardSchemaInput<TInputSchema>,
          TObject
        >;
        try {
          projection = await project(projectionInput);
        } catch (error) {
          throw new QualityCheckBindingError(id, "projection", error);
        }
        if (!isQualityCheckProjection(projection))
          throw new QualityCheckBindingError(
            id,
            "projection",
            new TypeError("检查输入投影返回了无效结果。"),
          );
        if (projection.status === "incomplete")
          return {
            status: "incomplete",
            outcome: bindingOutcome<TObject>("incomplete", projection.issue),
          };

        const projectedInput = await validateWithStandardSchema(
          inputSchema,
          projection.value,
          `QA 检查器 ${id} 的投影输入`,
        );
        const checkInput = {
          ...boundInput,
          subject: selection.subject,
          projected: projectedInput,
        };
        const preparedFingerprint = prepareQualityInput(
          id,
          version,
          fingerprintInput,
          checkInput,
          context,
        );
        return {
          status: "ready",
          ...preparedFingerprint,
          execute: () => check(checkInput),
        };
      },
    };
  });
  if (loadDependencies !== undefined)
    qualityCheckDependencyLoaders.set(qualityCheck, loadDependencies);
  return qualityCheck as unknown as QualityCheckDefinition<
    TUnit,
    TTranslation,
    TObject,
    TBody,
    TUnavailable,
    TId
  >;
}

function bindingOutcome<TObject extends QualityObject>(
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

function isQualityCheckSelection(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.status === "not-applicable") return true;
  if (value.status === "selected") return Object.hasOwn(value, "subject");
  return value.status === "incomplete" && isQualityIssue(value.issue);
}

function isQualityCheckProjection(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.status === "ready") return Object.hasOwn(value, "value");
  return value.status === "incomplete" && isQualityIssue(value.issue);
}

function isQualityIssue(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.code === "string" &&
    typeof value.message === "string"
  );
}

function assertQualityCheckIdentity(id: string, version: string): void {
  if (id.trim() === "") throw new TypeError("QA 检查项必须提供非空 id。");
  if (version.trim() === "")
    throw new TypeError(`QA 检查项 ${id} 必须提供非空 version。`);
}

function assertQualityDataLoader(loader: unknown, id: string): void {
  if (loader !== undefined && typeof loader !== "function")
    throw new TypeError(`QA 检查项 ${id} 的 loadDependencies 必须是函数。`);
}

function prepareQualityInput<TInput extends QualityDefaultInput>(
  id: string,
  version: string,
  fingerprintInput: ((input: TInput) => unknown) | undefined,
  input: TInput,
  context: QualityInputPreparationContext,
): {
  readonly fingerprint: Required<QualityInputFingerprint>;
  readonly cacheKey: string;
} {
  function prepareFingerprint(inputBasisFingerprint: string) {
    const fingerprint = qualityInputFingerprint(
      id,
      version,
      context.configurationFingerprint,
      inputBasisFingerprint,
    );
    return {
      fingerprint,
      cacheKey: qualityCheckCacheKey(
        id,
        context.candidateIndex,
        context.sourceKey,
        context.language,
        fingerprint.inputFingerprint,
      ),
    };
  }

  if (fingerprintInput === undefined) {
    assertJsonValue(input.candidate, `QA 检查器 ${id} 的候选依据`);
    assertJsonValue(input.sourceUnit, `QA 检查器 ${id} 的原文依据`);
    context.validateDefaultInputComponents();
    context.startFingerprint();
    try {
      const defaultComponents = context.getDefaultInputComponents();
      const inputBasisFingerprint = fingerprintJsonObjectComponents([
        ["candidate", fingerprintJsonValue(input.candidate as JsonValue)],
        ["dependencies", defaultComponents.dependencies],
        ["facts", defaultComponents.facts],
        ["relationships", defaultComponents.relationships],
        ["sourceUnit", fingerprintJsonValue(input.sourceUnit as JsonValue)],
      ]);
      return prepareFingerprint(inputBasisFingerprint);
    } finally {
      context.endFingerprint();
    }
  }

  const basis = fingerprintInput(input);
  assertJsonValue(basis, `QA 检查器 ${id} 的输入指纹依据`);
  context.startFingerprint();
  try {
    return prepareFingerprint(fingerprintQualityInputBasis(basis));
  } finally {
    context.endFingerprint();
  }
}

export type QualityCheckResult<TObject extends QualityObject = QualityObject> =
  {
    readonly checkId: string;
    readonly version: string;
    readonly configuration: unknown;
    /** 仅记录本检查项成功加载并固定的资料。 */
    readonly dependencies?: unknown;
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
      readonly dependencies: unknown;
      readonly dependencyFailure?: { readonly error: unknown };
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
          `QA 检查项 ${definition.id} 必须由 defineQualityCheck 或 bindQualityCheck 创建。`,
        );
      const endPreparation = options.profile?.checkStage(
        definition.id,
        "configurationPreparation",
      );
      let prepared: PreparedQualityCheck<
        TUnit,
        TTranslation,
        QualityObject,
        TBody,
        TUnavailable
      >;
      try {
        prepared = (await prepare()) as PreparedQualityCheck<
          TUnit,
          TTranslation,
          QualityObject,
          TBody,
          TUnavailable
        >;
      } finally {
        endPreparation?.();
      }

      let dependencies: unknown = {};
      let dependencyFailure: { readonly error: unknown } | undefined;
      const loadDependencies = qualityCheckDependencyLoaders.get(definition) as
        | ((
            input: QualityDataLoadInput<
              TUnit,
              TTranslation,
              TBody,
              TUnavailable
            >,
          ) => Awaitable<unknown>)
        | undefined;
      if (
        boundRequest.candidates.length > 0 &&
        loadDependencies !== undefined
      ) {
        const endDependencies = options.profile?.checkStage(
          definition.id,
          "dependencies",
        );
        try {
          dependencies = qualityData.snapshot(
            await loadDependencies({
              facts,
              memo,
              qualityData: qualityData.reader,
            }),
            `QA 检查项 ${definition.id} 的检查资料`,
          );
        } catch (error) {
          if (
            error instanceof StandardSchemaContractError ||
            error instanceof QualityCheckBindingError ||
            error instanceof QualityDataReaderContractError
          )
            throw error;
          dependencyFailure = { error };
        } finally {
          endDependencies?.();
        }
      }
      preparedChecks.push({
        id: definition.id,
        prepared,
        dependencies,
        ...(dependencyFailure === undefined ? {} : { dependencyFailure }),
      });
    }

    const results: QualityCheckResult[] = [];
    const sourceUnits = new Map(
      facts.source.units.map((unit) => [unit.key, unit]),
    );
    let commonInputComponents:
      | Pick<
          DefaultQualityInputFingerprintComponents,
          "facts" | "relationships"
        >
      | undefined;
    const getCommonInputComponents = () => {
      if (commonInputComponents === undefined)
        commonInputComponents = {
          facts: fingerprintJsonValue(facts as JsonValue),
          relationships: fingerprintJsonValue(
            boundRequest.relationships as JsonValue,
          ),
        };
      return commonInputComponents;
    };
    const selectedLanguages = new Map<string, Set<string>>();
    for (const { sourceKey, language } of boundRequest.candidates) {
      const languages = selectedLanguages.get(sourceKey) ?? new Set<string>();
      languages.add(language);
      selectedLanguages.set(sourceKey, languages);
    }
    let nextExecutionId = 0;
    for (const {
      id,
      prepared,
      dependencies,
      dependencyFailure,
    } of preparedChecks) {
      let defaultInputComponentsValidated = false;
      let defaultInputComponents:
        | DefaultQualityInputFingerprintComponents
        | undefined;
      const validateDefaultInputComponents = () => {
        if (defaultInputComponentsValidated) return;
        assertJsonValue(
          { facts, dependencies, relationships: boundRequest.relationships },
          "QA 默认输入指纹依据",
        );
        defaultInputComponentsValidated = true;
      };
      const getDefaultInputComponents =
        (): DefaultQualityInputFingerprintComponents => {
          if (defaultInputComponents === undefined)
            defaultInputComponents = {
              ...getCommonInputComponents(),
              dependencies: fingerprintJsonValue(dependencies as JsonValue),
            };
          return defaultInputComponents;
        };
      const endConfiguration = options.profile?.checkStage(
        id,
        "configurationFingerprint",
      );
      const configuration = snapshotQualityData(prepared.configuration);
      const configurationFingerprint = fingerprintQualityInputBasis(
        configuration as JsonValue,
      );
      endConfiguration?.();
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
          if (dependencyFailure !== undefined) throw dependencyFailure.error;
          const sourceUnit = sourceUnits.get(candidate.sourceKey) ?? null;
          const endPreparation = candidateProfile?.stage("prepareInput");
          let endFingerprintStage: (() => void) | undefined;
          const preparationContext: QualityInputPreparationContext = {
            candidateIndex,
            sourceKey: candidate.sourceKey,
            language: candidate.language,
            configurationFingerprint,
            validateDefaultInputComponents,
            getDefaultInputComponents,
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
                facts,
                candidate,
                sourceUnit,
                memo,
                dependencies,
                relationships: boundRequest.relationships,
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
                  if (
                    error instanceof StandardSchemaContractError ||
                    error instanceof QualityCheckBindingError ||
                    error instanceof QualityDataReaderContractError
                  )
                    throw error;
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
          if (
            error instanceof StandardSchemaContractError ||
            error instanceof QualityCheckBindingError ||
            error instanceof QualityDataReaderContractError
          )
            throw error;
          outcomeResolution = {
            outcome: failedQualityCheckOutcome(candidate, error),
          };
        }

        const accepted = await resolveQualityCheckOutcome(
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
        configuration,
        ...(dependencyFailure === undefined ? { dependencies } : {}),
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
  configurationFingerprint: string,
  inputBasisFingerprint: string,
): Required<QualityInputFingerprint> {
  const summaryVersion = `${qualityInputFingerprintFormat}:${version}`;
  return {
    inputFingerprint: fingerprintJsonObjectComponents([
      ["checkId", fingerprintJsonValue(checkId)],
      ["configurationFingerprint", configurationFingerprint],
      [
        "fingerprintFormat",
        fingerprintJsonValue(qualityInputFingerprintFormat),
      ],
      ["inputFingerprint", inputBasisFingerprint],
      ["version", fingerprintJsonValue(version)],
    ]),
    fingerprintSummary: {
      version: summaryVersion,
      configurationFingerprint,
      inputFingerprint: inputBasisFingerprint,
    },
  };
}

function qualityCheckCacheKey(
  checkId: string,
  candidateIndex: number,
  sourceKey: string,
  language: string,
  inputFingerprint: string,
): string {
  return fingerprintJsonValue({
    checkId,
    candidateIndex,
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
  resolution: QualityCheckOutcomeResolution,
  profile?: QualityProfileCandidateSession,
): Promise<AcceptedQualityCheckOutcome> {
  if ("outcome" in resolution)
    return acceptQualityCheckOutcome(resolution.outcome, "check", profile);

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

  const accepted = acceptQualityCheckOutcome(outcome, "check", profile);
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
  source: "check",
  profile?: QualityProfileCandidateSession,
): AcceptedQualityCheckOutcome;
function acceptQualityCheckOutcome(
  outcome: unknown,
  source: "cache",
  profile?: QualityProfileCandidateSession,
): AcceptedQualityCheckOutcome | undefined;
function acceptQualityCheckOutcome(
  outcome: unknown,
  source: "check" | "cache",
  profile?: QualityProfileCandidateSession,
): AcceptedQualityCheckOutcome | undefined {
  if (source === "cache" && !isCacheableQualityCheckOutcome(outcome))
    return undefined;

  const endSnapshot = profile?.stage("snapshot");
  try {
    const stableOutcome = snapshotQualityData(outcome) as QualityCheckOutcome;
    const isCacheable =
      source === "cache" || isCacheableQualityCheckOutcome(stableOutcome);
    return {
      outcome: stableOutcome,
      ...(isCacheable
        ? {
            cacheableOutcome: stableOutcome as CacheableQualityCheckOutcome,
          }
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
