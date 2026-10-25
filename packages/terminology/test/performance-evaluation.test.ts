import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  comparePerformanceReports,
  readPerformanceReport,
} from "../scripts/evaluation/performance/compare.ts";
import { distribution } from "../scripts/evaluation/performance/statistics.ts";
import { aggregateModeSamples } from "../scripts/evaluation/performance/statistics.ts";
import type {
  PerformanceRunReport,
  PerformanceScenarioReport,
} from "../scripts/evaluation/performance/types.ts";
import type {
  PerformancePhase,
  PerformanceWorkerResult,
} from "../scripts/evaluation/performance/worker.ts";
import type { PerformanceMemoMode } from "../scripts/evaluation/performance/workload.ts";
import { createControlledPerformanceWorkload } from "../scripts/evaluation/performance/workload.ts";

const modes = ["no-memo", "empty-scope", "reused-scope"] as const;
const phases = [
  "termbaseCreate",
  "compileTerms",
  "analyzeTermUse",
  "assessTermUse",
  "discoverTerms",
  "evaluateTerms",
] as const;

function phase(durationMs: number, fingerprint: string): PerformancePhase {
  const memory = Object.freeze({ ...process.memoryUsage() });
  return Object.freeze({
    durationMs,
    memory: Object.freeze({
      gcBeforeRequested: true,
      before: memory,
      after: memory,
    }),
    output: Object.freeze({ fingerprint }),
    memo: Object.freeze({
      mode: "no-memo",
      prewarmDurationMs: null,
      prewarmOutputSha256: null,
    }),
  });
}

function sample(
  memoMode: PerformanceMemoMode,
  sampleIndex: number,
  outputFingerprint: string,
  analysisMs = 20,
): PerformanceWorkerResult {
  const memory = Object.freeze({ ...process.memoryUsage() });
  const samplePhases = Object.fromEntries(
    phases.map((name) => [
      name,
      phase(name === "analyzeTermUse" ? analysisMs : 10, outputFingerprint),
    ]),
  ) as PerformanceWorkerResult["phases"];
  return Object.freeze({
    schemaVersion: 1,
    scenario: "controlled-scale",
    sampleIndex,
    memoMode,
    publicEntries: Object.freeze({
      terminology: "/repo/packages/terminology/dist/index.js",
      memo: "/repo/packages/memo/dist/index.js",
      textAnalysis: "/repo/packages/text-analysis/dist/index.js",
    }),
    runtimeWarmup: Object.freeze({
      memoMode: "no-memo",
      groups: 2,
      discoveryEntries: 2,
      phases: Object.freeze([
        "analyzeTermUse",
        "assessTermUse",
        "evaluateTerms",
        "discoverTerms",
      ]),
    }),
    facts: Object.freeze({
      comparisonGroups: 10_000,
      concepts: 1_000,
      expressions: 4_000,
      sourceTexts: 10_000,
      targetTexts: 10_000,
      uniqueTexts: 20_000,
      sourceCodepoints: 100,
      targetCodepoints: 100,
      sourceUtf16Units: 100,
      targetUtf16Units: 100,
      hardShapes: Object.freeze({
        regular: 9_750,
        long: 100,
        unicode: 50,
        punctuation: 100,
      }),
    }),
    phases: samplePhases,
    output: Object.freeze({
      status: "complete",
      groupCount: 10_000,
      conceptCount: 1_000,
      expressionCount: 4_000,
      sourceMatches: 10_000,
      targetMatches: 10_000,
      problems: 0,
      assessmentIssues: 0,
      candidateCount: 20,
      discoveryIssues: 0,
      fingerprints: Object.freeze({
        analysis: outputFingerprint,
        assessment: outputFingerprint,
        discovery: outputFingerprint,
        fullEvaluation: outputFingerprint,
      }),
    }),
    memory: Object.freeze({
      processPeakMaxRssBytes: 100_000_000,
      postRelease: memory,
      postReleaseGcRequested: true,
      peakSource: "process.resourceUsage().maxRSS",
      stageObservationSource:
        "process.memoryUsage() before and after each public operation",
    }),
  });
}

