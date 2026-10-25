import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { defaultTermMatchingPolicy } from "@lioni/terminology";

import { prepareExternalCorpus } from "./corpora/prepare.ts";
import { aggregateModeSamples } from "./performance/statistics.ts";
import type {
  PerformanceAttempt,
  PerformanceRunReport,
  PerformanceScenarioReport,
} from "./performance/types.ts";
import type { PerformanceWorkerResult } from "./performance/worker.ts";
import {
  createCfpaPerformanceWorkload,
  createControlledPerformanceWorkload,
  performanceDiscoveryPolicy,
  type PerformanceMemoMode,
  type PerformancePreparedInput,
} from "./performance/workload.ts";
import {
  collectEnvironment,
  collectSourceIdentity,
  defaultRunDirectory,
  initializeRunDirectory,
  packageRoot,
  runProcess,
  writeEvaluationReport,
  type ProcessResult,
} from "./support/index.ts";

const workerPath = fileURLToPath(
  new URL("./performance/worker.ts", import.meta.url),
);
const memoModes = Object.freeze([
  "no-memo",
  "empty-scope",
  "reused-scope",
] as const);
const defaultSamplesPerMode = 3;
const defaultSampleTimeoutMs = 30 * 60 * 1_000;
const turboBuildDurationEnvironment = "LIONI_PERFORMANCE_TURBO_BUILD_MS";
const turboBuildCommand =
  "pnpm exec turbo run build --filter=@lioni/terminology... --force";

export type PerformanceScenarioName = "controlled-scale" | "cfpa";

export type PerformanceOptions = {
  readonly outputDirectory?: string;
  readonly scenarios?: readonly PerformanceScenarioName[];
  readonly external?: readonly "cfpa"[];
  readonly cfpaRoot?: string;
  readonly samplesPerMode?: number;
  readonly retries?: number;
  readonly timeoutMs?: number;
  readonly groupCount?: number;
  readonly conceptCount?: number;
  readonly seed?: number;
  readonly rebuild?: boolean;
  readonly signal?: AbortSignal;
};

