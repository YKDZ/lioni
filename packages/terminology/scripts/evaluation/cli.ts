import {
  runPerformanceEvaluation,
  type PerformanceScenarioName,
} from "./performance.ts";
import { runPerformanceComparison } from "./performance/compare.ts";
import { resolvePath } from "./support/json.ts";
import { cleanupRunDirectory } from "./support/run-directory.ts";

function absolutePath(value: string | undefined): string | undefined {
  return value === undefined ? undefined : resolvePath(process.cwd(), value);
}

type PerformanceArguments = {
  readonly outputDirectory?: string;
  readonly scenarios?: readonly PerformanceScenarioName[];
  readonly external: readonly "cfpa"[];
  readonly cfpaRoot?: string;
  readonly samplesPerMode: number;
  readonly retries: number;
  readonly timeoutMs?: number;
  readonly groupCount: number;
  readonly conceptCount: number;
  readonly seed: number;
  readonly rebuild: boolean;
};

function parsePerformanceArguments(
  args: readonly string[],
): PerformanceArguments {
  let outputDirectory: string | undefined;
  let scenarios: PerformanceScenarioName[] | undefined;
  let cfpaRoot: string | undefined;
  let external: "cfpa"[] = [];
  let samplesPerMode = 3;
  let retries = 0;
  let timeoutMs: number | undefined;
  let groupCount = 10_000;
  let conceptCount = 1_000;
  let seed = 20_261_025;
  let rebuild = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--output") outputDirectory = args[++index];
    else if (argument === "--scenarios") {
      const value = args[++index];
      if (value === undefined) throw new Error("--scenarios 需要场景名称。");
      scenarios = value.split(",").map((name) => {
        if (name !== "controlled-scale" && name !== "cfpa")
          throw new Error(`不支持的性能场景：${name}`);
        return name;
      });
    } else if (argument === "--external") {
      const value = args[++index];
      if (value === undefined) throw new Error("--external 需要语料名称。");
      external = value.split(",").map((name) => {
        if (name !== "cfpa") throw new Error(`不支持的性能语料：${name}`);
        return name;
      });
    } else if (argument === "--cfpa-root") cfpaRoot = args[++index];
    else if (argument === "--samples") samplesPerMode = Number(args[++index]);
    else if (argument === "--retries") retries = Number(args[++index]);
    else if (argument === "--timeout-ms") timeoutMs = Number(args[++index]);
    else if (argument === "--group-count") groupCount = Number(args[++index]);
    else if (argument === "--concept-count")
      conceptCount = Number(args[++index]);
    else if (argument === "--seed") seed = Number(args[++index]);
    else if (argument === "--rebuild") rebuild = true;
    else throw new Error(`未知性能参数：${String(argument)}`);
  }
  const numericValues = [
    samplesPerMode,
    retries,
    groupCount,
    conceptCount,
    seed,
  ];
  if (numericValues.some((value) => !Number.isSafeInteger(value)))
    throw new Error("样本数、重试次数、规模数和种子必须是安全整数。");
  if (timeoutMs !== undefined && !Number.isSafeInteger(timeoutMs))
    throw new Error("--timeout-ms 需要安全整数。");
  if (outputDirectory === "" || cfpaRoot === "")
    throw new Error("路径参数必须有值。");
  return {
    ...(outputDirectory === undefined ? {} : { outputDirectory }),
    ...(scenarios === undefined
      ? {}
      : { scenarios: Object.freeze([...new Set(scenarios)]) }),
    external: Object.freeze([...new Set(external)]),
    ...(cfpaRoot === undefined ? {} : { cfpaRoot }),
    samplesPerMode,
    retries,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    groupCount,
    conceptCount,
    seed,
    rebuild,
  };
}