function scenario(
  fingerprints: readonly string[],
  analysisTimes: readonly number[],
  domain: PerformanceScenarioReport["domain"]["status"] = "complete",
): PerformanceScenarioReport {
  const attempts = modes.flatMap((memoMode) =>
    fingerprints.map((fingerprint, index) => ({
      sampleIndex: index + 1,
      retryNumber: 1,
      memoMode,
      startedAt: "2026-10-25T00:00:00.000Z",
      finishedAt: "2026-10-25T00:00:00.001Z",
      status: "passed" as const,
      process: Object.freeze({
        status: "passed" as const,
        code: 0,
        signal: null,
        durationMs: 10,
        stdout: "",
        stderr: "",
      }),
      sample: sample(
        memoMode,
        index + 1,
        fingerprint,
        analysisTimes[index] ?? 20,
      ),
    })),
  );
  return Object.freeze({
    id: "controlled-scale",
    execution: Object.freeze({ status: "passed" }),
    domain: Object.freeze({ status: domain }),
    measurementsEligible: domain === "complete",
    input: Object.freeze({
      sha256: "input-sha",
      facts: attempts[0]!.sample.facts,
      generation: Object.freeze({
        algorithm: "lioni-terminology-scale-v1",
        seed: 20_261_025,
        conceptStride: 33,
        groupCount: 10_000,
        conceptCount: 1_000,
        expressionsPerConcept: 4,
        shapeCounts: Object.freeze({
          regular: 9_750,
          long: 100,
          unicode: 50,
          punctuation: 100,
        }),
      }),
    }),
    preparation: Object.freeze({
      durationMs: 20,
      kind: "deterministic-generation",
    }),
    selection: Object.freeze({ en: "all", target: "zh-CN" }),
    policy: Object.freeze({
      matching: Object.freeze({ en: "word", "zh-CN": "literal" }),
    }),
    outputEquivalence: Object.freeze({
      withinMode: true,
      acrossModes: true,
      differences: Object.freeze([]),
    }),
    eligibilityReasons: Object.freeze([]),
    attempts: Object.freeze(attempts),
    modes: Object.freeze(
      Object.fromEntries(
        modes.map((mode) => [
          mode,
          aggregateModeSamples(
            fingerprints.length,
            attempts.flatMap((attempt) =>
              attempt.memoMode === mode && attempt.sample
                ? [attempt.sample]
                : [],
            ),
          ),
        ]),
      ),
    ) as PerformanceScenarioReport["modes"],
    qualityMetrics: Object.freeze({
      precision: Object.freeze({ status: "not-evaluated", basis: "no labels" }),
      recall: Object.freeze({ status: "not-evaluated", basis: "no labels" }),
    }),
  });
}