type PreparedScenario = {
  readonly input: PerformancePreparedInput;
  readonly inputSha256: string;
  readonly preparation: PerformanceScenarioReport["preparation"];
  readonly selection: unknown;
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validateInteger(
  value: number | undefined,
  fallback: number,
  name: string,
  minimum: number,
  maximum: number,
): number {
  const actual = value ?? fallback;
  if (!Number.isSafeInteger(actual) || actual < minimum || actual > maximum)
    throw new RangeError(`${name} 必须在 ${minimum} 到 ${maximum} 之间。`);
  return actual;
}

function policyFor(input: PerformancePreparedInput) {
  const languages = [
    ...new Set(
      input.termbase.concepts.flatMap((concept) =>
        concept.languages.map(({ language }) => language),
      ),
    ),
  ].toSorted();
  return Object.freeze({
    matching: Object.freeze(
      Object.fromEntries(
        languages.map((language) => [
          language,
          defaultTermMatchingPolicy(language)?.id ?? "unsupported",
        ]),
      ),
    ),
    assessmentRules: Object.freeze([
      "require-allowed-translation",
      "reject-forbidden-translation",
    ]),
    discovery: performanceDiscoveryPolicy,
    completeness:
      "仅输入显式标记 complete:false 时判为不完整；本设施不缩小或猜测语料范围。",
  });
}

function scenarioSelection(
  name: PerformanceScenarioName,
  input: PerformancePreparedInput,
): unknown {
  return name === "controlled-scale"
    ? Object.freeze({
        comparison: "全部合成源目标组；en -> zh-CN",
        discovery: "全部合成英语源文本",
      })
    : Object.freeze({
        comparison: input.external?.selections,
        discovery: "CFPA 英语候选语料全部转换条目",
        source: input.external?.source.commit,
      });
}

async function prepareScenario(
  name: PerformanceScenarioName,
  options: PerformanceOptions,
  inputsDirectory: string,
  groupCount: number,
  conceptCount: number,
  seed: number,
): Promise<PreparedScenario> {
  const started = performance.now();
  if (name === "controlled-scale") {
    const prepared = createControlledPerformanceWorkload({
      groupCount,
      conceptCount,
      seed,
    });
    const inputPath = path.join(inputsDirectory, "controlled-scale.json");
    await mkdir(path.dirname(inputPath), { recursive: true });
    await writeFile(inputPath, `${JSON.stringify(prepared.input)}\n`, "utf8");
    return Object.freeze({
      ...prepared,
      preparation: Object.freeze({
        durationMs: performance.now() - started,
        kind: "deterministic-generation",
      }),
      selection: scenarioSelection(name, prepared.input),
    });
  }

  if (!options.cfpaRoot)
    throw new Error(
      "已选择 CFPA 性能场景，但未提供固定本地副本 `--cfpa-root`。",
    );
  const prepared = await prepareExternalCorpus({
    id: "cfpa",
    sourceRoot: options.cfpaRoot,
    rebuild: options.rebuild ?? false,
  });
  if (prepared.id !== "cfpa")
    throw new Error("CFPA 固定来源返回了错误语料身份。");
  const workload = createCfpaPerformanceWorkload(
    prepared.input,
    prepared.inputSha256,
  );
  const inputPath = path.join(inputsDirectory, "cfpa.json");
  await mkdir(path.dirname(inputPath), { recursive: true });
  await writeFile(inputPath, `${JSON.stringify(workload.input)}\n`, "utf8");
  return Object.freeze({
    ...workload,
    preparation: Object.freeze({
      durationMs: performance.now() - started,
      kind: "fixed-corpus-transform-cache",
      corpusCache: prepared.cache,
    }),
    selection: scenarioSelection(name, workload.input),
  });
}

async function builtArtifactIdentity() {
  const packageJson: unknown = JSON.parse(
    await readFile(path.join(packageRoot, "package.json"), "utf8"),
  );
  if (
    typeof packageJson !== "object" ||
    packageJson === null ||
    !("version" in packageJson) ||
    typeof packageJson.version !== "string"
  )
    throw new Error("terminology/package.json 缺少有效版本号。");
  const distRoot = path.join(packageRoot, "dist");
  if (!(await stat(distRoot).catch(() => undefined))?.isDirectory())
    throw new Error(
      "缺少正式构建的 terminology/dist；请先通过根 Turbo 构建包及其依赖，再运行性能入口。",
    );
  const files: string[] = [];
  const hash = createHash("sha256");
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.toSorted((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) {
        const relative = path
          .relative(packageRoot, absolute)
          .split(path.sep)
          .join("/");
        const bytes = await readFile(absolute);
        files.push(relative);
        hash.update(relative);
        hash.update("\0");
        hash.update(bytes);
        hash.update("\0");
      } else throw new Error(`正式构建目录含非普通文件：${absolute}`);
    }
  }
  await visit(distRoot);
  if (!files.includes("dist/index.js"))
    throw new Error("正式构建目录缺少公开 JavaScript 入口 dist/index.js。");
  return Object.freeze({
    package: "@lioni/terminology" as const,
    version: packageJson.version,
    entry: "dist/index.js",
    sha256: hash.digest("hex"),
    files: Object.freeze(files),
  });
}

function emptyModes(samplesPerMode: number) {
  return Object.freeze({
    "no-memo": aggregateModeSamples(samplesPerMode, []),
    "empty-scope": aggregateModeSamples(samplesPerMode, []),
    "reused-scope": aggregateModeSamples(samplesPerMode, []),
  });
}

