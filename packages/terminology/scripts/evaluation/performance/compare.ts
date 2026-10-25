import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  collectEnvironment,
  collectSourceIdentity,
  defaultRunDirectory,
  initializeRunDirectory,
  writeEvaluationReport,
} from "../support/index.ts";
import { median } from "./statistics.ts";
import type {
  PerformanceComparisonReport,
  PerformancePhaseName,
  PerformanceRunReport,
} from "./types.ts";
import type { PerformanceMemoMode } from "./workload.ts";

type ComparisonIntent = PerformanceComparisonReport["intent"];

const performancePhases: readonly PerformancePhaseName[] = [
  "termbaseCreate",
  "compileTerms",
  "analyzeTermUse",
  "assessTermUse",
  "discoverTerms",
  "evaluateTerms",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPerformanceRunReport(value: unknown): value is PerformanceRunReport {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.kind !== "performance" ||
    typeof value.runId !== "string" ||
    !Array.isArray(value.selected) ||
    !isRecord(value.parameters) ||
    !isRecord(value.artifact) ||
    !isRecord(value.source) ||
    !isRecord(value.environment) ||
    !isRecord(value.scenarios)
  )
    return false;
  if (
    typeof value.artifact.package !== "string" ||
    typeof value.artifact.version !== "string" ||
    typeof value.artifact.entry !== "string" ||
    typeof value.artifact.sha256 !== "string" ||
    !Array.isArray(value.artifact.files) ||
    typeof value.source.commit !== "string" ||
    typeof value.source.dirty !== "boolean" ||
    !Array.isArray(value.source.changedFiles) ||
    typeof value.environment.node !== "string" ||
    typeof value.environment.platform !== "string" ||
    typeof value.environment.arch !== "string" ||
    typeof value.parameters.samplesPerMode !== "number" ||
    !Array.isArray(value.parameters.memoModes)
  )
    return false;
  for (const scenario of Object.values(value.scenarios)) {
    if (
      !isRecord(scenario) ||
      !isRecord(scenario.execution) ||
      !isRecord(scenario.domain) ||
      typeof scenario.measurementsEligible !== "boolean" ||
      !isRecord(scenario.outputEquivalence) ||
      !Array.isArray(scenario.attempts) ||
      !isRecord(scenario.modes)
    )
      return false;
    for (const mode of ["no-memo", "empty-scope", "reused-scope"] as const) {
      const distribution = scenario.modes[mode];
      if (!isRecord(distribution) || !isRecord(distribution.phases))
        return false;
      for (const phase of [
        "termbaseCreate",
        "compileTerms",
        "analyzeTermUse",
        "assessTermUse",
        "discoverTerms",
        "evaluateTerms",
      ] as const) {
        const phaseReport = distribution.phases[phase];
        if (
          !isRecord(phaseReport) ||
          !isRecord(phaseReport.durationsMs) ||
          !Array.isArray(phaseReport.durationsMs.raw)
        )
          return false;
      }
      if (
        !Array.isArray(distribution.sampleOutputs) ||
        distribution.sampleOutputs.some((sample) => {
          if (!isRecord(sample)) return true;
          const fingerprints = sample["fingerprints"];
          if (!isRecord(fingerprints)) return true;
          return ["analysis", "assessment", "discovery", "fullEvaluation"].some(
            (name) => typeof fingerprints[name] !== "string",
          );
        })
      )
        return false;
    }
  }
  return true;
}

function equal(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(left, right);
}

function identityDifference(
  target: { field: string; baseline: unknown; candidate: unknown }[],
  field: string,
  baseline: unknown,
  candidate: unknown,
): void {
  if (!equal(baseline, candidate))
    target.push(Object.freeze({ field, baseline, candidate }));
}

function requiredIdentityDifference(
  target: { field: string; baseline: unknown; candidate: unknown }[],
  field: string,
  baseline: unknown,
  candidate: unknown,
  valid: (value: unknown) => boolean,
): void {
  if (!valid(baseline) || !valid(candidate)) {
    target.push(
      Object.freeze({
        field: `missing-required-evidence.${field}`,
        baseline: baseline ?? null,
        candidate: candidate ?? null,
      }),
    );
    return;
  }
  identityDifference(target, field, baseline, candidate);
}

