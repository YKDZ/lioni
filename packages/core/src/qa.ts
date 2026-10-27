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
} from "./index.ts";
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
import type { JsonValue, SemanticEditCandidate } from "./semantic-edits.ts";
import { stableStringifyJson } from "./stable-json.ts";
import {
  assertJsonValue,
  StandardSchemaContractError,
  validateWithStandardSchema,
} from "./standard-schema.ts";
import type { StandardSchemaV1 } from "./standard-schema.ts";

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

export type QualityDiagnostic<TObject extends QualityObject = QualityObject> = {
  readonly checkId: string;
  readonly executionId: number;
  readonly severity: "error" | "warning" | "info";
  readonly object: TObject;
  readonly location: QualityLocation;
  readonly message: string;
  readonly evidence: readonly QualityEvidence<TObject>[];
  readonly handling: QualityDiagnosticHandling;
};

export type QualityFinding<TObject extends QualityObject = QualityObject> =
  Omit<QualityDiagnostic<TObject>, "checkId" | "executionId" | "handling">;

export type QualityIssue<TObject extends QualityObject = QualityObject> = {
  readonly code: string;
  readonly message: string;
  readonly object?: TObject;
  readonly location?: QualityLocation;
  readonly evidence?: readonly QualityEvidence<TObject>[];
};

export type QualityCoverage = {
  readonly selected: number;
  readonly evaluated: number;
  readonly notApplicable: number;
  readonly incomplete: number;
  readonly failed: number;
};

type MutableQualityCoverage = {
  -readonly [TKey in keyof QualityCoverage]: QualityCoverage[TKey];
};

export type QualityCheckOutcome<TObject extends QualityObject = QualityObject> =
  {
    readonly status: Exclude<QualityCheckStatus, "not-run">;
    readonly diagnostics: readonly QualityFinding<TObject>[];
    readonly issues: readonly QualityIssue<TObject>[];
    readonly coverage: QualityCoverage;
  };

export type QualityCheckRequest<TBody = JsonValue> = {
  readonly candidates: readonly SemanticEditCandidate<TBody>[];
  readonly dependencies: unknown;
  readonly relationships?: readonly QualityRelationship[];
  readonly exceptions?: readonly QualityException[];
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
  /** 仅在本次执行中借用；检查器不得关闭此范围。 */
  readonly memo: MemoScope;
};

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
  assertJsonValue(basis, "QA 默认输入指纹依据");
  return structuredClone(basis) as JsonValue;
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
  ) => Awaitable<QualityCheckExecutionPreparation<TObject>>;
};

type QualityCheckExecutionPreparation<TObject extends QualityObject> =
  | {
      readonly status: "not-applicable" | "incomplete";
      readonly outcome: QualityCheckOutcome<TObject>;
    }
  | {
      readonly status: "ready";
      readonly fingerprintInput: PreparedQualityInputFingerprintBasis;
      readonly execute: () => Awaitable<QualityCheckOutcome<TObject>>;
    };

type PreparedQualityInputFingerprintBasis =
  | {
      readonly kind: "default";
      readonly candidateFingerprint: string;
      readonly sourceUnitFingerprint: string;
    }
  | { readonly kind: "custom"; readonly value: QualityInputBasis };

type DefaultQualityInputFingerprintComponents = {
  readonly facts: string;
  readonly dependencies: string;
  readonly relationships: string;
};

const qualityCheckDefinitionBrand: unique symbol = Symbol(
  "qualityCheckDefinition",
);

export type QualityCheckDefinition<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TObject extends QualityObject = QualityObject,
  TBody = unknown,
  TUnavailable = never,
> = {
  readonly [qualityCheckDefinitionBrand]: true;
  readonly id: string;
  readonly version: string;
  readonly prepare: () => Promise<
    PreparedQualityCheck<TUnit, TTranslation, TObject, TBody, TUnavailable>
  >;
};

