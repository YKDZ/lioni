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
  readonly range: unknown;
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
};

export type QualityFinding<TObject extends QualityObject = QualityObject> =
  Omit<QualityDiagnostic<TObject>, "ruleId">;

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
  const results: QualityCheckResult[] = [];
  for (const definition of checks) {
    try {
      const outcome = await definition.check({
        facts,
        ...request,
        configuration: definition.configuration,
      });
      results.push({
        id: definition.id,
        configuration: definition.configuration,
        status: outcome.status,
        diagnostics: outcome.diagnostics.map((diagnostic) => ({
          ...diagnostic,
          ruleId: definition.id,
        })),
        issues: outcome.issues,
        coverage: outcome.coverage,
      });
    } catch (error) {
      results.push({
        id: definition.id,
        configuration: definition.configuration,
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
    subjects: request.subjects.map((subject) => ({ ...subject })),
    evidenceScope: request.evidenceScope.map((entry) => ({ ...entry })),
    dependencies: request.dependencies,
    status: aggregateStatus(results),
    diagnostics: results.flatMap(({ diagnostics }) => diagnostics),
    checks: results,
  };
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
