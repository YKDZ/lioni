import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { cpus, release } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  analyzeQuality,
  createQualityProfiler,
  defineConfig,
  defineQualityCheck,
  type JsonValue,
  type QualityCheckOutcome,
  type QualityCheckResultCache,
  type QualityObject,
  type QualityProfileReport,
  type QualityRunResult,
} from "@lioni/lioni";
import { z } from "zod";

type CacheMode = "cold" | "warm";
type MeasurementMode = "timing" | "allocation";
type WorkloadFamily = "ordinary" | "shared-dependency" | "diagnostic-evidence";
type WorkloadAxis =
  | "candidate-count"
  | "check-count"
  | "basis-bytes"
  | "shared-dependency"
  | "diagnostic-evidence";

type Workload = {
  readonly id: string;
  readonly family: WorkloadFamily;
  readonly axis: WorkloadAxis;
  readonly candidateCount: number;
  readonly checkCount: number;
  readonly basisTargetBytes: number;
  readonly diagnosticEvidenceTargetBytes: number;
  readonly cacheMode: CacheMode;
};

type JsonPayload = {
  readonly records: readonly { readonly key: string; readonly value: string }[];
};
type CacheValue = NonNullable<
  Awaited<ReturnType<QualityCheckResultCache["get"]>>
>;

type HeapProfileNode = {
  readonly callFrame: {
    readonly functionName: string;
    readonly url: string;
    readonly lineNumber: number;
  };
  readonly selfSize: number;
  readonly children: readonly HeapProfileNode[];
};

type QualityResultSummary = {
  readonly sha256: string;
  readonly jsonBytes: number;
  readonly status: string;
  readonly candidateCount: number;
  readonly diagnosticCount: number;
  readonly diagnosticEvidenceCount: number;
  readonly diagnosticEvidenceJsonBytes: number;
  readonly factCoverage: {
    readonly sourceStatus: string;
    readonly translationReadCount: number;
    readonly associationCount: number;
  };
  readonly checks: readonly {
    readonly checkId: string;
    readonly status: string;
    readonly coverage: QualityRunResult["checks"][number]["coverage"];
    readonly diagnosticCount: number;
    readonly issueCount: number;
    readonly executionCount: number;
  }[];
};

const repetitions = 5;
const allocationSamplingIntervalBytes = 1024;
const payloadRecordValue = "x".repeat(64);
const unitSchema = z.object({ source: z.string() });
const translationSchema = z.object({ id: z.string() });
const contentSchema = z.string();
const configurationSchema = z.object({}).strict();
type Unit = z.output<typeof unitSchema>;

function createPayload(targetBytes: number, prefix: string): JsonPayload {
  const count = Math.max(1, Math.ceil(targetBytes / 88));
  return {
    records: Array.from({ length: count }, (_, index) => ({
      key: `${prefix}-${index}`,
      value: payloadRecordValue,
    })),
  };
}

function payloadBytes(payload: JsonPayload): number {
  return Buffer.byteLength(JSON.stringify(payload));
}

function ordinaryWorkloads(): Workload[] {
  // 每组只改变一个负载维度；事实读取与无诊断检查保持固定。
  const dimensions: Omit<Workload, "id" | "cacheMode">[] = [
    ...[16, 64, 256].map((candidateCount) => ({
      family: "ordinary" as const,
      axis: "candidate-count" as const,
      candidateCount,
      checkCount: 1,
      basisTargetBytes: 128,
      diagnosticEvidenceTargetBytes: 0,
    })),
    ...[1, 4, 12].map((checkCount) => ({
      family: "ordinary" as const,
      axis: "check-count" as const,
      candidateCount: 32,
      checkCount,
      basisTargetBytes: 128,
      diagnosticEvidenceTargetBytes: 0,
    })),
    ...[128, 4096, 32768].map((basisTargetBytes) => ({
      family: "ordinary" as const,
      axis: "basis-bytes" as const,
      candidateCount: 16,
      checkCount: 1,
      basisTargetBytes,
      diagnosticEvidenceTargetBytes: 0,
    })),
    {
      family: "shared-dependency",
      axis: "shared-dependency",
      candidateCount: 32,
      checkCount: 1,
      basisTargetBytes: 32768,
      diagnosticEvidenceTargetBytes: 0,
    },
    {
      family: "diagnostic-evidence",
      axis: "diagnostic-evidence",
      candidateCount: 32,
      checkCount: 1,
      basisTargetBytes: 128,
      diagnosticEvidenceTargetBytes: 16384,
    },
  ];

  return dimensions.flatMap((dimension, index) =>
    (["cold", "warm"] as const).map((cacheMode) => ({
      ...dimension,
      cacheMode,
      id: `${dimension.axis}-${index + 1}-${cacheMode}`,
    })),
  );
}

