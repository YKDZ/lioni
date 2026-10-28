import type { ProcessStatus } from "../support/process.ts";
import type { MeasurementSummary } from "./statistics.ts";
import type {
  PerformanceMemoMode,
  PerformancePreparedInput,
} from "./workload.ts";

export type PerformanceWorkerResult = {
  readonly comparisonGroups: number;
  readonly concepts: number;
  readonly memoMode: PerformanceMemoMode;
  readonly sample: number;
  readonly timingsMs: {
    readonly discoverTerms: number;
    readonly evaluateTerms: number;
  };
  readonly results: {
    readonly discovery: {
      readonly status: "complete" | "incomplete";
      readonly candidates: number;
      readonly issues: number;
      readonly sha256: string;
    };
    readonly evaluation: {
      readonly status: "complete" | "incomplete";
      readonly problems: number;
      readonly issues: number;
      readonly sha256: string;
    };
  };
  readonly reusedScopeWarmup: {
    readonly timingsMs: {
      readonly discoverTerms: number;
      readonly evaluateTerms: number;
    };
    readonly results: {
      readonly discoverySha256: string;
      readonly evaluationSha256: string;
    };
  } | null;
  /** Node.js resourceUsage maxRSS covers this worker's full process lifetime. */
  readonly lifecycleMaxRssBytes: number;
  readonly publicEntry: string;
  readonly inputFacts: PerformancePreparedInput["facts"];
};

export type PerformanceAttempt = {
  readonly sample: number;
  readonly memoMode: PerformanceMemoMode;
  readonly status: ProcessStatus | "invalid-output";
  readonly processDurationMs: number;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly result?: PerformanceWorkerResult;
  readonly error?: string;
};

export type PerformanceModeReport = {
  readonly status: "passed" | "failed" | "interrupted" | "not-run";
  readonly plannedSamples: 5;
  readonly completedSamples: number;
  readonly attempts: readonly PerformanceAttempt[];
  readonly summary: {
    readonly discoverTermsMs: MeasurementSummary;
    readonly evaluateTermsMs: MeasurementSummary;
    readonly lifecycleMaxRssBytes: MeasurementSummary;
  };
};

export type PerformanceScaleReport = {
  readonly comparisonGroups: number;
  readonly concepts: number;
  readonly inputSha256: string;
  readonly seed: number;
  readonly facts: PerformancePreparedInput["facts"];
  readonly outputConsistency: {
    readonly status: "verified" | "different" | "not-verified";
    readonly reference?: {
      readonly discoverySha256: string;
      readonly evaluationSha256: string;
    };
    readonly differences: readonly {
      readonly mode: PerformanceMemoMode;
      readonly sample: number;
      readonly discoverySha256: string;
      readonly evaluationSha256: string;
    }[];
  };
  readonly modes: Readonly<Record<PerformanceMemoMode, PerformanceModeReport>>;
};

export type PerformanceReport = {
  readonly schemaVersion: 1;
  readonly kind: "terminology-performance-baseline";
  readonly status: "running" | "passed" | "failed" | "interrupted";
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly environment: {
    readonly node: string;
    readonly platform: string;
    readonly arch: string;
    readonly cpuModel: string | null;
    readonly cpuCount: number;
  };
  readonly seed: number;
  readonly samplesPerMode: 5;
  readonly timeoutMs: number;
  readonly measuredCalls: readonly ["discoverTerms", "evaluateTerms"];
  readonly inputPreparation: "fixed-seed generation outside timed calls";
  readonly reusedScopeWarmup: "same worker process; reported per sample";
  readonly lifecycleMaxRss: {
    readonly source: "process.resourceUsage().maxRSS";
    readonly unit: "bytes";
    readonly includes: "worker startup, input parsing, termbase compilation, calls, and reused-scope warmup";
  };
  readonly scales: Readonly<Record<string, PerformanceScaleReport>>;
};