function requireEvidence(
  target: { field: string; baseline: unknown; candidate: unknown }[],
  field: string,
  baseline: unknown,
  candidate: unknown,
  valid: (value: unknown) => boolean,
): void {
  if (valid(baseline) && valid(candidate)) return;
  target.push(
    Object.freeze({
      field: `missing-required-evidence.${field}`,
      baseline: baseline ?? null,
      candidate: candidate ?? null,
    }),
  );
}

function nonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.length > 0;
}

function positiveNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function nonEmptyRecord(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length > 0;
}

function hasStageOutputSummaries(
  value: unknown,
  expectedCount: unknown,
): boolean {
  if (
    !Array.isArray(value) ||
    typeof expectedCount !== "number" ||
    !Number.isSafeInteger(expectedCount) ||
    expectedCount < 1 ||
    value.length !== expectedCount
  )
    return false;
  const sampleIndexes = new Set<number>();
  return value.every((item) => {
    if (
      !isRecord(item) ||
      typeof item.sampleIndex !== "number" ||
      !Number.isSafeInteger(item.sampleIndex) ||
      item.sampleIndex < 1 ||
      !isRecord(item.summary) ||
      Object.keys(item.summary).length === 0 ||
      sampleIndexes.has(item.sampleIndex)
    )
      return false;
    sampleIndexes.add(item.sampleIndex);
    return true;
  });
}

function hasSampleOutputSummaries(
  value: unknown,
  expectedCount: unknown,
): boolean {
  if (
    !Array.isArray(value) ||
    typeof expectedCount !== "number" ||
    !Number.isSafeInteger(expectedCount) ||
    expectedCount < 1 ||
    value.length !== expectedCount
  )
    return false;
  const sampleIndexes = new Set<number>();
  const countFields = [
    "groupCount",
    "conceptCount",
    "expressionCount",
    "sourceMatches",
    "targetMatches",
    "problems",
    "assessmentIssues",
    "candidateCount",
    "discoveryIssues",
  ] as const;
  return value.every((item) => {
    if (!isRecord(item)) return false;
    const fingerprints = item["fingerprints"];
    const counts = item["counts"];
    if (
      typeof item.sampleIndex !== "number" ||
      !Number.isSafeInteger(item.sampleIndex) ||
      item.sampleIndex < 1 ||
      sampleIndexes.has(item.sampleIndex) ||
      (item.status !== "complete" && item.status !== "incomplete") ||
      !isRecord(counts) ||
      !isRecord(fingerprints) ||
      ["analysis", "assessment", "discovery", "fullEvaluation"].some(
        (field) => typeof fingerprints[field] !== "string",
      ) ||
      countFields.some(
        (field) =>
          typeof counts[field] !== "number" ||
          !Number.isSafeInteger(counts[field]),
      )
    )
      return false;
    sampleIndexes.add(item.sampleIndex);
    return true;
  });
}

function flattenSummary(
  value: unknown,
  prefix = "",
  fields = new Map<string, unknown>(),
): Map<string, unknown> {
  if (isRecord(value)) {
    const keys = Object.keys(value).toSorted();
    if (keys.length === 0 && prefix !== "") fields.set(prefix, value);
    for (const key of keys)
      flattenSummary(
        value[key],
        prefix === "" ? key : `${prefix}.${key}`,
        fields,
      );
  } else if (prefix !== "") fields.set(prefix, value);
  return fields;
}

function appendSummaryDifferences(
  target: PerformanceComparisonReport["resultComparison"]["differences"][number][],
  context: Omit<
    PerformanceComparisonReport["resultComparison"]["differences"][number],
    "field" | "baseline" | "candidate"
  >,
  baseline: unknown,
  candidate: unknown,
): void {
  const baselineFields = flattenSummary(baseline);
  const candidateFields = flattenSummary(candidate);
  const fields = [
    ...new Set([...baselineFields.keys(), ...candidateFields.keys()]),
  ].toSorted();
  for (const field of fields) {
    const before = baselineFields.get(field);
    const after = candidateFields.get(field);
    if (!equal(before, after))
      target.push(
        Object.freeze({
          ...context,
          field,
          baseline: before ?? null,
          candidate: after ?? null,
        }),
      );
  }
}

