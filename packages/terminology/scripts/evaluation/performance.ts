import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { summarizeMeasurements } from "./performance/statistics.ts";
import type {
  PerformanceAttempt,
  PerformanceModeReport,
  PerformanceReport,
  PerformanceScaleReport,
  PerformanceWorkerResult,
} from "./performance/types.ts";
import {
  createControlledPerformanceWorkload,
  type PerformanceMemoMode,
} from "./performance/workload.ts";
import { writeJsonAtomic } from "./support/json.ts";
import { runProcess } from "./support/process.ts";

const modes = ["no-memo", "new-scope", "reused-scope"] as const;
const scales = [
  { comparisonGroups: 1_000, concepts: 100 },
  { comparisonGroups: 10_000, concepts: 1_000 },
] as const;
const samplesPerMode = 5;
const defaultTimeoutMs = 30 * 60 * 1_000;
const seed = 20_261_025;
const packageRoot = path.resolve(import.meta.dirname, "../..");
const workerPath = fileURLToPath(
  new URL("./performance/worker.ts", import.meta.url),
);

type ScaleState = {
  readonly comparisonGroups: number;
  readonly concepts: number;
  readonly inputSha256: string;
  readonly inputPath: string;
  readonly facts: PerformanceWorkerResult["inputFacts"];
  readonly attempts: Record<PerformanceMemoMode, PerformanceAttempt[]>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWorkerResult(value: unknown): value is PerformanceWorkerResult {
  if (!isRecord(value)) return false;
  const timings = value["timingsMs"];
  const results = value["results"];
  const discovery = isRecord(results) ? results["discovery"] : undefined;
  const evaluation = isRecord(results) ? results["evaluation"] : undefined;
  return (
    typeof value["comparisonGroups"] === "number" &&
    typeof value["concepts"] === "number" &&
    typeof value["memoMode"] === "string" &&
    typeof value["sample"] === "number" &&
    isRecord(timings) &&
    typeof timings["discoverTerms"] === "number" &&
    typeof timings["evaluateTerms"] === "number" &&
    isRecord(discovery) &&
    typeof discovery["sha256"] === "string" &&
    isRecord(evaluation) &&
    typeof evaluation["sha256"] === "string" &&
    typeof value["lifecycleMaxRssBytes"] === "number" &&
    typeof value["publicEntry"] === "string" &&
    isRecord(value["inputFacts"])
  );
}

function outputAttempts(state: ScaleState): readonly {
  readonly mode: PerformanceMemoMode;
  readonly sample: number;
  readonly discoverySha256: string;
  readonly evaluationSha256: string;
}[] {
  return modes.flatMap((mode) =>
    state.attempts[mode].flatMap(({ result, sample }) =>
      result === undefined
        ? []
        : [
            {
              mode,
              sample,
              discoverySha256: result.results.discovery.sha256,
              evaluationSha256: result.results.evaluation.sha256,
            },
          ],
    ),
  );
}

function scaleReport(state: ScaleState): PerformanceScaleReport {
  const outputs = outputAttempts(state);
  const reference = outputs[0];
  const differences = reference
    ? outputs.filter(
        (output) =>
          output.discoverySha256 !== reference.discoverySha256 ||
          output.evaluationSha256 !== reference.evaluationSha256,
      )
    : [];
  const complete = modes.every(
    (mode) =>
      state.attempts[mode].length === samplesPerMode &&
      state.attempts[mode].every(({ status }) => status === "passed"),
  );
  const outputConsistency: PerformanceScaleReport["outputConsistency"] = {
    status:
      differences.length > 0
        ? "different"
        : complete
          ? "verified"
          : "not-verified",
    ...(reference === undefined
      ? {}
      : {
          reference: {
            discoverySha256: reference.discoverySha256,
            evaluationSha256: reference.evaluationSha256,
          },
        }),
    differences,
  };

  const modeReport = (mode: PerformanceMemoMode): PerformanceModeReport => {
    const attempts = state.attempts[mode];
    const results = attempts.flatMap((attempt) =>
      attempt.result === undefined ? [] : [attempt.result],
    );
    const hasFailure = attempts.some(
      ({ status }) =>
        status === "failed" ||
        status === "timed-out" ||
        status === "invalid-output",
    );
    const interrupted = attempts.some(({ status }) => status === "interrupted");
    const status: PerformanceModeReport["status"] = hasFailure
      ? "failed"
      : interrupted
        ? "interrupted"
        : results.length === samplesPerMode
          ? "passed"
          : attempts.length > 0
            ? "interrupted"
            : "not-run";
    return {
      status,
      plannedSamples: samplesPerMode,
      completedSamples: results.length,
      attempts,
      summary: {
        discoverTermsMs: summarizeMeasurements(
          results.map(({ timingsMs }) => timingsMs.discoverTerms),
        ),
        evaluateTermsMs: summarizeMeasurements(
          results.map(({ timingsMs }) => timingsMs.evaluateTerms),
        ),
        lifecycleMaxRssBytes: summarizeMeasurements(
          results.map(({ lifecycleMaxRssBytes }) => lifecycleMaxRssBytes),
        ),
      },
    };
  };

  return {
    comparisonGroups: state.comparisonGroups,
    concepts: state.concepts,
    inputSha256: state.inputSha256,
    seed,
    facts: state.facts,
    outputConsistency,
    modes: {
      "no-memo": modeReport("no-memo"),
      "new-scope": modeReport("new-scope"),
      "reused-scope": modeReport("reused-scope"),
    },
  };
}

function reportSnapshot(
  states: readonly ScaleState[],
  status: PerformanceReport["status"],
  startedAt: string,
  finishedAt: string | null,
): PerformanceReport {
  const cpu = os.cpus()[0];
  return {
    schemaVersion: 1,
    kind: "terminology-performance-baseline",
    status,
    startedAt,
    finishedAt,
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpuModel: cpu?.model ?? null,
      cpuCount: os.availableParallelism(),
    },
    seed,
    samplesPerMode,
    timeoutMs: defaultTimeoutMs,
    measuredCalls: ["discoverTerms", "evaluateTerms"],
    inputPreparation: "fixed-seed generation outside timed calls",
    reusedScopeWarmup: "same worker process; reported per sample",
    lifecycleMaxRss: {
      source: "process.resourceUsage().maxRSS",
      unit: "bytes",
      includes:
        "worker startup, input parsing, termbase compilation, calls, and reused-scope warmup",
    },
    scales: Object.fromEntries(
      states.map((state) => [
        `${state.comparisonGroups}x${state.concepts}`,
        scaleReport(state),
      ]),
    ),
  };
}