function emptyOutcome(): QualityCheckOutcome {
  return {
    status: "complete",
    diagnostics: [],
    issues: [],
    coverage: {
      selected: 1,
      evaluated: 1,
      notApplicable: 0,
      incomplete: 0,
      failed: 0,
    },
  };
}

function createConfig(
  workload: Workload,
  cache: QualityCheckResultCache,
  basisPayload: JsonPayload,
  dependencyPayload: JsonPayload,
  evidencePayload: JsonPayload | undefined,
  ruleExecutions: { count: number },
) {
  const checks = Array.from({ length: workload.checkCount }, (_, index) =>
    defineQualityCheck<
      Unit,
      unknown,
      typeof configurationSchema,
      QualityObject,
      string,
      never
    >({
      id: `artifact-cost-check-${index + 1}`,
      version: "artifact-cost-v1",
      configurationSchema,
      configuration: {},
      fingerprintInput: ({ candidate, dependencies }) => ({
        candidate,
        payload:
          workload.family === "shared-dependency"
            ? (dependencies as JsonPayload as JsonValue)
            : (basisPayload as JsonValue),
      }),
      check: ({ candidate, dependencies }) => {
        ruleExecutions.count++;
        assert.equal(
          (dependencies as JsonPayload).records.length,
          dependencyPayload.records.length,
        );
        if (evidencePayload === undefined) return emptyOutcome();

        const object = {
          kind: "translation-unit",
          key: candidate.sourceKey,
          language: candidate.language,
        };
        const location = { language: candidate.language, range: "memory" };
        return {
          status: "complete",
          diagnostics: [
            {
              severity: "warning",
              object,
              location,
              message: "固定诊断依据负载",
              evidence: [
                { role: "input", object, location, value: evidencePayload },
              ],
            },
          ],
          issues: [],
          coverage: {
            selected: 1,
            evaluated: 1,
            notApplicable: 0,
            incomplete: 0,
            failed: 0,
          },
        };
      },
    }),
  );

  return defineConfig({
    source: {
      schema: unitSchema,
      read: () => ({
        scopes: [
          {
            range: "memory",
            enumeration: "complete",
            records: [
              { value: { source: "in-memory" }, bodyAvailability: "available" },
            ],
          },
        ],
      }),
    },
    keyOf: () => "memory-fact",
    translations: {
      languages: [],
      schema: translationSchema,
      contentSchema,
      contentOf: () => "unused",
      keyOf: ({ id }) => ({ namespace: "artifact", key: id }),
      read: () => ({ scopes: [] }),
      matches: () => true,
    },
    quality: {
      checks,
      loadDependencies: () => dependencyPayload,
      resultCache: cache,
    },
  });
}

function createCache(): {
  readonly cache: QualityCheckResultCache;
  readonly entries: Map<string, CacheValue>;
} {
  const entries = new Map<string, CacheValue>();
  return {
    entries,
    cache: {
      get: async (key) => entries.get(key),
      set: async (key, outcome) => {
        entries.set(key, outcome);
      },
    },
  };
}