async function runPerformance(args: readonly string[]): Promise<void> {
  const options = parsePerformanceArguments(args);
  const outputDirectory = absolutePath(options.outputDirectory);
  const cfpaRoot = absolutePath(options.cfpaRoot);
  const abortController = new AbortController();
  const interrupt = () => abortController.abort();
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    const { report, outputDirectory: resultDirectory } =
      await runPerformanceEvaluation({
        ...options,
        ...(outputDirectory === undefined ? {} : { outputDirectory }),
        ...(cfpaRoot === undefined ? {} : { cfpaRoot }),
        signal: abortController.signal,
      });
    process.stdout.write(
      `性能报告：${resultDirectory}/report.json\n执行状态：${report.status}\n`,
    );
    if (
      report.status !== "passed" ||
      Object.values(report.scenarios).some(
        ({ measurementsEligible }) => !measurementsEligible,
      )
    )
      process.exitCode = 1;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
}

type ComparisonArguments = {
  readonly baseline?: string;
  readonly candidate?: string;
  readonly outputDirectory?: string;
  readonly intent: "equivalent-output" | "quality-adjustment";
};

function parseComparisonArguments(
  args: readonly string[],
): ComparisonArguments {
  let baseline: string | undefined;
  let candidate: string | undefined;
  let outputDirectory: string | undefined;
  let intent: ComparisonArguments["intent"] = "equivalent-output";
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--baseline") baseline = args[++index];
    else if (argument === "--candidate") candidate = args[++index];
    else if (argument === "--output") outputDirectory = args[++index];
    else if (argument === "--intent") {
      const value = args[++index];
      if (value !== "equivalent-output" && value !== "quality-adjustment")
        throw new Error(
          "--intent 必须是 equivalent-output 或 quality-adjustment。",
        );
      intent = value;
    } else throw new Error(`未知比较参数：${String(argument)}`);
  }
  if (!baseline || !candidate)
    throw new Error("报告比较需要 --baseline 和 --candidate 路径。");
  if (outputDirectory === "") throw new Error("--output 路径必须有值。");
  return {
    baseline,
    candidate,
    ...(outputDirectory === undefined ? {} : { outputDirectory }),
    intent,
  };
}

async function runComparison(args: readonly string[]): Promise<void> {
  const options = parseComparisonArguments(args);
  const { report, outputDirectory } = await runPerformanceComparison({
    baselinePath: resolvePath(process.cwd(), options.baseline!),
    candidatePath: resolvePath(process.cwd(), options.candidate!),
    ...(options.outputDirectory === undefined
      ? {}
      : {
          outputDirectory: resolvePath(process.cwd(), options.outputDirectory),
        }),
    intent: options.intent,
  });
  process.stdout.write(
    `比较报告：${outputDirectory}/report.json\n可比性：${report.comparability.status}\n结果：${report.resultComparison.status}\n`,
  );
  if (
    report.comparability.status !== "comparable" ||
    report.resultComparison.status === "incomplete" ||
    report.resultComparison.status === "not-comparable" ||
    (options.intent === "equivalent-output" &&
      report.resultComparison.status !== "equivalent")
  )
    process.exitCode = 1;
}

function parseCleanOutput(args: readonly string[]): string {
  if (args.length !== 2 || args[0] !== "--output" || args[1] === "")
    throw new Error("clean 需要 --output 运行目录。");
  return resolvePath(process.cwd(), args[1]!);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "performance") await runPerformance(args);
  else if (command === "compare") await runComparison(args);
  else if (command === "clean") {
    const directory = parseCleanOutput(args);
    await cleanupRunDirectory(directory);
    process.stdout.write(`已清理临时运行资料，保留报告：${directory}\n`);
  } else
    throw new Error(
      "用法：performance [--scenarios controlled-scale,cfpa] [--external cfpa] [--cfpa-root 目录] [--samples N] [--retries N] [--timeout-ms N] [--group-count N] [--concept-count N] [--seed N] [--rebuild] [--output 目录]；compare --baseline report.json --candidate report.json [--intent equivalent-output|quality-adjustment] [--output 目录]；clean --output 目录",
    );
}

main().catch((error: unknown) => {
  process.stderr.write(
    `术语性能或报告管理执行失败：${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
