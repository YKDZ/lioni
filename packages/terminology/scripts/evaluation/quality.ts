import { randomUUID } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { prepareExternalCorpus } from "./corpora/prepare.ts";
import { controlledInputIdentity } from "./scenarios/controlled.ts";
import { runProcess } from "./support/process.ts";
import {
  collectEnvironment,
  collectSourceIdentity,
  executionStatus,
  notExecutedScenario,
  packageRoot,
  qualitySummary,
  writeEvaluationReport,
} from "./support/report.ts";
import {
  defaultEvaluationRoot,
  defaultRunDirectory,
  initializeRunDirectory,
} from "./support/run-directory.ts";
import type {
  QualityReport,
  ScenarioAttempt,
  ScenarioReport,
} from "./support/types.ts";

const workerPath = fileURLToPath(new URL("./worker.ts", import.meta.url));
const defaultScenarioTimeoutMs = 10 * 60 * 1000;
export type QualityOptions = {
  readonly outputDirectory?: string;
  readonly scenarios?: readonly ("controlled" | "cfpa")[];
  readonly external?: readonly "cfpa"[];
  readonly cfpaRoot?: string;
  readonly retries?: number;
  readonly timeoutMs?: number;
  readonly generatedEntryCount?: number;
  readonly rebuild?: boolean;
  readonly signal?: AbortSignal;
};

