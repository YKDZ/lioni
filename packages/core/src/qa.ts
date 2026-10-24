import { isDeepStrictEqual } from "node:util";

import type {
  Awaitable,
  FrameworkFacts,
  SourceReadFact,
  SourceUnitFact,
  TranslationAssociationFact,
  TranslationReadFact,
  TranslationUnitInput,
} from "./index.ts";
import type { SemanticEditCandidate } from "./semantic-edits.ts";
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

export type QualityExceptionObjectScope = Pick<
  QualityObject,
  "kind" | "key"
> & {
  readonly language?: string;
};

export type QualityExceptionLocationScope = Pick<
  QualityLocation,
  "language" | "range"
> & {
  readonly key?: string;
};

export type QualityExceptionScope =
  | {
      readonly object: QualityExceptionObjectScope;
      readonly location?: QualityExceptionLocationScope;
    }
  | {
      readonly location: QualityExceptionLocationScope;
      readonly object?: QualityExceptionObjectScope;
    };

export type QualityException = {
  readonly id: string;
  readonly ruleId: string;
  readonly scope: QualityExceptionScope;
  readonly reason: string;
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
  readonly ruleId: string;
  readonly severity: "error" | "warning" | "info";
  readonly object: TObject;
  readonly location: QualityLocation;
  readonly message: string;
  readonly evidence: readonly QualityEvidence<TObject>[];
  readonly handling: QualityDiagnosticHandling;
};

export type QualityFinding<TObject extends QualityObject = QualityObject> =
  Omit<QualityDiagnostic<TObject>, "ruleId" | "handling">;

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

