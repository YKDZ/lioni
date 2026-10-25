import type { ProcessResult } from "../support/index.ts";
import type { PerformanceWorkerResult } from "./worker.ts";
import type {
  PerformanceMemoMode,
  PerformancePreparedInput,
} from "./workload.ts";

export type PerformancePhaseName = keyof PerformanceWorkerResult["phases"];

export type PerformanceAttempt = {
  readonly sampleIndex: number;
  readonly retryNumber: number;
  readonly memoMode: PerformanceMemoMode;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly status: "passed" | "failed";
  readonly reason?: string;
  readonly process: ProcessResult;
  readonly sample?: PerformanceWorkerResult;
};

export type Distribution = {
  readonly count: number;
  readonly median: number | null;
  readonly minimum: number | null;
  readonly maximum: number | null;
  readonly medianAbsoluteDeviation: number | null;
  readonly relativeMedianAbsoluteDeviation: number | null;
  readonly raw: readonly number[];
};

export type PhaseDistribution = {
  readonly durationsMs: Distribution;
  readonly outputs: readonly {
    readonly sampleIndex: number;
    readonly summary: PerformanceWorkerResult["phases"][PerformancePhaseName]["output"];
  }[];
  readonly stageMemory: readonly {
    readonly sampleIndex: number;
    readonly gcBeforeRequested: boolean;
    readonly before: NodeJS.MemoryUsage;
    readonly after: NodeJS.MemoryUsage;
  }[];
};

export type ModeDistribution = {
  readonly plannedSamples: number;
  readonly completedSamples: number;
  readonly phases: Readonly<Record<PerformancePhaseName, PhaseDistribution>>;
  readonly processPeakMaxRssBytes: Distribution;
  readonly postReleaseHeapUsedBytes: Distribution;
  readonly sampleOutputs: readonly {
    readonly sampleIndex: number;
    readonly status: "complete" | "incomplete";
    readonly fingerprints: PerformanceWorkerResult["output"]["fingerprints"];
    readonly counts: Omit<
      PerformanceWorkerResult["output"],
      "fingerprints" | "status"
    >;
  }[];
};

export type PerformanceScenarioReport = {
  readonly id: PerformancePreparedInput["id"];
  readonly execution: {
    readonly status: "running" | "passed" | "failed" | "not-executed";
    readonly reason?: string;
  };
  readonly domain: { readonly status: "complete" | "incomplete" | "not-run" };
  readonly measurementsEligible: boolean;
  readonly input?: {
    readonly sha256: string;
    readonly transformedInputSha256?: string;
    readonly facts: PerformancePreparedInput["facts"];
    readonly generation?: PerformancePreparedInput["generation"];
    readonly external?: PerformancePreparedInput["external"];
  };
  readonly preparation: {
    readonly durationMs: number;
    readonly kind: "deterministic-generation" | "fixed-corpus-transform-cache";
    readonly corpusCache?: {
      readonly state: "built" | "reused" | "rebuilt";
      readonly path: string;
    };
  };
  readonly selection: unknown;
  readonly policy: Readonly<Record<string, unknown>>;
  readonly outputEquivalence: {
    readonly withinMode: boolean;
    readonly acrossModes: boolean;
    readonly differences: readonly string[];
  };
  readonly eligibilityReasons: readonly string[];
  readonly attempts: readonly PerformanceAttempt[];
  readonly modes: Readonly<Record<PerformanceMemoMode, ModeDistribution>>;
  readonly qualityMetrics: Readonly<
    Record<
      string,
      {
        readonly status: "not-evaluated";
        readonly basis: string;
      }
    >
  >;
};

export type PerformanceRunReport = {
  readonly schemaVersion: 1;
  readonly kind: "performance";
  readonly runId: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly status: "running" | "passed" | "failed" | "interrupted";
  readonly selected: readonly PerformancePreparedInput["id"][];
  readonly parameters: {
    readonly samplesPerMode: number;
    readonly runtimeWarmupGroups: number;
    readonly retries: number;
    readonly sampleTimeoutMs: number;
    readonly memoModes: readonly PerformanceMemoMode[];
    readonly sourceMode: "built-public-exports";
    readonly rebuildExternalInputs: boolean;
  };
  readonly buildPreparation: {
    readonly status: "measured-by-root-turbo" | "verified-prebuilt-by-caller";
    readonly command: string;
    readonly durationMs: number | null;
    readonly includedInSamples: false;
  };
  readonly activeAttempt?: {
    readonly scenario: string;
    readonly memoMode: PerformanceMemoMode;
    readonly sampleIndex: number;
    readonly retryNumber: number;
  };
  readonly artifact: {
    readonly package: "@lioni/terminology";
    readonly version: string;
    readonly entry: string;
    readonly sha256: string;
    readonly files: readonly string[];
  };
  readonly source: {
    readonly commit: string;
    readonly dirty: boolean;
    readonly changedFiles: readonly string[];
  };
  readonly environment: {
    readonly node: string;
    readonly icu: string | null;
    readonly unicode: string | null;
    readonly platform: string;
    readonly arch: string;
    readonly cpuModel: string | null;
    readonly cpuCount: number;
    readonly totalMemoryBytes: number;
  };
  readonly scenarios: Readonly<Record<string, PerformanceScenarioReport>>;
};

export type PerformanceComparisonReport = {
  readonly schemaVersion: 1;
  readonly kind: "performance-comparison";
  readonly createdAt: string;
  readonly baselineReport: string;
  readonly candidateReport: string;
  readonly intent: "equivalent-output" | "quality-adjustment";
  readonly comparability: {
    readonly status: "comparable" | "not-comparable";
    readonly blockers: readonly {
      readonly field: string;
      readonly baseline: unknown;
      readonly candidate: unknown;
    }[];
    readonly versionChanges: readonly {
      readonly field: string;
      readonly baseline: unknown;
      readonly candidate: unknown;
    }[];
  };
  readonly resultComparison: {
    readonly status:
      | "equivalent"
      | "different"
      | "incomplete"
      | "not-comparable";
    readonly differences: readonly {
      readonly scenario: string;
      readonly mode?: string;
      readonly phase?: string;
      readonly field?: string;
      readonly baseline: unknown;
      readonly candidate: unknown;
    }[];
  };
  readonly performance: {
    readonly status: "comparable" | "descriptive-only" | "not-comparable";
    readonly observations: readonly {
      readonly scenario: string;
      readonly mode: PerformanceMemoMode;
      readonly phase: PerformancePhaseName;
      readonly baselineMedianMs: number | null;
      readonly candidateMedianMs: number | null;
      readonly deltaMs: number | null;
      readonly deltaPercent: number | null;
      readonly baselineMedianAbsoluteDeviationMs: number | null;
      readonly candidateMedianAbsoluteDeviationMs: number | null;
    }[];
  };
};