export type QualityCheckBinding<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TConfigurationSchema extends StandardSchemaV1<unknown, unknown>,
  TInputSchema extends StandardSchemaV1<unknown, unknown>,
  TSubject,
  TObject extends QualityObject = QualityObject,
  TBody = unknown,
  TUnavailable = never,
> = {
  readonly id: string;
  readonly version: string;
  readonly configurationSchema: TConfigurationSchema;
  readonly configuration: StandardSchemaInput<TConfigurationSchema>;
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

export function defineQualityCheck<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TSchema extends StandardSchemaV1<unknown, unknown>,
  TObject extends QualityObject = QualityObject,
  TBody = unknown,
  TUnavailable = never,
>(definition: {
  readonly id: string;
  readonly version: string;
  readonly configurationSchema: TSchema;
  readonly configuration: StandardSchemaInput<TSchema>;
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
}): QualityCheckDefinition<
  TUnit,
  TTranslation,
  TObject,
  TBody,
  TUnavailable
> & {
  readonly version: string;
  readonly configuration: StandardSchemaInput<TSchema>;
  readonly configurationSchema: TSchema;
  readonly check: (
    input: QualityCheckInput<
      TUnit,
      TTranslation,
      StandardSchemaOutput<TSchema>,
      TBody,
      TUnavailable
    >,
  ) => Awaitable<QualityCheckOutcome<TObject>>;
} {
  const {
    id,
    version,
    configuration,
    configurationSchema,
    fingerprintInput,
    check,
  } = definition;
  assertQualityCheckIdentity(id, version);
  return {
    [qualityCheckDefinitionBrand]: true,
    id,
    version,
    configuration,
    configurationSchema,
    check,
    prepare: async () => {
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
        prepareInput: (input) => {
          const checkInput = {
            ...input,
            configuration: parsedConfiguration,
          };
          return {
            status: "ready",
            fingerprintInput: prepareFingerprintInput(
              id,
              fingerprintInput,
              checkInput,
            ),
            execute: () => check(checkInput),
          };
        },
      };
    },
  };
}

export function bindQualityCheck<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TConfigurationSchema extends StandardSchemaV1<unknown, unknown>,
  TInputSchema extends StandardSchemaV1<unknown, unknown>,
  TSubject,
  TObject extends QualityObject = QualityObject,
  TBody = unknown,
  TUnavailable = never,
>(
  definition: QualityCheckBinding<
    TUnit,
    TTranslation,
    TConfigurationSchema,
    TInputSchema,
    TSubject,
    TObject,
    TBody,
    TUnavailable
  >,
): QualityCheckDefinition<TUnit, TTranslation, TObject, TBody, TUnavailable> & {
  readonly configuration: StandardSchemaInput<TConfigurationSchema>;
  readonly configurationSchema: TConfigurationSchema;
  readonly inputSchema: TInputSchema;
} {
  const {
    id,
    version,
    configuration,
    configurationSchema,
    inputSchema,
    fingerprintInput,
    select,
    project,
    check,
  } = definition;
  assertQualityCheckIdentity(id, version);
  return {
    [qualityCheckDefinitionBrand]: true,
    id,
    version,
    configuration,
    configurationSchema,
    inputSchema,
    prepare: async () => {
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
        prepareInput: async (input) => {
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
          return {
            status: "ready",
            fingerprintInput: prepareFingerprintInput(
              id,
              fingerprintInput,
              checkInput,
            ),
            execute: () => check(checkInput),
          };
        },
      };
    },
  };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertQualityCheckIdentity(id: string, version: string): void {
  if (id.trim() === "") throw new TypeError("QA 检查项必须提供非空 id。");
  if (version.trim() === "")
    throw new TypeError(`QA 检查项 ${id} 必须提供非空 version。`);
}