function summarizeAllocation(profile: { readonly head: HeapProfileNode }): {
  readonly sampledBytes: number;
  readonly productStackSampledBytes: number;
  readonly snapshotJsonValueStackSampledBytes: number;
  readonly qualityInputSnapshotStackSampledBytes: number;
  readonly topFrames: readonly {
    readonly frame: string;
    readonly sampledBytes: number;
  }[];
} {
  const frames = new Map<string, number>();
  let sampledBytes = 0;
  let productStackSampledBytes = 0;
  let snapshotJsonValueStackSampledBytes = 0;
  let qualityInputSnapshotStackSampledBytes = 0;
  function visit(node: HeapProfileNode, ancestors: readonly string[]): void {
    sampledBytes += node.selfSize;
    const { callFrame } = node;
    const name = callFrame.functionName || "<anonymous>";
    const frame = `${name} (${callFrame.url}:${callFrame.lineNumber + 1})`;
    const stack = [...ancestors, frame].slice(-6).reverse().join(" <- ");
    if (stack.includes("/node_modules/@lioni/lioni/"))
      productStackSampledBytes += node.selfSize;
    if (stack.includes("snapshotJsonValue"))
      snapshotJsonValueStackSampledBytes += node.selfSize;
    if (
      stack.includes("prepareQualityInput") &&
      stack.includes("snapshotJsonValue")
    )
      qualityInputSnapshotStackSampledBytes += node.selfSize;
    if (node.selfSize > 0) {
      frames.set(stack, (frames.get(stack) ?? 0) + node.selfSize);
    }
    for (const child of node.children) visit(child, [...ancestors, frame]);
  }
  visit(profile.head, []);
  return {
    sampledBytes,
    productStackSampledBytes,
    snapshotJsonValueStackSampledBytes,
    qualityInputSnapshotStackSampledBytes,
    topFrames: [...frames]
      .map(([frame, bytes]) => ({ frame, sampledBytes: bytes }))
      .sort((left, right) => right.sampledBytes - left.sampledBytes)
      .slice(0, 12),
  };
}

function summarizeProfiler(report: QualityProfileReport) {
  // 同级阶段分别汇总；不把包含子阶段的父层耗时重复相加。
  const duration = (stage: string) =>
    report.checks.reduce(
      (total, check) =>
        total +
        (check.timings.find((timing) => timing.stage === stage)?.durationMs ??
          0),
      0,
    );
  const prepareInputMs = duration("prepareInput");
  const fingerprintMs = duration("fingerprint");
  return {
    totalMs: report.totalMs,
    prepareInputMs,
    fingerprintMs,
    prepareAndFingerprintMs: prepareInputMs + fingerprintMs,
    cacheReadMs: duration("cacheRead"),
    executeMs: duration("execute"),
    snapshotMs: duration("snapshot"),
    cacheWriteMs: duration("cacheWrite"),
    resultsMs: duration("results"),
    candidates: report.checks.reduce(
      (total, check) => total + check.candidateCount,
      0,
    ),
    executedRules: report.checks.reduce(
      (total, check) => total + check.executedRules,
      0,
    ),
    cacheHits: report.checks.reduce(
      (total, check) => total + check.cache.reads.hit,
      0,
    ),
    cacheMisses: report.checks.reduce(
      (total, check) => total + check.cache.reads.miss,
      0,
    ),
    cacheWrites: report.checks.reduce(
      (total, check) => total + check.cache.writes.completed,
      0,
    ),
  };
}

function summarizeQualityResult<TBody>(
  result: QualityRunResult<QualityObject, TBody>,
): QualityResultSummary {
  const serialized = JSON.stringify(result);
  assert.ok(serialized !== undefined);
  const evidence = result.diagnostics.flatMap(
    (diagnostic) => diagnostic.evidence,
  );
  return {
    sha256: createHash("sha256").update(serialized).digest("hex"),
    jsonBytes: Buffer.byteLength(serialized),
    status: result.status,
    candidateCount: result.candidates.length,
    diagnosticCount: result.diagnostics.length,
    diagnosticEvidenceCount: evidence.length,
    diagnosticEvidenceJsonBytes: Buffer.byteLength(JSON.stringify(evidence)),
    factCoverage: {
      sourceStatus: result.factCoverage.source.status,
      translationReadCount: result.factCoverage.translations.length,
      associationCount: result.factCoverage.associations.length,
    },
    checks: result.checks.map((check) => ({
      checkId: check.checkId,
      status: check.status,
      coverage: check.coverage,
      diagnosticCount: check.diagnostics.length,
      issueCount: check.issues.length,
      executionCount: check.executions.length,
    })),
  };
}