export type QualityCheckRequest = {
  readonly candidates: readonly SemanticEditCandidate[];
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
> = Omit<QualityCheckRequest, "candidates"> & {
  readonly facts: FrameworkFacts<TUnit, TTranslation, TBody, TUnavailable>;
  readonly candidate: SemanticEditCandidate;
  readonly sourceUnit: SourceUnitFact<TUnit> | null;
  readonly configuration: TConfiguration;
};

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
  readonly check: (
    input: QualityCheckExecutionInput<TUnit, TTranslation, TBody, TUnavailable>,
  ) => Awaitable<QualityCheckOutcome<TObject>>;
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
  readonly configurationSchema: TConfigurationSchema;
  readonly configuration: StandardSchemaInput<TConfigurationSchema>;
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
  readonly configurationSchema: TSchema;
  readonly configuration: StandardSchemaInput<TSchema>;
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
  const { id, configuration, configurationSchema, check } = definition;
  return {
    [qualityCheckDefinitionBrand]: true,
    id,
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
        check: (input) =>
          check({ ...input, configuration: parsedConfiguration }),
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
    configuration,
    configurationSchema,
    inputSchema,
    select,
    project,
    check,
  } = definition;
  return {
    [qualityCheckDefinitionBrand]: true,
    id,
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
        check: async (input) => {
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
            return bindingOutcome<TObject>("not-applicable");
          if (selection.status === "incomplete")
            return bindingOutcome<TObject>("incomplete", selection.issue);

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
            return bindingOutcome<TObject>("incomplete", projection.issue);

          const projectedInput = await validateWithStandardSchema(
            inputSchema,
            projection.value,
            `QA 检查器 ${id} 的投影输入`,
          );
          return check({
            ...boundInput,
            subject: selection.subject,
            projected: projectedInput,
          });
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

export type QualityCheckResult<TObject extends QualityObject = QualityObject> =
  {
    readonly id: string;
    readonly configuration: unknown;
    readonly status: QualityCheckStatus;
    readonly diagnostics: readonly QualityDiagnostic<TObject>[];
    readonly issues: readonly QualityIssue<TObject>[];
    readonly coverage: QualityCoverage;
  };

export type QualityFactCoverage = {
  readonly source: SourceReadFact;
  readonly translations: readonly TranslationReadFact[];
  readonly associations: readonly (TranslationAssociationFact & {
    readonly candidateSelected: boolean;
  })[];
};

export type QualityRunResult<TObject extends QualityObject = QualityObject> = {
  readonly version: string;
  readonly candidates: readonly SemanticEditCandidate[];
  readonly factCoverage: QualityFactCoverage;
  readonly dependencies: unknown;
  readonly relationships: readonly QualityRelationship[];
  readonly exceptions: readonly QualityException[];
  readonly status: QualityCheckStatus;
  readonly diagnostics: readonly QualityDiagnostic<TObject>[];
  readonly checks: readonly QualityCheckResult<TObject>[];
};

export async function runQualityChecks<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  facts: FrameworkFacts<TUnit, TTranslation, TBody, TUnavailable>,
  request: QualityCheckRequest,
  checks: readonly QualityCheckDefinition<
    TUnit,
    TTranslation,
    QualityObject,
    TBody,
    TUnavailable
  >[],
): Promise<QualityRunResult> {
  const boundRequest = snapshotQualityData({
    candidates: request.candidates,
    dependencies: request.dependencies,
    relationships: request.relationships ?? [],
    exceptions: request.exceptions ?? [],
  });
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
  for (const definition of checks)
    preparedChecks.push({
      id: definition.id,
      prepared: await definition.prepare(),
    });

  const results: QualityCheckResult[] = [];
  for (const { id, prepared } of preparedChecks) {
    const configuration = snapshotQualityData(prepared.configuration);
    const diagnostics: QualityDiagnostic[] = [];
    const issues: QualityIssue[] = [];
    const coverage: MutableQualityCoverage = {
      selected: 0,
      evaluated: 0,
      notApplicable: 0,
      incomplete: 0,
      failed: 0,
    };
    const statuses: QualityCheckStatus[] = [];

    for (const candidate of boundRequest.candidates) {
      try {
        const outcome = await prepared.check({
          facts,
          candidate,
          sourceUnit:
            facts.source.units.find(({ key }) => key === candidate.sourceKey) ??
            null,
          dependencies: boundRequest.dependencies,
          relationships: boundRequest.relationships,
          exceptions: boundRequest.exceptions,
        });
        const findings = snapshotQualityData(outcome.diagnostics);
        const checkIssues = snapshotQualityData(outcome.issues);
        diagnostics.push(
          ...findings.map((diagnostic) => ({
            ...diagnostic,
            ruleId: id,
            handling: handlingFor(id, diagnostic, boundRequest.exceptions),
          })),
        );
        issues.push(...checkIssues);
        statuses.push(outcome.status);
        addCoverage(coverage, outcome.coverage);
      } catch (error) {
        if (
          error instanceof StandardSchemaContractError ||
          error instanceof QualityCheckBindingError
        )
          throw error;
        statuses.push("failed");
        coverage.selected += 1;
        coverage.failed += 1;
        issues.push({
          code: "checkFailed",
          message: error instanceof Error ? error.message : String(error),
          object: candidateObject(candidate),
        });
      }
    }

    results.push({
      id,
      configuration,
      status: aggregateStatus(statuses),
      diagnostics,
      issues,
      coverage,
    });
  }

  return {
    version: facts.version,
    ...boundRequest,
    factCoverage: snapshotQualityData({
      source: facts.source.read,
      translations: facts.translations.reads,
      associations: facts.associations.map((association) => ({
        ...association,
        candidateSelected: boundRequest.candidates.some(
          ({ sourceKey, language }) =>
            sourceKey === association.sourceKey &&
            language === association.language,
        ),
      })),
    }),
    status: aggregateStatus(results.map(({ status }) => status)),
    diagnostics: results.flatMap(({ diagnostics }) => diagnostics),
    checks: results,
  };
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

function handlingFor(
  ruleId: string,
  diagnostic: QualityFinding,
  exceptions: readonly QualityException[],
): QualityDiagnosticHandling {
  const exception = exceptions.find(
    (candidate) =>
      candidate.ruleId === ruleId &&
      exceptionScopeMatches(candidate.scope, diagnostic),
  );
  return exception === undefined
    ? { status: "active" }
    : {
        status: "excepted",
        exceptionId: exception.id,
        reason: exception.reason,
      };
}

function exceptionScopeMatches(
  scope: QualityExceptionScope,
  diagnostic: QualityFinding,
): boolean {
  const objectMatches =
    scope.object === undefined ||
    (scope.object.kind === diagnostic.object.kind &&
      scope.object.key === diagnostic.object.key &&
      (scope.object.language === undefined ||
        scope.object.language === diagnostic.object.language));
  const locationMatches =
    scope.location === undefined ||
    (scope.location.language === diagnostic.location.language &&
      isDeepStrictEqual(scope.location.range, diagnostic.location.range) &&
      (scope.location.key === undefined ||
        scope.location.key === diagnostic.location.key));
  return objectMatches && locationMatches;
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

function candidateObject(candidate: SemanticEditCandidate): QualityObject {
  return {
    kind: "translation-unit",
    key: candidate.sourceKey,
    language: candidate.language,
  };
}