function externalIdentity(
  value:
    | NonNullable<
        NonNullable<
          PerformanceRunReport["scenarios"][string]["input"]
        >["external"]
      >
    | undefined,
): unknown {
  if (value === undefined) return undefined;
  return {
    id: value.id,
    source: {
      id: value.source.id,
      repository: value.source.repository,
      commit: value.source.commit,
      tag: value.source.tag,
      converterVersion: value.source.converterVersion,
      files: value.source.files,
      license: value.source.license,
    },
    transformedInputSha256: value.transformedInputSha256,
    selections: value.selections,
  };
}

function comparisonBlockers(
  baseline: PerformanceRunReport,
  candidate: PerformanceRunReport,
): {
  readonly blockers: PerformanceComparisonReport["comparability"]["blockers"];
  readonly versionChanges: PerformanceComparisonReport["comparability"]["versionChanges"];
} {
  const blockers: {
    field: string;
    baseline: unknown;
    candidate: unknown;
  }[] = [];
  const versionChanges: {
    field: string;
    baseline: unknown;
    candidate: unknown;
  }[] = [];
  identityDifference(
    blockers,
    "schemaVersion",
    baseline.schemaVersion,
    candidate.schemaVersion,
  );
  identityDifference(blockers, "kind", baseline.kind, candidate.kind);
  requiredIdentityDifference(
    blockers,
    "selected",
    baseline.selected,
    candidate.selected,
    (value) =>
      Array.isArray(value) && value.length > 0 && value.every(nonEmptyString),
  );
  requireEvidence(
    blockers,
    "artifact.sha256",
    baseline.artifact.sha256,
    candidate.artifact.sha256,
    nonEmptyString,
  );
  requireEvidence(
    blockers,
    "artifact.entry",
    baseline.artifact.entry,
    candidate.artifact.entry,
    nonEmptyString,
  );
  requireEvidence(
    blockers,
    "source.commit",
    baseline.source.commit,
    candidate.source.commit,
    nonEmptyString,
  );
  requireEvidence(
    blockers,
    "source.dirty",
    baseline.source.dirty,
    candidate.source.dirty,
    (value) => typeof value === "boolean",
  );
  requireEvidence(
    blockers,
    "source.changedFiles",
    baseline.source.changedFiles,
    candidate.source.changedFiles,
    Array.isArray,
  );
  for (const field of [
    "node",
    "icu",
    "unicode",
    "platform",
    "arch",
    "cpuModel",
    "cpuCount",
    "totalMemoryBytes",
  ] as const)
    requiredIdentityDifference(
      blockers,
      `environment.${field}`,
      baseline.environment[field],
      candidate.environment[field],
      field === "cpuCount" || field === "totalMemoryBytes"
        ? positiveNumber
        : nonEmptyString,
    );
  for (const field of ["runtimeWarmupGroups", "sourceMode"] as const)
    requiredIdentityDifference(
      blockers,
      `parameters.${field}`,
      baseline.parameters[field],
      candidate.parameters[field],
      field === "runtimeWarmupGroups"
        ? (value) =>
            typeof value === "number" &&
            Number.isSafeInteger(value) &&
            value > 0
        : (value) => value === "built-public-exports",
    );
  requiredIdentityDifference(
    blockers,
    "parameters.memoModes",
    baseline.parameters.memoModes,
    candidate.parameters.memoModes,
    (value) =>
      Array.isArray(value) &&
      isDeepStrictEqual(value, ["no-memo", "empty-scope", "reused-scope"]),
  );
  requiredIdentityDifference(
    blockers,
    "parameters.samplesPerMode",
    baseline.parameters.samplesPerMode,
    candidate.parameters.samplesPerMode,
    positiveNumber,
  );
  requiredIdentityDifference(
    blockers,
    "parameters.sampleTimeoutMs",
    baseline.parameters.sampleTimeoutMs,
    candidate.parameters.sampleTimeoutMs,
    positiveNumber,
  );
  requireEvidence(
    blockers,
    "selected-scenarios-have-reports",
    isDeepStrictEqual(
      baseline.selected.toSorted(),
      Object.keys(baseline.scenarios).toSorted(),
    ),
    isDeepStrictEqual(
      candidate.selected.toSorted(),
      Object.keys(candidate.scenarios).toSorted(),
    ),
    (value) => value === true,
  );

  identityDifference(
    versionChanges,
    "source.commit",
    baseline.source.commit,
    candidate.source.commit,
  );
  identityDifference(
    versionChanges,
    "source.dirty",
    baseline.source.dirty,
    candidate.source.dirty,
  );
  identityDifference(
    versionChanges,
    "source.changedFiles",
    baseline.source.changedFiles,
    candidate.source.changedFiles,
  );
  identityDifference(
    versionChanges,
    "artifact.version",
    baseline.artifact.version,
    candidate.artifact.version,
  );
  identityDifference(
    versionChanges,
    "artifact.entry",
    path.basename(baseline.artifact.entry),
    path.basename(candidate.artifact.entry),
  );
  identityDifference(
    versionChanges,
    "artifact.sha256",
    baseline.artifact.sha256,
    candidate.artifact.sha256,
  );
  identityDifference(
    versionChanges,
    "artifact.files",
    baseline.artifact.files,
    candidate.artifact.files,
  );

  const names = [
    ...new Set([
      ...Object.keys(baseline.scenarios),
      ...Object.keys(candidate.scenarios),
    ]),
  ].toSorted();
  for (const name of names) {
    const before = baseline.scenarios[name];
    const after = candidate.scenarios[name];
    if (!before || !after) {
      identityDifference(blockers, `scenarios.${name}`, before?.id, after?.id);
      continue;
    }
    if (before.input === undefined || after.input === undefined) {
      blockers.push(
        Object.freeze({
          field: `scenarios.${name}.input`,
          baseline: before.input ?? null,
          candidate: after.input ?? null,
        }),
      );
      continue;
    }
    requiredIdentityDifference(
      blockers,
      `scenarios.${name}.input.sha256`,
      before.input.sha256,
      after.input.sha256,
      nonEmptyString,
    );
    identityDifference(
      blockers,
      `scenarios.${name}.input.transformedInputSha256`,
      before.input.transformedInputSha256,
      after.input.transformedInputSha256,
    );
    requiredIdentityDifference(
      blockers,
      `scenarios.${name}.input.facts`,
      before.input.facts,
      after.input.facts,
      nonEmptyRecord,
    );
    if (before.id === "controlled-scale" || after.id === "controlled-scale")
      requiredIdentityDifference(
        blockers,
        `scenarios.${name}.input.generation`,
        before.input.generation,
        after.input.generation,
        nonEmptyRecord,
      );
    else
      identityDifference(
        blockers,
        `scenarios.${name}.input.generation`,
        before.input.generation,
        after.input.generation,
      );
    if (before.id === "cfpa" || after.id === "cfpa")
      requiredIdentityDifference(
        blockers,
        `scenarios.${name}.input.external`,
        externalIdentity(before.input.external),
        externalIdentity(after.input.external),
        nonEmptyRecord,
      );
    else
      identityDifference(
        blockers,
        `scenarios.${name}.input.external`,
        externalIdentity(before.input.external),
        externalIdentity(after.input.external),
      );
    requiredIdentityDifference(
      blockers,
      `scenarios.${name}.selection`,
      before.selection,
      after.selection,
      (value) => value !== null && value !== undefined,
    );
    requiredIdentityDifference(
      blockers,
      `scenarios.${name}.policy`,
      before.policy,
      after.policy,
      nonEmptyRecord,
    );
    for (const mode of ["no-memo", "empty-scope", "reused-scope"] as const) {
      const baselineMode = before.modes[mode];
      const candidateMode = after.modes[mode];
      for (const [side, value, plannedSamples] of [
        ["baseline", baselineMode.sampleOutputs, baselineMode.plannedSamples],
        [
          "candidate",
          candidateMode.sampleOutputs,
          candidateMode.plannedSamples,
        ],
      ] as const) {
        if (!hasSampleOutputSummaries(value, plannedSamples))
          blockers.push(
            Object.freeze({
              field: `missing-required-evidence.scenarios.${name}.modes.${mode}.sampleOutputs.${side}`,
              baseline: side === "baseline" ? (value ?? null) : null,
              candidate: side === "candidate" ? (value ?? null) : null,
            }),
          );
      }
      for (const phase of performancePhases) {
        const field = `scenarios.${name}.modes.${mode}.phases.${phase}.outputs`;
        const outputs = [
          [
            "baseline",
            baselineMode.phases[phase].outputs,
            baselineMode.plannedSamples,
          ],
          [
            "candidate",
            candidateMode.phases[phase].outputs,
            candidateMode.plannedSamples,
          ],
        ] as const;
        for (const [side, value, plannedSamples] of outputs) {
          if (!hasStageOutputSummaries(value, plannedSamples))
            blockers.push(
              Object.freeze({
                field: `missing-required-evidence.${field}.${side}`,
                baseline: side === "baseline" ? (value ?? null) : null,
                candidate: side === "candidate" ? (value ?? null) : null,
              }),
            );
        }
      }
    }
  }
  return Object.freeze({
    blockers: Object.freeze(blockers),
    versionChanges: Object.freeze(versionChanges),
  });
}