function prepareFingerprintInput<TInput extends QualityDefaultInput>(
  id: string,
  fingerprintInput: ((input: TInput) => QualityInputBasis) | undefined,
  input: TInput,
): PreparedQualityInputFingerprintBasis {
  if (fingerprintInput === undefined) {
    assertJsonValue(input.candidate, `QA 检查器 ${id} 的候选依据`);
    assertJsonValue(input.sourceUnit, `QA 检查器 ${id} 的原文依据`);
    return {
      kind: "default",
      candidateFingerprint: fingerprintJsonValue(input.candidate as JsonValue),
      sourceUnitFingerprint: fingerprintJsonValue(
        input.sourceUnit as JsonValue,
      ),
    };
  }

  const basis = fingerprintInput(input);
  assertJsonValue(basis, `QA 检查器 ${id} 的输入指纹依据`);
  return { kind: "custom", value: structuredClone(basis) };
}

export type QualityCheckResult<TObject extends QualityObject = QualityObject> =
  {
    readonly checkId: string;
    readonly version: string;
    readonly configuration: unknown;
    readonly status: QualityCheckStatus;
    readonly diagnostics: readonly QualityDiagnostic<TObject>[];
    readonly issues: readonly QualityIssue<TObject>[];
    readonly coverage: QualityCoverage;
    readonly executions: readonly QualityCheckExecution[];
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
  readonly dependencies: unknown;
  readonly relationships: readonly QualityRelationship[];
  readonly exceptions: readonly QualityException[];
  readonly exceptionApplicability: readonly QualityExceptionApplicability[];
  readonly status: QualityCheckStatus;
  readonly diagnostics: readonly QualityDiagnostic<TObject>[];
  readonly checks: readonly QualityCheckResult<TObject>[];
};