function summaryMarkdown(
  report: PerformanceReport,
  outputPath: string,
): string {
  const milliseconds = (value: number | null) =>
    value === null ? "—" : value.toFixed(2);
  const mebibytes = (value: number | null) =>
    value === null ? "—" : (value / (1024 * 1024)).toFixed(2);
  const rows = Object.values(report.scales).flatMap((scale) =>
    modes.map((mode) => {
      const result = scale.modes[mode];
      return `| ${scale.comparisonGroups.toLocaleString("en-US")} | ${scale.concepts.toLocaleString("en-US")} | ${mode} | ${result.completedSamples}/${result.plannedSamples} | ${milliseconds(result.summary.discoverTermsMs.median)} / ${milliseconds(result.summary.discoverTermsMs.mad)} | ${milliseconds(result.summary.evaluateTermsMs.median)} / ${milliseconds(result.summary.evaluateTermsMs.mad)} | ${mebibytes(result.summary.lifecycleMaxRssBytes.median)} / ${mebibytes(result.summary.lifecycleMaxRssBytes.mad)} | ${scale.outputConsistency.status} |`;
    }),
  );
  return [
    "# 术语性能基准",
    "",
    `- 状态：${report.status}`,
    `- Node：${report.environment.node} (${report.environment.platform}/${report.environment.arch})`,
    `- CPU：${report.environment.cpuModel ?? "未知"} (${report.environment.cpuCount} 个可用线程)`,
    `- 固定种子：${report.seed}；每种 memo 状态五次独立串行子进程。`,
    "- 计时覆盖完整公开调用 `discoverTerms` 和 `evaluateTerms`；生成的固定种子输入在计时外。",
    "- `reused-scope` 在同一子进程、同一 scope 和完整输入上先预热两次公开调用，再分别计时；预热时间和结果指纹记录在 JSON。",
    "- 峰值 RSS 使用 Node `process.resourceUsage().maxRSS`，按 bytes 记录，覆盖子进程启动、输入读取、术语库准备、公开调用和复用 scope 预热。",
    "- 耗时列为中位数 / MAD（毫秒）；峰值 RSS 列为中位数 / MAD（MiB）。未设置性能阈值。",
    "",
    "| 比较组 | 概念 | Memo 状态 | 样本 | 发现中位数 / MAD | 检查中位数 / MAD | 进程峰值 RSS 中位数 / MAD | 输出一致性 |",
    "| ---: | ---: | --- | ---: | ---: | ---: | ---: | --- |",
    ...rows,
    "",
    `机器报告：${path.basename(outputPath)}`,
    "",
  ].join("\n");
}

function parseOutputPath(args: readonly string[]): string {
  const forwardedArgs = args.filter((argument) => argument !== "--");
  if (
    forwardedArgs.length !== 2 ||
    forwardedArgs[0] !== "--output" ||
    forwardedArgs[1] === ""
  )
    throw new Error("性能基准需要 --output <report.json>。");
  const outputPath = path.resolve(process.cwd(), forwardedArgs[1]!);
  if (path.extname(outputPath).toLowerCase() !== ".json")
    throw new Error("性能报告路径必须以 .json 结尾。");
  return outputPath;
}