function resultDifferences(
  baseline: PerformanceRunReport,
  candidate: PerformanceRunReport,
): PerformanceComparisonReport["resultComparison"]["differences"] {
  const differences: PerformanceComparisonReport["resultComparison"]["differences"][number][] =
    [];
  const names = [
    ...new Set([
      ...Object.keys(baseline.scenarios),
      ...Object.keys(candidate.scenarios),
    ]),
  ].toSorted();
  for (const scenario of names) {
    const before = baseline.scenarios[scenario];
    const after = candidate.scenarios[scenario];
    if (!before || !after) {
      differences.push({
        scenario,
        baseline: before?.id ?? null,
        candidate: after?.id ?? null,
      });
      continue;
    }
    if (
      before.domain.status !== "complete" ||
      after.domain.status !== "complete"
    )
      differences.push({
        scenario,
        phase: "domain-status",
        baseline: before.domain.status,
        candidate: after.domain.status,
      });
    for (const mode of ["no-memo", "empty-scope", "reused-scope"] as const) {
      const beforeOutputs = before.modes[mode].sampleOutputs;
      const afterOutputs = after.modes[mode].sampleOutputs;
      const beforeFingerprint = beforeOutputs[0]?.fingerprints;
      const afterFingerprint = afterOutputs[0]?.fingerprints;
      if (
        beforeOutputs.some(
          ({ fingerprints }) => !equal(fingerprints, beforeFingerprint),
        )
      )
        differences.push({
          scenario,
          mode,
          phase: "baseline-internal-instability",
          baseline: beforeFingerprint,
          candidate: null,
        });
      if (
        afterOutputs.some(
          ({ fingerprints }) => !equal(fingerprints, afterFingerprint),
        )
      )
        differences.push({
          scenario,
          mode,
          phase: "candidate-internal-instability",
          baseline: null,
          candidate: afterFingerprint,
        });
      if (!equal(beforeFingerprint, afterFingerprint))
        differences.push({
          scenario,
          mode,
          phase: "output-fingerprint",
          baseline: beforeFingerprint ?? null,
          candidate: afterFingerprint ?? null,
        });
      const beforeBySample = new Map(
        beforeOutputs.map((sample) => [sample.sampleIndex, sample]),
      );
      const afterBySample = new Map(
        afterOutputs.map((sample) => [sample.sampleIndex, sample]),
      );
      for (const sampleIndex of [
        ...new Set([...beforeBySample.keys(), ...afterBySample.keys()]),
      ].toSorted((left, right) => left - right)) {
        appendSummaryDifferences(
          differences,
          { scenario, mode, phase: "sample-output" },
          beforeBySample.get(sampleIndex) ?? null,
          afterBySample.get(sampleIndex) ?? null,
        );
      }
      for (const phase of performancePhases) {
        const beforeSummaries = before.modes[mode].phases[phase].outputs;
        const afterSummaries = after.modes[mode].phases[phase].outputs;
        const beforeBySample = new Map(
          (Array.isArray(beforeSummaries) ? beforeSummaries : []).flatMap(
            (item) =>
              isRecord(item) && typeof item.sampleIndex === "number"
                ? [[item.sampleIndex, item.summary] as const]
                : [],
          ),
        );
        const afterBySample = new Map(
          (Array.isArray(afterSummaries) ? afterSummaries : []).flatMap(
            (item) =>
              isRecord(item) && typeof item.sampleIndex === "number"
                ? [[item.sampleIndex, item.summary] as const]
                : [],
          ),
        );
        for (const sampleIndex of [
          ...new Set([...beforeBySample.keys(), ...afterBySample.keys()]),
        ].toSorted((left, right) => left - right)) {
          appendSummaryDifferences(
            differences,
            {
              scenario,
              mode,
              phase: `stage-output.sample-${sampleIndex}`,
            },
            beforeBySample.get(sampleIndex) ?? null,
            afterBySample.get(sampleIndex) ?? null,
          );
        }
      }
    }
  }
  return Object.freeze(
    differences.map((difference) => Object.freeze(difference)),
  );
}

