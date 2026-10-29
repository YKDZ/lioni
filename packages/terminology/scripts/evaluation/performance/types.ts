import { z } from "zod";

import type { ProcessStatus } from "../support/process.ts";
import type { MeasurementSummary } from "./statistics.ts";
import {
  performanceFactsSchema,
  performanceMemoModeSchema,
} from "./workload.ts";
import type {
  PerformanceMemoMode,
  PerformancePreparedInput,
} from "./workload.ts";

const timingsSchema = z
  .object({
    discoverTerms: z.number().nonnegative(),
    evaluateTerms: z.number().nonnegative(),
  })
  .readonly();
const resultBase = {
  status: z.enum(["complete", "incomplete"]),
  issues: z.int().nonnegative(),
  sha256: z.string().min(1),
};
export const performanceWorkerResultSchema = z
  .object({
    comparisonGroups: z.int().positive(),
    concepts: z.int().positive(),
    memoMode: performanceMemoModeSchema,
    sample: z.int().nonnegative(),
    timingsMs: timingsSchema,
    results: z
      .object({
        discovery: z
          .object({ ...resultBase, candidates: z.int().nonnegative() })
          .readonly(),
        evaluation: z
          .object({ ...resultBase, problems: z.int().nonnegative() })
          .readonly(),
      })
      .readonly(),
    reusedScopeWarmup: z
      .object({
        timingsMs: timingsSchema,
        results: z
          .object({
            discoverySha256: z.string().min(1),
            evaluationSha256: z.string().min(1),
          })
          .readonly(),
      })
      .readonly()
      .nullable(),
    /** Node.js 的 maxRSS 包含整个样本进程的生命周期。 */
    lifecycleMaxRssBytes: z.number().nonnegative(),
    publicEntry: z.string().min(1),
    inputFacts: performanceFactsSchema,
  })
  .readonly();
export type PerformanceWorkerResult = z.infer<
  typeof performanceWorkerResultSchema
>;

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