function report(
  runId: string,
  item: PerformanceScenarioReport,
  overrides: Partial<PerformanceRunReport> = {},
): PerformanceRunReport {
  return Object.freeze({
    schemaVersion: 1,
    kind: "performance",
    runId,
    startedAt: "2026-10-25T00:00:00.000Z",
    finishedAt: "2026-10-25T00:00:00.100Z",
    status: "passed",
    selected: Object.freeze(["controlled-scale"] as const),
    parameters: Object.freeze({
      samplesPerMode: 2,
      runtimeWarmupGroups: 2,
      retries: 0,
      sampleTimeoutMs: 1_000,
      memoModes: modes,
      sourceMode: "built-public-exports",
      rebuildExternalInputs: false,
    }),
    buildPreparation: Object.freeze({
      status: "measured-by-root-turbo",
      command:
        "pnpm exec turbo run build --filter=@lioni/terminology... --force",
      durationMs: 1,
      includedInSamples: false,
    }),
    artifact: Object.freeze({
      package: "@lioni/terminology",
      version: "0.0.0",
      entry: "dist/index.js",
      sha256: "artifact-a",
      files: Object.freeze(["dist/index.js"]),
    }),
    source: Object.freeze({
      commit: "commit-a",
      dirty: false,
      changedFiles: Object.freeze([]),
    }),
    environment: Object.freeze({
      node: "v24.21.0",
      icu: "77.1",
      unicode: "16.0",
      platform: "linux",
      arch: "x64",
      cpuModel: "cpu-a",
      cpuCount: 8,
      totalMemoryBytes: 16_000_000_000,
    }),
    scenarios: Object.freeze({ "controlled-scale": item }),
    ...overrides,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

void describe("术语性能报告契约", () => {
  void it("按固定种子生成相同的独特文本、比较组与表达事实", () => {
    const first = createControlledPerformanceWorkload({
      groupCount: 100,
      conceptCount: 10,
      seed: 20_261_025,
    });
    const second = createControlledPerformanceWorkload({
      groupCount: 100,
      conceptCount: 10,
      seed: 20_261_025,
    });
    assert.equal(first.inputSha256, second.inputSha256);
    assert.equal(first.input.facts.comparisonGroups, 100);
    assert.equal(first.input.facts.concepts, 10);
    assert.equal(first.input.facts.expressions, 40);
    assert.equal(first.input.facts.sourceTexts, 100);
    assert.equal(first.input.facts.targetTexts, 100);
    assert.equal(first.input.facts.uniqueTexts, 200);
    assert.equal(first.input.facts.hardShapes.long, 10);
    assert.equal(first.input.facts.hardShapes.unicode, 5);
    assert.equal(first.input.facts.hardShapes.punctuation, 10);
    assert.equal(first.input.facts.hardShapes.regular, 75);
  });

  void it("按中位数和中位绝对偏差保留重复样本波动", () => {
    const summary = distribution([1, 2, 100]);
    assert.equal(summary.count, 3);
    assert.equal(summary.median, 2);
    assert.equal(summary.medianAbsoluteDeviation, 1);
    assert.deepEqual(summary.raw, [1, 2, 100]);
  });

  void it("相同输入与环境下允许比较新制品，并核对输出", () => {
    const baseline = report("baseline", scenario(["same", "same"], [20, 22]));
    const candidate = report(
      "candidate",
      scenario(["same", "same"], [15, 16]),
      {
        source: Object.freeze({
          commit: "commit-b",
          dirty: false,
          changedFiles: Object.freeze([]),
        }),
        artifact: Object.freeze({
          package: "@lioni/terminology",
          version: "0.0.0",
          entry: "dist/index.js",
          sha256: "artifact-b",
          files: Object.freeze(["dist/index.js"]),
        }),
      },
    );
    const comparison = comparePerformanceReports(baseline, candidate);
    assert.equal(comparison.comparability.status, "comparable");
    assert.equal(comparison.resultComparison.status, "equivalent");
    assert.equal(comparison.performance.status, "comparable");
    assert.ok(
      comparison.comparability.versionChanges.some(
        ({ field }) => field === "artifact.sha256",
      ),
    );
    assert.equal(
      comparison.performance.observations.find(
        ({ mode, phase }) => mode === "no-memo" && phase === "analyzeTermUse",
      )?.deltaMs,
      -5.5,
    );
  });

  void it("输入或环境变化会列出阻断条件，不能写成可比", () => {
    const baseline = report("baseline", scenario(["same"], [20]));
    const candidate = report("candidate", scenario(["same"], [18]), {
      environment: Object.freeze({
        ...baseline.environment,
        platform: "darwin",
      }),
      scenarios: Object.freeze({
        "controlled-scale": Object.freeze({
          ...scenario(["same"], [18]),
          input: Object.freeze({
            ...scenario(["same"], [18]).input!,
            sha256: "different-input",
          }),
        }),
      }),
    });
    const comparison = comparePerformanceReports(baseline, candidate);
    assert.equal(comparison.comparability.status, "not-comparable");
    assert.ok(
      comparison.comparability.blockers.some(
        ({ field }) => field === "environment.platform",
      ),
    );
    assert.ok(
      comparison.comparability.blockers.some(
        ({ field }) => field === "scenarios.controlled-scale.input.sha256",
      ),
    );
    assert.equal(comparison.performance.status, "not-comparable");
  });

  void it("输出改变或领域不完整时不能接受等价优化", () => {
    const baseline = report("baseline", scenario(["same"], [20]));
    const changed = report("changed", scenario(["different"], [10]));
    const changedComparison = comparePerformanceReports(baseline, changed);
    assert.equal(changedComparison.resultComparison.status, "different");
    assert.equal(changedComparison.performance.status, "descriptive-only");

    const incomplete = report(
      "incomplete",
      scenario(["same"], [10], "incomplete"),
    );
    const incompleteComparison = comparePerformanceReports(
      baseline,
      incomplete,
    );
    assert.equal(incompleteComparison.resultComparison.status, "incomplete");
    assert.equal(incompleteComparison.performance.status, "descriptive-only");
  });

  void it("质量调整意图展示差异，但仍受输入与环境可比性约束", () => {
    const baseline = report("baseline", scenario(["before"], [20]));
    const candidate = report("candidate", scenario(["after"], [18]));
    const comparison = comparePerformanceReports(
      baseline,
      candidate,
      "quality-adjustment",
    );
    assert.equal(comparison.comparability.status, "comparable");
    assert.equal(comparison.resultComparison.status, "different");
    assert.equal(comparison.performance.status, "comparable");
  });

  void it("两份旧报告共同缺少输入、政策或环境依据时仍明确不可比", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "lioni-performance-compare-"),
    );
    try {
      const legacy: unknown = JSON.parse(
        JSON.stringify(report("legacy", scenario(["same"], [20]))),
      );
      assert.ok(isRecord(legacy));
      const environment = legacy["environment"];
      const parameters = legacy["parameters"];
      const scenarios = legacy["scenarios"];
      assert.ok(isRecord(environment));
      assert.ok(isRecord(parameters));
      assert.ok(isRecord(scenarios));
      const controlled = scenarios["controlled-scale"];
      assert.ok(isRecord(controlled));
      const input = controlled["input"];
      assert.ok(isRecord(input));
      delete environment["icu"];
      delete environment["cpuModel"];
      delete parameters["runtimeWarmupGroups"];
      delete input["sha256"];
      delete controlled["policy"];

      const baselinePath = path.join(directory, "baseline.json");
      const candidatePath = path.join(directory, "candidate.json");
      await writeFile(baselinePath, JSON.stringify(legacy), "utf8");
      await writeFile(candidatePath, JSON.stringify(legacy), "utf8");
      const [baseline, candidate] = await Promise.all([
        readPerformanceReport(baselinePath),
        readPerformanceReport(candidatePath),
      ]);
      const comparison = comparePerformanceReports(baseline, candidate);
      assert.equal(comparison.comparability.status, "not-comparable");
      for (const field of [
        "missing-required-evidence.environment.icu",
        "missing-required-evidence.environment.cpuModel",
        "missing-required-evidence.parameters.runtimeWarmupGroups",
        "missing-required-evidence.scenarios.controlled-scale.input.sha256",
        "missing-required-evidence.scenarios.controlled-scale.policy",
      ])
        assert.ok(
          comparison.comparability.blockers.some(
            (item) => item.field === field,
          ),
        );
      assert.equal(comparison.resultComparison.status, "not-comparable");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