async function runWorker(): Promise<void> {
  const workloadJson = process.argv[3];
  const measurementMode = process.argv[4];
  assert.ok(workloadJson, "工作负载参数缺失。");
  assert.ok(
    measurementMode === "timing" || measurementMode === "allocation",
    "测量模式必须是 timing 或 allocation。",
  );
  const workload = JSON.parse(workloadJson) as Workload;
  const basisPayload = createPayload(workload.basisTargetBytes, "basis");
  const dependencyPayload = createPayload(
    workload.family === "shared-dependency" ? 32768 : 128,
    "dependency",
  );
  const evidencePayload =
    workload.diagnosticEvidenceTargetBytes === 0
      ? undefined
      : createPayload(workload.diagnosticEvidenceTargetBytes, "evidence");
  const { cache } = createCache();
  const ruleExecutions = { count: 0 };
  const config = createConfig(
    workload,
    cache,
    basisPayload,
    dependencyPayload,
    evidencePayload,
    ruleExecutions,
  );
  const candidates = Array.from(
    { length: workload.candidateCount },
    (_, index) => ({
      sourceKey: `candidate-${index}`,
      language: "en",
      content: `translation-${index}`,
    }),
  );

  const expectedExecutions = workload.candidateCount * workload.checkCount;
  if (workload.cacheMode === "warm") {
    const warmed = await analyzeQuality(config, { candidates });
    assert.equal(
      warmed.checks.reduce(
        (total, check) => total + check.executions.length,
        0,
      ),
      expectedExecutions,
    );
    ruleExecutions.count = 0;
  }

  const forceGarbageCollection = (
    globalThis as typeof globalThis & { gc?: () => void }
  ).gc;
  assert.ok(forceGarbageCollection, "性能样本需要通过 --expose-gc 启动。");
  forceGarbageCollection();

  const profiler =
    measurementMode === "allocation"
      ? createQualityProfiler({ slowestCandidates: 0 })
      : undefined;
  const session = measurementMode === "allocation" ? new Session() : undefined;
  let sampledAllocation: ReturnType<typeof summarizeAllocation> | undefined;
  try {
    if (session !== undefined) {
      session.connect();
      await session.post("HeapProfiler.startSampling", {
        samplingInterval: allocationSamplingIntervalBytes,
      });
    }
    const heapUsedBefore = process.memoryUsage().heapUsed;
    const cpuBefore = process.resourceUsage();
    const started = performance.now();
    const result = await analyzeQuality(config, {
      candidates,
      ...(profiler === undefined ? {} : { profiler }),
    });
    const elapsedMs = performance.now() - started;
    const cpuAfter = process.resourceUsage();
    const heapUsedAfter = process.memoryUsage().heapUsed;
    if (session !== undefined) {
      const stopped = await session.post("HeapProfiler.stopSampling");
      sampledAllocation = summarizeAllocation(stopped.profile);
      assert.ok(
        sampledAllocation.sampledBytes > 0,
        "分配采样没有捕获到任何分配。",
      );
    }

    const executions = result.checks.flatMap((check) => check.executions);
    const expectedDiagnostics =
      evidencePayload === undefined ? 0 : expectedExecutions;
    assert.equal(
      result.status,
      "complete",
      JSON.stringify(result.checks.map(({ issues }) => issues)),
    );
    assert.equal(result.checks.length, workload.checkCount);
    assert.equal(executions.length, expectedExecutions);
    assert.ok(
      result.checks.every(
        (check) => check.coverage.evaluated === workload.candidateCount,
      ),
    );
    assert.equal(result.diagnostics.length, expectedDiagnostics);
    assert.ok(
      executions.every(
        ({ inputFingerprint }) => inputFingerprint !== undefined,
      ),
    );
    assert.equal(
      ruleExecutions.count,
      workload.cacheMode === "cold" ? expectedExecutions : 0,
    );
    const resultProfiler = profiler?.report();
    const profilerSummary =
      resultProfiler === undefined
        ? undefined
        : summarizeProfiler(resultProfiler);
    if (profilerSummary !== undefined) {
      assert.equal(profilerSummary.candidates, expectedExecutions);
      assert.equal(
        profilerSummary.cacheHits,
        workload.cacheMode === "warm" ? expectedExecutions : 0,
      );
      assert.equal(
        profilerSummary.cacheMisses,
        workload.cacheMode === "cold" ? expectedExecutions : 0,
      );
      assert.equal(
        profilerSummary.cacheWrites,
        workload.cacheMode === "cold" ? expectedExecutions : 0,
      );
    }
    const fingerprintDigest = createHash("sha256")
      .update(
        executions.map(({ inputFingerprint }) => inputFingerprint).join("\n"),
      )
      .digest("hex");
    // 完整结果摘要在计时与分配采样结束后计算，不计入 QA 成本窗口。
    const resultSummary = summarizeQualityResult(result);
    process.stdout.write(
      `${JSON.stringify({
        workload,
        measurementMode,
        elapsedMs,
        cpuUserMs: (cpuAfter.userCPUTime - cpuBefore.userCPUTime) / 1000,
        cpuSystemMs: (cpuAfter.systemCPUTime - cpuBefore.systemCPUTime) / 1000,
        heapDeltaBytes: heapUsedAfter - heapUsedBefore,
        basisPayloadBytes: payloadBytes(basisPayload),
        dependencyPayloadBytes: payloadBytes(dependencyPayload),
        diagnosticEvidenceBytes:
          evidencePayload === undefined ? 0 : payloadBytes(evidencePayload),
        diagnosticResultBytes: Buffer.byteLength(
          JSON.stringify(result.diagnostics),
        ),
        fingerprintDigest,
        resultSummary,
        ...(profilerSummary === undefined ? {} : { profiler: profilerSummary }),
        ...(sampledAllocation === undefined
          ? {}
          : {
              allocation: {
                samplingIntervalBytes: allocationSamplingIntervalBytes,
                ...sampledAllocation,
              },
            }),
      })}\n`,
    );
  } finally {
    session?.disconnect();
  }
}