function zeroModeSamples(
  samplesPerMode: number,
  attempts: readonly PerformanceAttempt[],
) {
  const samplesFor = (mode: PerformanceMemoMode) =>
    attempts.flatMap((attempt) =>
      attempt.status === "passed" &&
      attempt.memoMode === mode &&
      attempt.sample !== undefined
        ? [attempt.sample]
        : [],
    );
  return Object.freeze({
    "no-memo": aggregateModeSamples(samplesPerMode, samplesFor("no-memo")),
    "empty-scope": aggregateModeSamples(
      samplesPerMode,
      samplesFor("empty-scope"),
    ),
    "reused-scope": aggregateModeSamples(
      samplesPerMode,
      samplesFor("reused-scope"),
    ),
  });
}

function outputEquivalence(attempts: readonly PerformanceAttempt[]) {
  const grouped = new Map<PerformanceMemoMode, Map<string, Set<string>>>();
  for (const attempt of attempts) {
    if (attempt.status !== "passed" || !attempt.sample) continue;
    const phases =
      grouped.get(attempt.memoMode) ?? new Map<string, Set<string>>();
    for (const [phase, fingerprint] of Object.entries(
      attempt.sample.output.fingerprints,
    )) {
      const values = phases.get(phase) ?? new Set<string>();
      values.add(fingerprint);
      phases.set(phase, values);
    }
    grouped.set(attempt.memoMode, phases);
  }
  const withinModeDifferences = [...grouped].flatMap(([mode, phases]) =>
    [...phases]
      .filter(([, values]) => values.size > 1)
      .map(
        ([phase, values]) =>
          `${mode} ${phase} 输出在重复样本间不一致：${[...values].join(", ")}`,
      ),
  );
  const phaseNames = [
    ...new Set([...grouped.values()].flatMap((phases) => [...phases.keys()])),
  ];
  const acrossModeDifferences = phaseNames.flatMap((phase) => {
    const values = new Set(
      [...grouped.values()].flatMap((phases) => [...(phases.get(phase) ?? [])]),
    );
    return values.size > 1
      ? [`${phase} 输出在 memo 模式间不一致：${[...values].join(", ")}`]
      : [];
  });
  return Object.freeze({
    withinMode: withinModeDifferences.length === 0,
    acrossModes: acrossModeDifferences.length === 0,
    differences: Object.freeze([
      ...withinModeDifferences,
      ...acrossModeDifferences,
    ]),
  });
}

function scenarioDomain(
  attempts: readonly PerformanceAttempt[],
): "complete" | "incomplete" | "not-run" {
  const samples = attempts.flatMap(({ sample }) =>
    sample === undefined ? [] : [sample],
  );
  if (!samples.length) return "not-run";
  return samples.every(({ output }) => output.status === "complete")
    ? "complete"
    : "incomplete";
}

