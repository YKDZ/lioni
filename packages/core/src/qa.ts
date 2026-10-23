import { isDeepStrictEqual } from "node:util";

import type {
  Awaitable,
  FrameworkFacts,
  TranslationUnitInput,
} from "./index.ts";

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

export type QualityEvidenceScope = {
  readonly kind: string;
  readonly key: string;
  readonly language?: string;
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

export type QualityCheckOutcome<TObject extends QualityObject = QualityObject> =
  {
    readonly status: Exclude<QualityCheckStatus, "not-run">;
    readonly diagnostics: readonly QualityFinding<TObject>[];
    readonly issues: readonly QualityIssue<TObject>[];
    readonly coverage: QualityCoverage;
  };

export type QualityCheckRequest = {
  readonly subjects: readonly QualitySubject[];
  readonly evidenceScope: readonly QualityEvidenceScope[];
  readonly dependencies: unknown;
  readonly relationships?: readonly QualityRelationship[];
  readonly exceptions?: readonly QualityException[];
};

export type QualityCheckInput<
  TUnit extends TranslationUnitInput,
  TTranslation,
> = QualityCheckRequest & {
  readonly facts: FrameworkFacts<TUnit, TTranslation>;
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
    readonly status: Exclude<QualityCheckStatus, "not-run">;
    readonly diagnostics: readonly QualityDiagnostic<TObject>[];
    readonly issues: readonly QualityIssue<TObject>[];
    readonly coverage: QualityCoverage;
  };

export type QualityRunResult<TObject extends QualityObject = QualityObject> = {
  readonly version: string;
  readonly subjects: readonly QualitySubject[];
  readonly evidenceScope: readonly QualityEvidenceScope[];
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
    subjects: request.subjects,
    evidenceScope: request.evidenceScope,
    dependencies: request.dependencies,
    relationships: request.relationships ?? [],
    exceptions: request.exceptions ?? [],
  });
  const results: QualityCheckResult[] = [];
  for (const definition of checks) {
    let configuration: unknown;
    try {
      configuration = snapshotQualityData(definition.configuration);
      const outcome = await definition.check({
        facts,
        ...request,
        configuration: definition.configuration,
      });
      const findings = snapshotQualityData(outcome.diagnostics);
      const diagnostics = findings.map((diagnostic) => ({
        ...diagnostic,
        ruleId: definition.id,
        handling: handlingFor(
          definition.id,
          diagnostic,
          boundRequest.exceptions,
        ),
      }));
      results.push({
        id: definition.id,
        configuration,
        status: outcome.status,
        diagnostics,
        issues: snapshotQualityData(outcome.issues),
        coverage: { ...outcome.coverage },
      });
    } catch (error) {
      results.push({
        id: definition.id,
        configuration,
        status: "failed",
        diagnostics: [],
        issues: [
          {
            code: "checkFailed",
            message: error instanceof Error ? error.message : String(error),
          },
        ],
        coverage: {
          selected: request.subjects.length,
          evaluated: 0,
          notApplicable: 0,
          incomplete: 0,
          failed: 1,
        },
      });
    }
  }

  return {
    version: facts.version,
    ...boundRequest,
    status: aggregateStatus(results),
    diagnostics: results.flatMap(({ diagnostics }) => diagnostics),
    checks: results,
  };
}

function snapshotQualityData<TValue>(value: TValue): TValue {
  // 报告使用与事实版本一致的 JSON 表示；传给检查器的原始输入不经复制。
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
  checks: readonly QualityCheckResult[],
): QualityCheckStatus {
  if (checks.length === 0) return "not-run";
  if (checks.every(({ status }) => status === "not-applicable"))
    return "not-applicable";
  if (checks.some(({ status }) => status === "failed")) return "failed";
  if (checks.some(({ status }) => status === "incomplete")) return "incomplete";
  return "complete";
}
