import { execFile } from "node:child_process";
import { mkdir, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { writeJsonAtomic } from "./json.ts";
import type { QualityReport, ScenarioReport } from "./types.ts";

const execFileAsync = promisify(execFile);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
export const packageRoot = path.resolve(scriptDirectory, "../../..");

function isLocalContextFile(filename: string): boolean {
  return (
    filename === "AGENTS.md" ||
    filename === ".codex" ||
    filename === ".agents" ||
    filename === ".scratch" ||
    filename === "docs" ||
    filename === "GLOSSARY.md" ||
    filename === "GLOSSARY-MAP.md" ||
    filename.startsWith("GLOSSARY-")
  );
}

async function gitOutput(args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", [...args], {
    cwd: packageRoot,
    encoding: "utf8",
  });
  return stdout.trimEnd();
}

export async function collectSourceIdentity(): Promise<
  QualityReport["source"]
> {
  const commit = await gitOutput(["rev-parse", "HEAD"]);
  const status = await gitOutput([
    "status",
    "--porcelain",
    "--untracked-files=all",
  ]);
  const changedFiles = status
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3))
    .filter((filename) => !isLocalContextFile(filename))
    .sort();
  return Object.freeze({
    commit,
    dirty: changedFiles.length > 0,
    changedFiles: Object.freeze(changedFiles),
  });
}

export function collectEnvironment(): QualityReport["environment"] {
  const cpu = os.cpus()[0];
  return Object.freeze({
    node: process.version,
    icu: process.versions.icu ?? null,
    unicode: process.versions.unicode ?? null,
    platform: process.platform,
    arch: process.arch,
    cpuModel: cpu?.model ?? null,
    cpuCount: os.availableParallelism(),
  });
}

export function notExecutedScenario(reason: string): ScenarioReport {
  return Object.freeze({
    execution: Object.freeze({ status: "not-executed", reason }),
    domain: Object.freeze({ status: "not-run" }),
    metrics: Object.freeze({}),
  });
}

export function executionStatus(
  scenarios: Readonly<Record<string, ScenarioReport>>,
): "passed" | "failed" {
  return Object.values(scenarios).some(
    ({ execution }) => execution.status === "failed",
  )
    ? "failed"
    : "passed";
}

export function qualitySummary(report: QualityReport): string {
  const rows = Object.entries(report.scenarios).map(([name, scenario]) => {
    const metricSummary = Object.entries(scenario.metrics)
      .map(([metric, result]) =>
        result.status === "not-evaluated"
          ? `${metric}：未评估（${result.basis}）`
          : `${metric}：已评估（${result.basis}）`,
      )
      .join("；");
    return `| ${name} | ${scenario.execution.status} | ${scenario.domain.status} | ${metricSummary || "无指标"} |`;
  });
  return [
    "# 术语质量评估摘要",
    "",
    `- 执行状态：${report.status}`,
    `- 运行 ID：${report.runId}`,
    `- 执行场景：${report.selected.join("、")}`,
    `- 源码提交：${report.source.commit}${report.source.dirty ? "（工作树有改动）" : "（工作树干净）"}`,
    `- 制品入口：${report.artifact.package}@${report.artifact.version}（${report.artifact.entry}）`,
    `- Node / ICU：${report.environment.node} / ${report.environment.icu ?? "未知"}`,
    `- 平台 / CPU：${report.environment.platform}/${report.environment.arch} / ${report.environment.cpuModel ?? "未知"}（${report.environment.cpuCount} 线程）`,
    `- 受控生成条目：${report.parameters.generatedEntryCount}；重试：${report.parameters.retries}；超时：${report.parameters.scenarioTimeoutMs} ms`,
    "",
    "| 场景 | 执行 | 领域完整性 | 指标 |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
    "参考重合不等于正确性；无独立标注的精确率、召回率和采纳率均保持未评估。",
    "",
  ].join("\n");
}

/** 写入本设施的机器报告和简短摘要，替换过程不留下半份目标文件。 */
export async function writeEvaluationReport(
  directory: string,
  report: unknown,
  summary: string,
): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeJsonAtomic(path.join(directory, "report.json"), report);
  const temporary = path.join(directory, "summary.md.tmp");
  await writeFile(temporary, summary, "utf8");
  await rename(temporary, path.join(directory, "summary.md"));
}