type PreparedScenario = {
  readonly inputPath?: string;
  readonly inputSha256: string;
  readonly evidence: Readonly<Record<string, unknown>>;
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function prepareExternal(
  name: "cfpa",
  options: QualityOptions,
  outputDirectory: string,
): Promise<PreparedScenario> {
  const sourceRoot = options.cfpaRoot;
  if (!sourceRoot) throw new Error("已启用 CFPA，但没有提供本地固定副本目录。");
  const prepared = await prepareExternalCorpus({
    id: name,
    sourceRoot,
    rebuild: options.rebuild ?? false,
  });
  const inputPath = path.join(outputDirectory, `prepared/${name}.json`);
  await mkdir(path.dirname(inputPath), { recursive: true });
  await writeFile(inputPath, `${JSON.stringify(prepared.input)}\n`, "utf8");
  return Object.freeze({
    inputPath,
    inputSha256: prepared.inputSha256,
    evidence: Object.freeze({
      source: prepared.source,
      license: prepared.source.license,
      converterVersion: prepared.source.converterVersion,
      transformedInputSha256: prepared.inputSha256,
      cache: prepared.cache,
      selections: prepared.input.selections,
      contentTypeSelectionMethod:
        "manifest.ts 中由维护者按 key 明确选择；不依赖文本长度启发式分类。",
      interpretation:
        "CFPA 行和英中译法只作开集参考；不映射为经人工核验的概念或正确性标签。",
    }),
  });
}

function prepareControlled(generatedEntryCount: number): PreparedScenario {
  const identity = controlledInputIdentity(generatedEntryCount);
  return Object.freeze({
    inputSha256: identity.inputSha256,
    evidence: Object.freeze({
      source: "self-authored deterministic cases; no external data",
      generation: identity.generation,
      generatedCorpusSha256: identity.generatedCorpusSha256,
    }),
  });
}

function validateRetries(retries: number | undefined): number {
  const value = retries ?? 0;
  if (!Number.isSafeInteger(value) || value < 0 || value > 3)
    throw new RangeError("场景重试次数必须在 0 到 3 之间。");
  return value;
}

function validateTimeout(timeoutMs: number | undefined): number {
  const value = timeoutMs ?? defaultScenarioTimeoutMs;
  if (!Number.isSafeInteger(value) || value < 1)
    throw new RangeError("场景超时必须是正整数毫秒。");
  return value;
}

function validateGeneratedEntryCount(count: number | undefined): number {
  const value = count ?? 64;
  if (!Number.isSafeInteger(value) || value < 0 || value > 100_000)
    throw new RangeError("受控生成条目数必须在 0 到 100000 之间。");
  return value;
}

export async function runQualityEvaluation(
  options: QualityOptions = {},
): Promise<{
  readonly report: QualityReport;
  readonly outputDirectory: string;
}> {
  const runId = randomUUID();
  const outputDirectory = options.outputDirectory
    ? path.resolve(options.outputDirectory)
    : defaultRunDirectory(runId);
  const retries = validateRetries(options.retries);
  const scenarioTimeoutMs = validateTimeout(options.timeoutMs);
  const generatedEntryCount = validateGeneratedEntryCount(
    options.generatedEntryCount,
  );
  await initializeRunDirectory(outputDirectory, runId);

  const external = [...new Set(options.external ?? [])];
  const requested = options.scenarios ?? ["controlled", ...external];
  const selectedSet = new Set(requested);
  if (selectedSet.has("cfpa") && !external.includes("cfpa"))
    throw new Error("选择 CFPA 场景时必须显式启用 --external cfpa。");
  const scenarioOrder = ["controlled", "cfpa"] as const;
  const selected = Object.freeze(
    scenarioOrder.filter((name) => selectedSet.has(name)),
  );
  let scenarios: Record<string, ScenarioReport> = {
    controlled: notExecutedScenario(
      selectedSet.has("controlled")
        ? "等待受控场景执行。"
        : "本次未选择受控场景。",
    ),
    cfpa: notExecutedScenario(
      selectedSet.has("cfpa")
        ? "等待 CFPA 来源校验与执行。"
        : external.includes("cfpa")
          ? "本次未选择 CFPA 场景。"
          : "本次未启用 CFPA。",
    ),
  };
  const packageJson = JSON.parse(
    await readFile(path.join(packageRoot, "package.json"), "utf8"),
  ) as { readonly version: string };
  const startedAt = new Date().toISOString();
  let report: QualityReport = Object.freeze({
    schemaVersion: 1,
    kind: "quality",
    runId,
    startedAt,
    finishedAt: null,
    status: "running",
    selected,
    parameters: Object.freeze({
      retries,
      scenarioTimeoutMs,
      generatedEntryCount,
      sourceMode: "workspace-source",
      rebuildExternalInputs: options.rebuild ?? false,
    }),
    artifact: Object.freeze({
      package: "@lioni/terminology",
      version: packageJson.version,
      entry: "source",
    }),
    source: await collectSourceIdentity(),
    environment: collectEnvironment(),
    scenarios: Object.freeze({ ...scenarios }),
  });
  let activeScenario: QualityReport["activeScenario"];

  const persist = async (finished = false) => {
    const { activeScenario: _previousActiveScenario, ...baseReport } = report;
    report = Object.freeze({
      ...baseReport,
      status: finished ? executionStatus(scenarios) : "running",
      finishedAt: finished ? new Date().toISOString() : null,
      ...(activeScenario === undefined ? {} : { activeScenario }),
      scenarios: Object.freeze({ ...scenarios }),
    });
    await writeEvaluationReport(
      outputDirectory,
      report,
      qualitySummary(report),
    );
  };

  await persist();
  const runScenario = async (name: "controlled" | "cfpa") => {
    const attempts: ScenarioAttempt[] = [];
    let final: ScenarioReport | undefined;
    for (
      let attemptNumber = 1;
      attemptNumber <= retries + 1;
      attemptNumber += 1
    ) {
      const attemptStartedAt = new Date().toISOString();
      let prepared: PreparedScenario | undefined;
      let processResult: Awaited<ReturnType<typeof runProcess>> | undefined;
      let attemptResult: ScenarioReport | undefined;
      let reason: string | undefined;
      try {
        if (options.signal?.aborted)
          throw new Error("运行在场景启动前被中断。");
        if (name === "controlled")
          prepared = prepareControlled(generatedEntryCount);
        else prepared = await prepareExternal(name, options, outputDirectory);
        const resultPath = path.join(
          outputDirectory,
          `attempts/${name}-${attemptNumber}.json`,
        );
        await mkdir(path.dirname(resultPath), { recursive: true });
        activeScenario = Object.freeze({ name, attempt: attemptNumber });
        await persist();
        const args = ["--conditions=source", workerPath, name];
        if (name === "cfpa")
          args.push(
            prepared.inputPath!,
            resultPath,
            prepared.inputSha256,
            String(generatedEntryCount),
          );
        else
          args.push(
            "",
            resultPath,
            prepared.inputSha256,
            String(generatedEntryCount),
          );
        processResult = await runProcess({
          command: process.execPath,
          args,
          cwd: packageRoot,
          timeoutMs: scenarioTimeoutMs,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        if (processResult.status !== "passed")
          throw new Error(
            processResult.error ??
              (processResult.stderr ||
                `场景进程退出状态：${processResult.status}`),
          );
        attemptResult = JSON.parse(
          await readFile(resultPath, "utf8"),
        ) as ScenarioReport;
        if (attemptResult.execution.status !== "passed")
          throw new Error(attemptResult.execution.reason ?? "场景未通过执行。");
        const { evidence: scenarioEvidence, ...scenarioFields } = attemptResult;
        final = Object.freeze({
          ...scenarioFields,
          attempts: Object.freeze([]),
          inputSha256: prepared.inputSha256,
          evidence: Object.freeze({
            preparation: prepared.evidence,
            scenario: scenarioEvidence,
          }),
        });
      } catch (error) {
        reason = errorText(error);
        final = Object.freeze({
          execution: Object.freeze({ status: "failed", reason }),
          domain: Object.freeze({ status: "not-run" }),
          ...(prepared === undefined
            ? {}
            : { inputSha256: prepared.inputSha256 }),
          metrics: Object.freeze({}),
          ...(prepared === undefined
            ? {}
            : { evidence: Object.freeze({ preparation: prepared.evidence }) }),
        });
      }

      const status = final.execution.status === "passed" ? "passed" : "failed";
      attempts.push(
        Object.freeze({
          number: attemptNumber,
          startedAt: attemptStartedAt,
          finishedAt: new Date().toISOString(),
          status,
          ...(reason === undefined ? {} : { reason }),
          ...(processResult === undefined ? {} : { process: processResult }),
        }),
      );
      activeScenario = undefined;
      final = Object.freeze({
        ...final,
        attempts: Object.freeze([...attempts]),
      });
      scenarios = { ...scenarios, [name]: final };
      await persist();
      if (status === "passed" || options.signal?.aborted) break;
    }
  };

  for (const name of selected) {
    await runScenario(name as "controlled" | "cfpa");
  }
  await persist(true);
  return Object.freeze({ report, outputDirectory });
}

export function defaultOutputRoot(): string {
  return defaultEvaluationRoot();
}