function modeAttempts(): Record<PerformanceMemoMode, PerformanceAttempt[]> {
  return { "no-memo": [], "new-scope": [], "reused-scope": [] };
}

function errorText(result: Awaited<ReturnType<typeof runProcess>>): string {
  return (
    result.error ||
    result.stderr.trim() ||
    result.stdout.trim() ||
    "性能样本子进程失败。"
  );
}

async function runPerformance(
  outputPath: string,
  signal: AbortSignal,
): Promise<PerformanceReport["status"]> {
  const summaryPath = outputPath.replace(/\.json$/iu, ".md");
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "lioni-performance-"),
  );
  const states: ScaleState[] = [];
  const startedAt = new Date().toISOString();
  const save = async (
    status: PerformanceReport["status"],
    finishedAt: string | null,
  ) => {
    const report = reportSnapshot(states, status, startedAt, finishedAt);
    await writeJsonAtomic(outputPath, report);
    if (finishedAt !== null)
      await writeFile(summaryPath, summaryMarkdown(report, outputPath), "utf8");
  };

  let status: PerformanceReport["status"] = "running";
  try {
    await mkdir(path.dirname(outputPath), { recursive: true });
    for (const scale of scales) {
      const prepared = createControlledPerformanceWorkload({
        groupCount: scale.comparisonGroups,
        conceptCount: scale.concepts,
        seed,
      });
      const inputPath = path.join(
        temporaryDirectory,
        `${scale.comparisonGroups}x${scale.concepts}.json`,
      );
      await writeFile(inputPath, `${JSON.stringify(prepared.input)}\n`, "utf8");
      states.push({
        ...scale,
        inputSha256: prepared.inputSha256,
        inputPath,
        facts: prepared.input.facts,
        attempts: modeAttempts(),
      });
    }
    await save(status, null);

    for (const state of states) {
      for (const mode of modes) {
        for (let sample = 1; sample <= samplesPerMode; sample += 1) {
          if (signal.aborted) {
            status = "interrupted";
            break;
          }
          const processResult = await runProcess({
            command: process.execPath,
            args: [
              workerPath,
              state.inputPath,
              mode,
              String(sample),
              state.inputSha256,
            ],
            cwd: packageRoot,
            timeoutMs: defaultTimeoutMs,
            signal,
          });

          let result: PerformanceWorkerResult | undefined;
          let error: string | undefined;
          let attemptStatus: PerformanceAttempt["status"] =
            processResult.status;
          if (processResult.status === "passed") {
            try {
              const value: unknown = JSON.parse(processResult.stdout);
              if (!isWorkerResult(value))
                throw new Error("子进程没有返回有效的性能样本。");
              if (
                value.comparisonGroups !== state.comparisonGroups ||
                value.concepts !== state.concepts ||
                value.memoMode !== mode ||
                value.sample !== sample
              )
                throw new Error("子进程样本身份与本次请求不符。");
              result = value;
              if (
                result.results.discovery.status !== "complete" ||
                result.results.evaluation.status !== "complete"
              )
                throw new Error("正式公开调用返回了不完整领域结果。");
            } catch (caught) {
              error = caught instanceof Error ? caught.message : String(caught);
              attemptStatus = "invalid-output";
            }
          } else error = errorText(processResult);

          state.attempts[mode].push({
            sample,
            memoMode: mode,
            status: attemptStatus,
            processDurationMs: processResult.durationMs,
            exitCode: processResult.code,
            signal: processResult.signal,
            ...(result === undefined ? {} : { result }),
            ...(error === undefined ? {} : { error }),
          });
          if (attemptStatus === "interrupted") status = "interrupted";
          else if (attemptStatus !== "passed") status = "failed";
          await save(status, null);
          if (status !== "running") break;
        }
        if (status !== "running") break;
      }
      if (status !== "running") break;
    }

    if (status === "running") {
      const reports = reportSnapshot(states, status, startedAt, null);
      const scalesComplete = Object.values(reports.scales).every((scale) =>
        modes.every((mode) => scale.modes[mode].status === "passed"),
      );
      const outputsEquivalent = Object.values(reports.scales).every(
        (scale) => scale.outputConsistency.status === "verified",
      );
      status = scalesComplete && outputsEquivalent ? "passed" : "failed";
    }
    await save(status, new Date().toISOString());
    return status;
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const outputPath = parseOutputPath(process.argv.slice(2));
  const abortController = new AbortController();
  const interrupt = () => abortController.abort();
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    const status = await runPerformance(outputPath, abortController.signal);
    process.stdout.write(`术语性能报告：${outputPath}\n执行状态：${status}\n`);
    if (status !== "passed") process.exitCode = 1;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `术语性能基准执行失败：${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
