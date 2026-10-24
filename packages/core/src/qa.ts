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
> = Omit<QualityCheckRequest, "candidates"> & {
  readonly facts: FrameworkFacts<TUnit, TTranslation>;
  readonly candidate: SemanticEditCandidate;
  readonly sourceUnit: SourceUnitFact<TUnit> | null;
  readonly configuration: unknown;
};

export type QualityCheckDefinition<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TObject extends QualityObject = QualityObject,
> = {
  readonly id: string;
  readonly configuration: unknown;
  check(
    input: QualityCheckInput<TUnit, TTranslation>,
  ): Awaitable<QualityCheckOutcome<TObject>>;
};

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
>(
  facts: FrameworkFacts<TUnit, TTranslation>,
  request: QualityCheckRequest,
  checks: readonly QualityCheckDefinition<TUnit, TTranslation>[],
): Promise<QualityRunResult> {
  const boundRequest = snapshotQualityData({
    candidates: request.candidates,
    dependencies: request.dependencies,
    relationships: request.relationships ?? [],
    exceptions: request.exceptions ?? [],
  });
  const results: QualityCheckResult[] = [];
  for (const definition of checks) {
    let configuration: unknown = null;
    let configurationFailure: unknown;
    let configurationFailed = false;
    if (boundRequest.candidates.length > 0) {
      try {
        configuration = snapshotQualityData(definition.configuration);
      } catch (error) {
        configurationFailure = error;
        configurationFailed = true;
      }
    }
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
      if (configurationFailed) {
        statuses.push("failed");
        coverage.selected += 1;
        coverage.failed += 1;
        issues.push({
          code: "checkFailed",
          message:
            configurationFailure instanceof Error
              ? configurationFailure.message
              : String(configurationFailure),
          object: candidateObject(candidate),
        });
        continue;
      }
      try {
        const outcome = await definition.check({
          facts,
          candidate,
          sourceUnit:
            facts.source.units.find(({ key }) => key === candidate.sourceKey) ??
            null,
          dependencies: boundRequest.dependencies,
          relationships: boundRequest.relationships,
          exceptions: boundRequest.exceptions,
          configuration: definition.configuration,
        });
        const findings = snapshotQualityData(outcome.diagnostics);
        const checkIssues = snapshotQualityData(outcome.issues);
        diagnostics.push(
          ...findings.map((diagnostic) => ({
            ...diagnostic,
            ruleId: definition.id,
            handling: handlingFor(
              definition.id,
              diagnostic,
              boundRequest.exceptions,
            ),
          })),
        );
        issues.push(...checkIssues);
        statuses.push(outcome.status);
        addCoverage(coverage, outcome.coverage);
      } catch (error) {
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
      id: definition.id,
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
  if (value === undefined) return value;
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new TypeError("QA 输入与结果必须可序列化为 JSON。", { cause: error });
  }
  if (serialized === undefined)
    throw new TypeError("QA 输入与结果必须可序列化为 JSON。");
  return JSON.parse(serialized) as TValue;
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