function median(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  const lower = ordered[middle - 1];
  const upper = ordered[middle];
  assert.ok(lower !== undefined && upper !== undefined);
  return ordered.length % 2 === 0 ? (lower + upper) / 2 : upper;
}

function aggregateSamples(
  samples: readonly Record<string, unknown>[],
  measurementMode: MeasurementMode,
) {
  const measuredNumbers = (field: string) =>
    samples.map((sample) => sample[field] as number);
  const allocationSamples = samples.map(
    (sample) =>
      sample.allocation as
        | {
            readonly sampledBytes: number;
            readonly productStackSampledBytes: number;
            readonly snapshotJsonValueStackSampledBytes: number;
            readonly qualityInputSnapshotStackSampledBytes: number;
            readonly topFrames: readonly {
              readonly frame: string;
              readonly sampledBytes: number;
            }[];
          }
        | undefined,
  );
  const topFrames = new Map<string, number>();
  for (const allocation of allocationSamples)
    for (const frame of allocation?.topFrames ?? [])
      topFrames.set(
        frame.frame,
        (topFrames.get(frame.frame) ?? 0) + frame.sampledBytes,
      );
  const result: Record<string, unknown> = {
    samples,
    medianElapsedMs: median(measuredNumbers("elapsedMs")),
    medianCpuUserMs: median(measuredNumbers("cpuUserMs")),
    medianCpuSystemMs: median(measuredNumbers("cpuSystemMs")),
    medianHeapDeltaBytes: median(measuredNumbers("heapDeltaBytes")),
  };
  if (measurementMode === "allocation") {
    result.medianSampledAllocationBytes = median(
      allocationSamples.map((allocation) => allocation?.sampledBytes ?? 0),
    );
    result.medianProductStackSampledBytes = median(
      allocationSamples.map(
        (allocation) => allocation?.productStackSampledBytes ?? 0,
      ),
    );
    result.medianSnapshotJsonValueStackSampledBytes = median(
      allocationSamples.map(
        (allocation) => allocation?.snapshotJsonValueStackSampledBytes ?? 0,
      ),
    );
    result.medianQualityInputSnapshotStackSampledBytes = median(
      allocationSamples.map(
        (allocation) => allocation?.qualityInputSnapshotStackSampledBytes ?? 0,
      ),
    );
    result.topAllocatingFrames = [...topFrames]
      .map(([frame, sampledBytes]) => ({ frame, sampledBytes }))
      .sort((left, right) => right.sampledBytes - left.sampledBytes)
      .slice(0, 12);
    result.profiler = samples.map((sample) => sample.profiler);
  }
  return result;
}