function performanceObservations(
  baseline: PerformanceRunReport,
  candidate: PerformanceRunReport,
): PerformanceComparisonReport["performance"]["observations"] {
  const observations: {
    scenario: string;
    mode: PerformanceMemoMode;
    phase: PerformancePhaseName;
    baselineMedianMs: number | null;
    candidateMedianMs: number | null;
    deltaMs: number | null;
    deltaPercent: number | null;
    baselineMedianAbsoluteDeviationMs: number | null;
    candidateMedianAbsoluteDeviationMs: number | null;
  }[] = [];
  for (const [scenario, before] of Object.entries(baseline.scenarios)) {
    const after = candidate.scenarios[scenario];
    if (!after) continue;
    for (const mode of ["no-memo", "empty-scope", "reused-scope"] as const) {
      for (const phase of performancePhases) {
        const beforeValues = before.modes[mode].phases[phase].durationsMs.raw;
        const afterValues = after.modes[mode].phases[phase].durationsMs.raw;
        const beforeMedian = median(beforeValues);
        const afterMedian = median(afterValues);
        const deltaMs =
          beforeMedian === null || afterMedian === null
            ? null
            : afterMedian - beforeMedian;
        observations.push(
          Object.freeze({
            scenario,
            mode,
            phase,
            baselineMedianMs: beforeMedian,
            candidateMedianMs: afterMedian,
            deltaMs,
            deltaPercent:
              deltaMs === null || beforeMedian === null || beforeMedian === 0
                ? null
                : (deltaMs / beforeMedian) * 100,
            baselineMedianAbsoluteDeviationMs:
              before.modes[mode].phases[phase].durationsMs
                .medianAbsoluteDeviation,
            candidateMedianAbsoluteDeviationMs:
              after.modes[mode].phases[phase].durationsMs
                .medianAbsoluteDeviation,
          }),
        );
      }
    }
  }
  return Object.freeze(observations);
}