function performanceScenario(
  prepared: PreparedScenario,
  name: PerformanceScenarioName,
  plannedSamples: number,
  attempts: readonly PerformanceAttempt[],
  execution: PerformanceScenarioReport["execution"],
): PerformanceScenarioReport {
  const modes = zeroModeSamples(plannedSamples, attempts);
  const equivalence = outputEquivalence(attempts);
  const domain = scenarioDomain(attempts);
  const completed = memoModes.every(
    (mode) => modes[mode].completedSamples === plannedSamples,
  );
  const scaleRequired =
    name !== "controlled-scale" ||
    (prepared.input.facts.comparisonGroups >= 10_000 &&
      prepared.input.facts.concepts >= 1_000);
  const acrossModes = equivalence.acrossModes && completed;
  const eligibilityReasons = [
    ...(execution.status !== "passed"
      ? [`执行状态为 ${execution.status}。`]
      : []),
    ...(domain !== "complete" ? [`领域结果为 ${domain}。`] : []),
    ...(!completed ? ["未完成全部计划样本。"] : []),
    ...(!equivalence.withinMode
      ? ["同一 memo 模式的重复样本输出不一致。"]
      : []),
    ...(!equivalence.acrossModes ? ["不同 memo 模式的输出不等价。"] : []),
    ...(!scaleRequired ? ["合成规模低于一万个比较组或一千个概念。"] : []),
  ];
  const eligible =
    execution.status === "passed" &&
    domain === "complete" &&
    acrossModes &&
    scaleRequired;
  return Object.freeze({
    id: prepared.input.id,
    execution,
    domain: Object.freeze({ status: domain }),
    measurementsEligible: eligible,
    input: Object.freeze({
      sha256: prepared.inputSha256,
      ...(prepared.input.external === undefined
        ? {}
        : {
            transformedInputSha256:
              prepared.input.external.transformedInputSha256,
          }),
      facts: prepared.input.facts,
      ...(prepared.input.generation === undefined
        ? {}
        : { generation: prepared.input.generation }),
      ...(prepared.input.external === undefined
        ? {}
        : { external: prepared.input.external }),
    }),
    preparation: prepared.preparation,
    selection: prepared.selection,
    policy: policyFor(prepared.input),
    outputEquivalence: Object.freeze({
      withinMode: equivalence.withinMode,
      acrossModes,
      differences: equivalence.differences,
    }),
    eligibilityReasons: Object.freeze(eligibilityReasons),
    attempts: Object.freeze([...attempts]),
    modes,
    qualityMetrics: Object.freeze({
      candidateQuality: Object.freeze({
        status: "not-evaluated",
        basis: "性能数据不含独立人工候选标签；完成计时不代表候选正确。",
      }),
      precision: Object.freeze({
        status: "not-evaluated",
        basis: "没有独立人工真值标签。",
      }),
      recall: Object.freeze({
        status: "not-evaluated",
        basis: "开集参考语料不完整，且没有逐项人工正例标注。",
      }),
    }),
  });
}

function emptyScenario(
  name: PerformanceScenarioName,
  samplesPerMode: number,
  status: "failed" | "not-executed",
  reason: string,
): PerformanceScenarioReport {
  const outcome =
    status === "not-executed" ? "场景未启动。" : "场景准备未完成。";
  return Object.freeze({
    id: name,
    execution: Object.freeze({ status, reason }),
    domain: Object.freeze({ status: "not-run" }),
    measurementsEligible: false,
    preparation: Object.freeze({
      durationMs: 0,
      kind:
        name === "cfpa"
          ? "fixed-corpus-transform-cache"
          : "deterministic-generation",
    }),
    selection: null,
    policy: Object.freeze({}),
    outputEquivalence: Object.freeze({
      withinMode: false,
      acrossModes: false,
      differences: Object.freeze([]),
    }),
    eligibilityReasons: Object.freeze([outcome]),
    attempts: Object.freeze([]),
    modes: emptyModes(samplesPerMode),
    qualityMetrics: Object.freeze({
      candidateQuality: Object.freeze({
        status: "not-evaluated",
        basis: outcome,
      }),
      precision: Object.freeze({
        status: "not-evaluated",
        basis: outcome,
      }),
      recall: Object.freeze({
        status: "not-evaluated",
        basis: outcome,
      }),
    }),
  });
}

function emptyFailedScenario(
  name: PerformanceScenarioName,
  samplesPerMode: number,
  reason: string,
): PerformanceScenarioReport {
  return emptyScenario(name, samplesPerMode, "failed", reason);
}

function unstartedScenario(
  name: PerformanceScenarioName,
  samplesPerMode: number,
): PerformanceScenarioReport {
  return emptyScenario(
    name,
    samplesPerMode,
    "not-executed",
    "前序场景收到中断信号，本场景未启动。",
  );
}

function runStatus(
  scenarios: Readonly<Record<string, PerformanceScenarioReport>>,
  interrupted: boolean,
): PerformanceRunReport["status"] {
  if (interrupted) return "interrupted";
  return Object.values(scenarios).some(
    ({ execution }) => execution.status === "failed",
  )
    ? "failed"
    : "passed";
}

