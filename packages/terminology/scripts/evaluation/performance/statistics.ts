import type {
  Distribution,
  ModeDistribution,
  PhaseDistribution,
  PerformancePhaseName,
} from "./types.ts";
import type { PerformanceWorkerResult } from "./worker.ts";

export function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = values.toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export function distribution(values: readonly number[]): Distribution {
  const center = median(values);
  if (center === null)
    return Object.freeze({
      count: 0,
      median: null,
      minimum: null,
      maximum: null,
      medianAbsoluteDeviation: null,
      relativeMedianAbsoluteDeviation: null,
      raw: Object.freeze([]),
    });
  const deviations = values.map((value) => Math.abs(value - center));
  const deviation = median(deviations);
  return Object.freeze({
    count: values.length,
    median: center,
    minimum: Math.min(...values),
    maximum: Math.max(...values),
    medianAbsoluteDeviation: deviation,
    relativeMedianAbsoluteDeviation:
      deviation === null || center === 0 ? null : deviation / center,
    raw: Object.freeze([...values]),
  });
}

export function aggregateModeSamples(
  plannedSamples: number,
  samples: readonly PerformanceWorkerResult[],
): ModeDistribution {
  const summarizePhase = (phase: PerformancePhaseName): PhaseDistribution =>
    Object.freeze({
      durationsMs: distribution(
        samples.map(({ phases: values }) => values[phase].durationMs),
      ),
      outputs: Object.freeze(
        samples.map(({ sampleIndex, phases: values }) =>
          Object.freeze({
            sampleIndex,
            summary: values[phase].output,
          }),
        ),
      ),
      stageMemory: Object.freeze(
        samples.map(({ sampleIndex, phases: values }) => ({
          sampleIndex,
          gcBeforeRequested: values[phase].memory.gcBeforeRequested,
          before: values[phase].memory.before,
          after: values[phase].memory.after,
        })),
      ),
    });
  const phaseReports: Record<PerformancePhaseName, PhaseDistribution> = {
    termbaseCreate: summarizePhase("termbaseCreate"),
    compileTerms: summarizePhase("compileTerms"),
    analyzeTermUse: summarizePhase("analyzeTermUse"),
    assessTermUse: summarizePhase("assessTermUse"),
    discoverTerms: summarizePhase("discoverTerms"),
    evaluateTerms: summarizePhase("evaluateTerms"),
  };
  return Object.freeze({
    plannedSamples,
    completedSamples: samples.length,
    phases: Object.freeze(phaseReports),
    processPeakMaxRssBytes: distribution(
      samples.map(({ memory }) => memory.processPeakMaxRssBytes),
    ),
    postReleaseHeapUsedBytes: distribution(
      samples.map(({ memory }) => memory.postRelease.heapUsed),
    ),
    sampleOutputs: Object.freeze(
      samples.map(({ sampleIndex, output }) =>
        Object.freeze({
          sampleIndex,
          status: output.status,
          fingerprints: output.fingerprints,
          counts: Object.freeze({
            groupCount: output.groupCount,
            conceptCount: output.conceptCount,
            expressionCount: output.expressionCount,
            sourceMatches: output.sourceMatches,
            targetMatches: output.targetMatches,
            problems: output.problems,
            assessmentIssues: output.assessmentIssues,
            candidateCount: output.candidateCount,
            discoveryIssues: output.discoveryIssues,
          }),
        }),
      ),
    ),
  });
}