export type QualityExecutionOptions = {
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
  const memo = options.memo ?? createMemoScope();
  try {
    const boundRequest = snapshotQualityData({
      candidates: request.candidates,
      dependencies: request.dependencies,
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
    }[] = [];
    const checkIds = new Set<string>();
    for (const definition of checks) {
      if (checkIds.has(definition.id))
        throw new TypeError(`QA 检查项 id ${definition.id} 重复。`);
      checkIds.add(definition.id);
      preparedChecks.push({
        id: definition.id,
        prepared: await definition.prepare(),
      });
    }

    const results: QualityCheckResult[] = [];
    const sourceUnits = new Map(
      facts.source.units.map((unit) => [unit.key, unit]),
    );
    let defaultInputComponents:
      | DefaultQualityInputFingerprintComponents
      | undefined;
    const getDefaultInputComponents =
      (): DefaultQualityInputFingerprintComponents => {
        if (defaultInputComponents === undefined) {
          const fixedBasis = {
            facts,
            dependencies: boundRequest.dependencies,
            relationships: boundRequest.relationships,
          };
          assertJsonValue(fixedBasis, "QA 默认输入指纹依据");
          defaultInputComponents = {
            facts: fingerprintJsonValue(facts as JsonValue),
            dependencies: fingerprintJsonValue(
              boundRequest.dependencies as JsonValue,
            ),
            relationships: fingerprintJsonValue(
              boundRequest.relationships as JsonValue,
            ),
          };
        }
        return defaultInputComponents;
      };
    const selectedLanguages = new Map<string, Set<string>>();
    for (const { sourceKey, language } of boundRequest.candidates) {
      const languages = selectedLanguages.get(sourceKey) ?? new Set<string>();
      languages.add(language);
      selectedLanguages.set(sourceKey, languages);
    }
    let nextExecutionId = 0;
    for (const { id, prepared } of preparedChecks) {
      const configuration = snapshotQualityData(prepared.configuration);
      const configurationFingerprint = fingerprintQualityInputBasis(
        configuration as JsonValue,
      );
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
        const executionId = nextExecutionId;
        nextExecutionId += 1;
        let fingerprint: QualityInputFingerprint | undefined;
        let cacheKey: string | undefined;
        let shouldCacheOutcome = false;
        let outcome: QualityCheckOutcome;
        try {
          const sourceUnit = sourceUnits.get(candidate.sourceKey) ?? null;
          const preparation = await prepared.prepareInput({
            facts,
            candidate,
            sourceUnit,
            memo,
            dependencies: boundRequest.dependencies,
            relationships: boundRequest.relationships,
          });
          if (preparation.status === "ready") {
            const currentFingerprint = qualityInputFingerprint(
              id,
              prepared.version,
              configurationFingerprint,
              preparation.fingerprintInput,
              preparation.fingerprintInput.kind === "default"
                ? getDefaultInputComponents()
                : undefined,
            );
            fingerprint = currentFingerprint;
            const key = qualityCheckCacheKey(
              id,
              candidateIndex,
              candidate.sourceKey,
              candidate.language,
              currentFingerprint.inputFingerprint,
            );
            cacheKey = key;
            const cachedOutcome =
              options.qualityCheckResultCache === undefined
                ? undefined
                : await readCachedQualityOutcome(
                    options.qualityCheckResultCache,
                    key,
                  );
            if (cachedOutcome === undefined) {
              outcome = await preparation.execute();
              shouldCacheOutcome = true;
            } else outcome = cachedOutcome;
          } else {
            outcome = preparation.outcome;
          }
        } catch (error) {
          if (
            error instanceof StandardSchemaContractError ||
            error instanceof QualityCheckBindingError
          )
            throw error;
          outcome = {
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

        const stableOutcome = snapshotQualityData(outcome);
        if (
          shouldCacheOutcome &&
          cacheKey !== undefined &&
          options.qualityCheckResultCache !== undefined &&
          isCacheableQualityCheckOutcome(stableOutcome)
        )
          await writeCachedQualityOutcome(
            options.qualityCheckResultCache,
            cacheKey,
            stableOutcome,
          );
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
      }

      results.push({
        checkId: id,
        version: prepared.version,
        configuration,
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

function snapshotQualityData<TValue>(value: TValue): TValue {
  assertJsonValue(value, "QA 输入与结果");
  return structuredClone(value);
}

function qualityInputFingerprint(
  checkId: string,
  version: string,
  configurationFingerprint: string,
  inputBasis: PreparedQualityInputFingerprintBasis,
  defaultComponents?: DefaultQualityInputFingerprintComponents,
): Required<QualityInputFingerprint> {
  const inputBasisFingerprint =
    inputBasis.kind === "default"
      ? fingerprintJsonObjectComponents([
          ["candidate", inputBasis.candidateFingerprint],
          [
            "dependencies",
            requiredDefaultComponent(defaultComponents, "dependencies"),
          ],
          ["facts", requiredDefaultComponent(defaultComponents, "facts")],
          [
            "relationships",
            requiredDefaultComponent(defaultComponents, "relationships"),
          ],
          ["sourceUnit", inputBasis.sourceUnitFingerprint],
        ])
      : fingerprintQualityInputBasis(inputBasis.value);
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
): Promise<QualityCheckOutcome | undefined> {
  try {
    const outcome = await cache.get(key);
    if (!isCacheableQualityCheckOutcome(outcome)) return undefined;
    return snapshotQualityData(outcome);
  } catch {
    return undefined;
  }
}

async function writeCachedQualityOutcome(
  cache: QualityCheckResultCache,
  key: string,
  outcome: CacheableQualityCheckOutcome,
): Promise<void> {
  try {
    await cache.set(key, outcome);
  } catch {
    // 缓存写入失败只会增加后续检查成本。
  }
}

function requiredDefaultComponent(
  components: DefaultQualityInputFingerprintComponents | undefined,
  key: keyof DefaultQualityInputFingerprintComponents,
): string {
  if (components === undefined)
    throw new TypeError("默认 QA 输入指纹缺少固定组件摘要。");
  return components[key];
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