export function performanceSummary(report: PerformanceRunReport): string {
  const rows: string[] = [];
  const duration = (value: number | null): string =>
    value === null ? "未测量" : `${value.toFixed(2)} ms`;
  for (const [name, scenario] of Object.entries(report.scenarios)) {
    for (const mode of memoModes) {
      const values = scenario.modes[mode];
      const analysis = values.phases.analyzeTermUse.durationsMs;
      const full = values.phases.evaluateTerms.durationsMs;
      const discovery = values.phases.discoverTerms.durationsMs;
      rows.push(
        `| ${name} | ${mode} | ${values.completedSamples}/${values.plannedSamples} | ${duration(analysis.median)} | ${duration(full.median)} | ${duration(discovery.median)} | ${scenario.domain.status} | ${scenario.measurementsEligible ? "可归档" : "不可归档"} |`,
      );
    }
  }
  return [
    "# 术语性能评估摘要",
    "",
    `- 执行状态：${report.status}`,
    `- 运行 ID：${report.runId}`,
    `- 场景：${report.selected.join("、")}`,
    `- 源码：${report.source.commit}${report.source.dirty ? "（工作树有改动）" : "（工作树干净）"}`,
    `- 正式构建入口：${report.artifact.package}@${report.artifact.version}（${report.artifact.entry}；SHA-256 ${report.artifact.sha256}）`,
    `- Node / ICU：${report.environment.node} / ${report.environment.icu ?? "未知"}`,
    `- 平台 / CPU：${report.environment.platform}/${report.environment.arch} / ${report.environment.cpuModel ?? "未知"}（${report.environment.cpuCount} 线程）`,
    `- 样本：每种 memo 模式 ${report.parameters.samplesPerMode} 次独立 Node 子进程；运行时预热 ${report.parameters.runtimeWarmupGroups} 组且不传 memo。`,
    `- 正式构建：${report.buildPreparation.durationMs === null ? "由调用方在运行前准备；耗时未记录" : `${report.buildPreparation.durationMs.toFixed(1)} ms（根 Turbo）`}；不计入算法样本。`,
    "- 阶段耗时分别报告；完整入口计时不与各阶段耗时相加。阶段内存是操作前后观察，整进程 maxRSS 与释放后观察分列。",
    "",
    "| 场景 | Memo 模式 | 完成样本 | 分析中位数 | 完整入口中位数 | 发现中位数 | 领域状态 | 基线资格 |",
    "| --- | --- | ---: | ---: | ---: | ---: | --- | --- |",
    ...rows,
    "",
    "输出摘要同时保留组数、文本、概念、表达、匹配、问题、候选和指纹。没有人工标签的候选质量、精确率与召回率均为未评估。",
    "",
  ].join("\n");
}