export function comparePerformanceReports(
  baseline: PerformanceRunReport,
  candidate: PerformanceRunReport,
  intent: ComparisonIntent = "equivalent-output",
): PerformanceComparisonReport {
  const identity = comparisonBlockers(baseline, candidate);
  const outputDifferences = resultDifferences(baseline, candidate);
  const reportsComplete = [baseline, candidate].every(
    (report) =>
      report.status === "passed" &&
      Object.values(report.scenarios).every(
        (scenario) =>
          scenario.execution.status === "passed" &&
          scenario.domain.status === "complete" &&
          scenario.measurementsEligible &&
          scenario.outputEquivalence.withinMode &&
          scenario.outputEquivalence.acrossModes &&
          Object.values(scenario.modes).length === 3 &&
          Object.values(scenario.modes).every(
            (mode) =>
              mode.plannedSamples > 0 &&
              mode.completedSamples === mode.plannedSamples &&
              mode.sampleOutputs.length === mode.plannedSamples &&
              Object.values(mode.phases).every(
                (phase) =>
                  phase.durationsMs.count === mode.plannedSamples &&
                  phase.durationsMs.raw.length === mode.plannedSamples &&
                  Array.isArray(phase.outputs) &&
                  phase.outputs.length === mode.plannedSamples,
              ),
          ),
      ),
  );
  const comparable = identity.blockers.length === 0;
  const outputsDiffer = outputDifferences.some(
    ({ phase }) => phase !== "domain-status",
  );
  const resultStatus = !comparable
    ? "not-comparable"
    : !reportsComplete
      ? "incomplete"
      : outputsDiffer
        ? "different"
        : "equivalent";
  return Object.freeze({
    schemaVersion: 1,
    kind: "performance-comparison",
    createdAt: new Date().toISOString(),
    baselineReport: "",
    candidateReport: "",
    intent,
    comparability: Object.freeze({
      status: comparable ? "comparable" : "not-comparable",
      blockers: identity.blockers,
      versionChanges: identity.versionChanges,
    }),
    resultComparison: Object.freeze({
      status: resultStatus,
      differences: outputDifferences,
    }),
    performance: Object.freeze({
      status: !comparable
        ? "not-comparable"
        : reportsComplete && !(intent === "equivalent-output" && outputsDiffer)
          ? "comparable"
          : "descriptive-only",
      observations: performanceObservations(baseline, candidate),
    }),
  });
}