function summarizeRepeatedQualityResults(
  samples: readonly Record<string, unknown>[],
): QualityResultSummary & { readonly matchingSamples: number } {
  const summaries = samples.map((sample) => {
    const summary = sample.resultSummary as QualityResultSummary | undefined;
    assert.ok(summary, "性能样本缺少完整 QA 结果摘要。");
    return summary;
  });
  const first = summaries[0];
  assert.ok(first !== undefined);
  assert.ok(
    summaries.every((summary) => summary.sha256 === first.sha256),
    "同一固定负载的重复进程产生了不同 QA 结果。",
  );
  return { ...first, matchingSamples: summaries.length };
}

function assertAllocationScalingBudgets(
  reports: readonly Record<string, unknown>[],
): void {
  const coldRows = reports
    .map((report) => ({
      report,
      workload: report.workload as Workload,
      allocation: report.allocation as {
        readonly medianSampledAllocationBytes: number;
        readonly medianProductStackSampledBytes: number;
        readonly medianSnapshotJsonValueStackSampledBytes: number;
        readonly medianQualityInputSnapshotStackSampledBytes: number;
      },
      basisPayloadBytes: report.basisPayloadBytes as number,
    }))
    .filter(({ workload }) => workload.cacheMode === "cold");
  const findAxisRows = (axis: WorkloadAxis) =>
    coldRows
      .filter(({ workload }) => workload.axis === axis)
      .sort((left, right) => {
        const leftScale =
          axis === "candidate-count"
            ? left.workload.candidateCount
            : axis === "check-count"
              ? left.workload.checkCount
              : left.basisPayloadBytes;
        const rightScale =
          axis === "candidate-count"
            ? right.workload.candidateCount
            : axis === "check-count"
              ? right.workload.checkCount
              : right.basisPayloadBytes;
        return leftScale - rightScale;
      });
  const assertPerUnitAllocation = (
    axis: WorkloadAxis,
    unitsFor: (row: (typeof coldRows)[number]) => number,
  ) => {
    const rows = findAxisRows(axis);
    const smallest = rows[0];
    const largest = rows.at(-1);
    assert.ok(smallest !== undefined && largest !== undefined);
    const smallestBytes =
      smallest.allocation.medianProductStackSampledBytes / unitsFor(smallest);
    const largestBytes =
      largest.allocation.medianProductStackSampledBytes / unitsFor(largest);
    assert.ok(smallestBytes > 0 && largestBytes > 0);
    assert.ok(
      largestBytes <= smallestBytes * 4,
      `${axis} 每单位分配样本放大超过 4 倍：` +
        `${smallestBytes.toFixed(1)} → ${largestBytes.toFixed(1)} bytes/unit`,
    );
  };

  // 新进程分配采样按实际处理单位归一化，允许噪声余量并拦截规模放大。
  assertPerUnitAllocation(
    "candidate-count",
    ({ workload }) => workload.candidateCount * workload.checkCount,
  );
  assertPerUnitAllocation(
    "check-count",
    ({ workload }) => workload.candidateCount * workload.checkCount,
  );
  assertPerUnitAllocation(
    "basis-bytes",
    ({ workload, basisPayloadBytes }) =>
      workload.candidateCount * workload.checkCount * basisPayloadBytes,
  );

  // 大依据场景中若重新通过 JSON 快照函数复制整份依据，采样分配会显著越过半份依据。
  const largeBasis = findAxisRows("basis-bytes").at(-1);
  assert.ok(largeBasis !== undefined);
  assert.ok(
    largeBasis.allocation.medianSnapshotJsonValueStackSampledBytes <
      largeBasis.basisPayloadBytes / 2,
    "大依据场景重新出现了输入规模的 JSON 快照分配。",
  );
  assert.equal(
    largeBasis.allocation.medianQualityInputSnapshotStackSampledBytes,
    0,
    "输入指纹准备阶段不应再次通过 JSON 快照函数复制依据。",
  );
}