export async function runPerformanceEvaluation(
  options: PerformanceOptions = {},
): Promise<{
  readonly report: PerformanceRunReport;
  readonly outputDirectory: string;
}> {
  const runId = randomUUID();
  const outputDirectory = options.outputDirectory
    ? path.resolve(options.outputDirectory)
    : defaultRunDirectory(runId);
  const samplesPerMode = validateInteger(
    options.samplesPerMode,
    defaultSamplesPerMode,
    "每种 memo 模式的样本数",
    1,
    20,
  );
  const retries = validateInteger(options.retries, 0, "样本重试次数", 0, 3);
  const timeoutMs = validateInteger(
    options.timeoutMs,
    defaultSampleTimeoutMs,
    "样本超时",
    1,
    2_147_483_647,
  );
  const groupCount = validateInteger(
    options.groupCount,
    10_000,
    "合成比较组数",
    1,
    100_000,
  );
  const conceptCount = validateInteger(
    options.conceptCount,
    1_000,
    "合成概念数",
    1,
    groupCount,
  );
  const seed = validateInteger(
    options.seed,
    20_261_025,
    "合成数据种子",
    0,
    2_147_483_647,
  );
  const external = [...new Set(options.external ?? [])];
  const requested = options.scenarios ?? ["controlled-scale"];
  const supportedScenarios = ["controlled-scale", "cfpa"] as const;
  const selected = Object.freeze(
    supportedScenarios.filter((name) => requested.includes(name)),
  );
  if (
    selected.length !== requested.length ||
    new Set(requested).size !== requested.length
  )
    throw new Error("性能场景选择包含重复或不支持的名称。");
  if (selected.includes("cfpa") && !external.includes("cfpa"))
    throw new Error("选择 CFPA 场景时必须显式启用 `--external cfpa`。");
  if (external.includes("cfpa") && !options.cfpaRoot)
    throw new Error("启用 CFPA 时必须提供固定本地副本 `--cfpa-root`。");
  if (selected.length === 0) throw new Error("至少选择一个性能场景。");

  await initializeRunDirectory(outputDirectory, runId);
  const preparedDirectory = path.join(outputDirectory, "prepared");
  const attemptsDirectory = path.join(outputDirectory, "attempts");
  await mkdir(preparedDirectory, { recursive: true });
  await mkdir(attemptsDirectory, { recursive: true });
  const artifact = await builtArtifactIdentity();
  const startedAt = new Date().toISOString();
  const source = await collectSourceIdentity();
  const environment = Object.freeze({
    ...collectEnvironment(),
    totalMemoryBytes: os.totalmem(),
  });
  const buildDurationValue = process.env[turboBuildDurationEnvironment];
  const buildDurationMs =
    buildDurationValue === undefined ? null : Number(buildDurationValue);
  if (
    buildDurationMs !== null &&
    (!Number.isFinite(buildDurationMs) || buildDurationMs < 0)
  )
    throw new Error(`${turboBuildDurationEnvironment} 必须是非负有限毫秒数。`);
  let scenarios: Record<string, PerformanceScenarioReport> = {};
  let activeAttempt: PerformanceRunReport["activeAttempt"];
  let interrupted = false;
  let report: PerformanceRunReport = Object.freeze({
    schemaVersion: 1,
    kind: "performance",
    runId,
    startedAt,
    finishedAt: null,
    status: "running",
    selected,
    parameters: Object.freeze({
      samplesPerMode,
      runtimeWarmupGroups: 2,
      retries,
      sampleTimeoutMs: timeoutMs,
      memoModes,
      sourceMode: "built-public-exports",
      rebuildExternalInputs: options.rebuild ?? false,
    }),
    buildPreparation: Object.freeze({
      status:
        buildDurationMs === null
          ? "verified-prebuilt-by-caller"
          : "measured-by-root-turbo",
      command: turboBuildCommand,
      durationMs: buildDurationMs,
      includedInSamples: false,
    }),
    artifact,
    source,
    environment,
    scenarios: Object.freeze({}),
  });
  const persist = async (finished = false) => {
    const { activeAttempt: _oldAttempt, ...base } = report;
    report = Object.freeze({
      ...base,
      status: finished ? runStatus(scenarios, interrupted) : "running",
      finishedAt: finished ? new Date().toISOString() : null,
      ...(activeAttempt === undefined ? {} : { activeAttempt }),
      scenarios: Object.freeze({ ...scenarios }),
    });
    await writeEvaluationReport(
      outputDirectory,
      report,
      performanceSummary(report),
    );
  };
  await persist();

  for (const name of selected) {
    if (options.signal?.aborted) {
      interrupted = true;
      for (const notStarted of selected.slice(selected.indexOf(name))) {
        scenarios = {
          ...scenarios,
          [notStarted]: unstartedScenario(notStarted, samplesPerMode),
        };
      }
      await persist();
      break;
    }
    let prepared: PreparedScenario;
    try {
      prepared = await prepareScenario(
        name,
        options,
        preparedDirectory,
        groupCount,
        conceptCount,
        seed,
      );
    } catch (error) {
      scenarios = {
        ...scenarios,
        [name]: emptyFailedScenario(name, samplesPerMode, errorText(error)),
      };
      await persist();
      continue;
    }
    const inputPath = path.join(preparedDirectory, `${name}.json`);
    let attempts: PerformanceAttempt[] = [];
    let scenarioFailed = false;
    let reason: string | undefined;
    const updateScenario = () => {
      scenarios = {
        ...scenarios,
        [name]: performanceScenario(
          prepared,
          name,
          samplesPerMode,
          attempts,
          Object.freeze({
            status: scenarioFailed ? "failed" : "running",
            ...(reason === undefined ? {} : { reason }),
          }),
        ),
      };
    };
    updateScenario();
    await persist();
    for (const memoMode of memoModes) {
      for (
        let sampleIndex = 1;
        sampleIndex <= samplesPerMode;
        sampleIndex += 1
      ) {
        let succeeded = false;
        for (
          let retryNumber = 1;
          retryNumber <= retries + 1;
          retryNumber += 1
        ) {
          if (options.signal?.aborted) {
            interrupted = true;
            scenarioFailed = true;
            reason = "收到中断信号，本次计划样本尚未启动。";
            break;
          }
          const attemptStartedAt = new Date().toISOString();
          const resultPath = path.join(
            attemptsDirectory,
            `${name}-${memoMode}-sample-${sampleIndex}-attempt-${retryNumber}.json`,
          );
          let processResult: ProcessResult;
          let sample: PerformanceWorkerResult | undefined;
          let failure: string | undefined;
          activeAttempt = Object.freeze({
            scenario: name,
            memoMode,
            sampleIndex,
            retryNumber,
          });
          updateScenario();
          await persist();
          processResult = await runProcess({
            command: process.execPath,
            args: [
              "--expose-gc",
              workerPath,
              inputPath,
              resultPath,
              memoMode,
              String(sampleIndex),
              prepared.inputSha256,
            ],
            cwd: packageRoot,
            timeoutMs,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
          });
          if (processResult.status === "interrupted") interrupted = true;
          if (processResult.status !== "passed")
            failure =
              processResult.error ??
              processResult.stderr ??
              `样本进程状态为 ${processResult.status}。`;
          else {
            try {
              sample = JSON.parse(
                await readFile(resultPath, "utf8"),
              ) as PerformanceWorkerResult;
              if (
                sample.scenario !== name ||
                sample.memoMode !== memoMode ||
                sample.sampleIndex !== sampleIndex
              )
                throw new Error("子进程样本身份与本次请求不符。");
            } catch (error) {
              failure = errorText(error);
            }
          }
          const status =
            failure === undefined && sample !== undefined ? "passed" : "failed";
          attempts.push(
            Object.freeze({
              sampleIndex,
              retryNumber,
              memoMode,
              startedAt: attemptStartedAt,
              finishedAt: new Date().toISOString(),
              status,
              ...(failure === undefined ? {} : { reason: failure }),
              process: processResult,
              ...(sample === undefined ? {} : { sample }),
            }),
          );
          activeAttempt = undefined;
          succeeded = status === "passed";
          if (!succeeded && (retryNumber > retries || interrupted)) {
            scenarioFailed = true;
            reason = failure ?? "样本未通过。";
          }
          updateScenario();
          await persist();
          if (succeeded || interrupted) break;
        }
        if (!succeeded || interrupted) break;
      }
      if (scenarioFailed || interrupted) break;
    }
    if (scenarioFailed || interrupted) {
      scenarioFailed = true;
      updateScenario();
      await persist();
      if (interrupted) {
        for (const notStarted of selected.slice(selected.indexOf(name) + 1)) {
          scenarios = {
            ...scenarios,
            [notStarted]: unstartedScenario(notStarted, samplesPerMode),
          };
        }
        await persist();
        break;
      }
      continue;
    }
    updateScenario();
    const completed = performanceScenario(
      prepared,
      name,
      samplesPerMode,
      attempts,
      Object.freeze({ status: "passed" }),
    );
    scenarios = { ...scenarios, [name]: completed };
    await persist();
  }

  await persist(true);
  return Object.freeze({ report, outputDirectory });
}