export function comparisonSummary(report: PerformanceComparisonReport): string {
  const rows = report.performance.observations.map(
    (item) =>
      `| ${item.scenario} | ${item.mode} | ${item.phase} | ${item.baselineMedianMs?.toFixed(2) ?? "未测量"} | ${item.candidateMedianMs?.toFixed(2) ?? "未测量"} | ${item.deltaPercent === null ? "不可计算" : `${item.deltaPercent.toFixed(1)}%`} |`,
  );
  return [
    "# 术语性能报告比较",
    "",
    `- 可比性：${report.comparability.status}`,
    `- 结果：${report.resultComparison.status}`,
    `- 性能数据：${report.performance.status}`,
    `- 比较意图：${report.intent}`,
    `- 基线报告：${report.baselineReport}`,
    `- 候选报告：${report.candidateReport}`,
    "",
    ...(report.comparability.blockers.length
      ? [
          "## 不可比条件",
          "",
          ...report.comparability.blockers.map(
            ({ field, baseline, candidate }) =>
              `- ${field}: ${JSON.stringify(baseline)} → ${JSON.stringify(candidate)}`,
          ),
          "",
        ]
      : []),
    ...(report.comparability.versionChanges.length
      ? [
          "## 版本身份变化",
          "",
          ...report.comparability.versionChanges.map(
            ({ field, baseline, candidate }) =>
              `- ${field}: ${JSON.stringify(baseline)} → ${JSON.stringify(candidate)}`,
          ),
          "",
        ]
      : []),
    ...(report.resultComparison.differences.length
      ? [
          "## 结果差异",
          "",
          ...report.resultComparison.differences.map(
            ({ scenario, mode, phase, field, baseline, candidate }) =>
              `- ${scenario}${mode ? ` / ${mode}` : ""}${phase ? ` / ${phase}` : ""}${field ? ` / ${field}` : ""}: ${JSON.stringify(baseline)} → ${JSON.stringify(candidate)}`,
          ),
          "",
        ]
      : []),
    "| 场景 | Memo 模式 | 阶段 | 基线中位数 ms | 候选中位数 ms | 中位数变化 |",
    "| --- | --- | --- | ---: | ---: | ---: |",
    ...rows,
    "",
    report.intent === "equivalent-output"
      ? "输出不等价时，不得将耗时变化视为语义不变的性能验收通过。"
      : "质量调整允许输出变化；本表只展示耗时差异，不代表质量达标。",
    "没有独立人工标签的精确率、召回率和候选质量继续标为未评估。",
    "",
  ].join("\n");
}

export async function readPerformanceReport(
  filename: string,
): Promise<PerformanceRunReport> {
  const report: unknown = JSON.parse(await readFile(filename, "utf8"));
  if (!isPerformanceRunReport(report))
    throw new Error(`文件不是受支持的术语性能报告：${filename}`);
  return report;
}

export async function runPerformanceComparison(options: {
  readonly baselinePath: string;
  readonly candidatePath: string;
  readonly outputDirectory?: string;
  readonly intent?: ComparisonIntent;
}): Promise<{
  readonly report: PerformanceComparisonReport;
  readonly outputDirectory: string;
}> {
  const baselinePath = path.resolve(options.baselinePath);
  const candidatePath = path.resolve(options.candidatePath);
  const baseline = await readPerformanceReport(baselinePath);
  const candidate = await readPerformanceReport(candidatePath);
  const report = comparePerformanceReports(baseline, candidate, options.intent);
  const outputDirectory =
    options.outputDirectory ??
    defaultRunDirectory(`comparison-${randomUUID()}`);
  await initializeRunDirectory(outputDirectory, path.basename(outputDirectory));
  const reportWithPaths = Object.freeze({
    ...report,
    baselineReport: baselinePath,
    candidateReport: candidatePath,
    comparedSource: await collectSourceIdentity(),
    comparedEnvironment: collectEnvironment(),
  });
  await writeEvaluationReport(
    outputDirectory,
    reportWithPaths,
    comparisonSummary(reportWithPaths),
  );
  return Object.freeze({ report: reportWithPaths, outputDirectory });
}