async function runBenchmark(): Promise<void> {
  const runRoot = process.env.LIONI_ARTIFACT_RUN_ROOT;
  assert.ok(runRoot, "请通过正式制品验收运行负载。");
  const artifacts = JSON.parse(
    await readFile(path.join(runRoot, "artifacts.json"), "utf8"),
  ) as readonly { readonly name: string; readonly filename: string }[];
  const artifact = artifacts.find(({ name }) => name === "@lioni/lioni");
  assert.ok(artifact, "缺少本次正式产品 tarball。");
  const packageRoot = path.join(process.cwd(), "node_modules");
  const artifactDigest = createHash("sha256")
    .update(await readFile(artifact.filename))
    .digest("hex");
  const packageMetadataPath = path.join(
    packageRoot,
    "@lioni",
    "lioni",
    "package.json",
  );
  const packageMetadata = JSON.parse(
    await readFile(packageMetadataPath, "utf8"),
  ) as { readonly version: string };
  const workloads = ordinaryWorkloads();
  const reports: Record<string, unknown>[] = [];
  const scriptPath = fileURLToPath(import.meta.url);

  for (const workload of workloads) {
    const timingSamples: Record<string, unknown>[] = [];
    const allocationSamples: Record<string, unknown>[] = [];
    for (let repetition = 0; repetition < repetitions; repetition++) {
      // 计时和分配采样使用独立新进程，避免采样器改变纯计时结果。
      for (const mode of ["timing", "allocation"] as const) {
        const result = await runSubprocessForSample(scriptPath, workload, mode);
        assert.equal(
          result.status,
          0,
          result.error?.message || result.stderr || result.stdout,
        );
        const sampleLine = result.stdout.trim().split("\n").at(-1);
        assert.ok(sampleLine, "子进程未输出性能样本。");
        const sample = JSON.parse(sampleLine) as Record<string, unknown>;
        assert.equal((sample.workload as Workload).id, workload.id);
        if (mode === "timing") timingSamples.push(sample);
        else allocationSamples.push(sample);
      }
    }
    reports.push({
      workload,
      basisPayloadBytes: timingSamples[0]?.basisPayloadBytes,
      dependencyPayloadBytes: timingSamples[0]?.dependencyPayloadBytes,
      diagnosticEvidenceBytes: timingSamples[0]?.diagnosticEvidenceBytes,
      diagnosticResultBytes: timingSamples[0]?.diagnosticResultBytes,
      fingerprintDigest: timingSamples[0]?.fingerprintDigest,
      resultSummary: summarizeRepeatedQualityResults([
        ...timingSamples,
        ...allocationSamples,
      ]),
      timing: aggregateSamples(timingSamples, "timing"),
      allocation: aggregateSamples(allocationSamples, "allocation"),
    });
  }

  const report = {
    schemaVersion: 1,
    artifact: {
      package: "@lioni/lioni",
      version: packageMetadata.version,
      sourceRevision: process.env.LIONI_ARTIFACT_SOURCE_REVISION ?? "unknown",
      sha256: artifactDigest,
    },
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      osRelease: release(),
      cpu: cpus()[0]?.model ?? "unknown",
    },
    method: {
      repetitions,
      worker: "independent Node process per sample",
      allocationSampler: "V8 Inspector HeapProfiler sampling",
      allocationSamplingIntervalBytes,
      facts: "one in-memory source fact; no translation reads",
      resultCache: "in-memory Map using public QA cache contract",
      allocationGates:
        "按工作单位归一化的产品栈采样分配不得超过小规模的4倍；输入准备阶段不得通过 JSON 快照栈复制依据",
    },
    workloads: reports,
  };
  const evidencePath = path.join(runRoot, "qa-preparation-performance.json");
  await writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`QA 性能证据：${evidencePath}\n`);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  // 基线可能因旧复制路径未通过门禁；先落盘原始采样，仍可复核失败原因。
  assertAllocationScalingBudgets(reports);
}

async function runSubprocessForSample(
  scriptPath: string,
  workload: Workload,
  mode: MeasurementMode,
) {
  const result = spawnSync(
    process.execPath,
    ["--expose-gc", scriptPath, "--worker", JSON.stringify(workload), mode],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      timeout: 10 * 60 * 1000,
    },
  );
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error,
  };
}

if (process.argv[2] === "--worker") await runWorker();
else await runBenchmark();
