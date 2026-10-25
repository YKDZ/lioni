import { runQualityEvaluation } from "./quality.ts";
import { resolvePath } from "./support/json.ts";
import { cleanupRunDirectory } from "./support/run-directory.ts";

type ParsedArguments = {
  readonly outputDirectory?: string;
  readonly scenarios?: readonly ("controlled" | "cfpa" | "kuma")[];
  readonly external: readonly ("cfpa" | "kuma")[];
  readonly cfpaRoot?: string;
  readonly kumaRoot?: string;
  readonly retries: number;
  readonly timeoutMs: number | undefined;
  readonly generatedEntryCount: number;
  readonly rebuild: boolean;
};

function parseArguments(args: readonly string[]): ParsedArguments {
  let outputDirectory: string | undefined;
  let scenarios: ("controlled" | "cfpa" | "kuma")[] | undefined;
  let cfpaRoot: string | undefined;
  let kumaRoot: string | undefined;
  let external: ("cfpa" | "kuma")[] = [];
  let retries = 0;
  let timeoutMs: number | undefined;
  let generatedEntryCount = 64;
  let rebuild = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--output") outputDirectory = args[++index];
    else if (argument === "--scenarios") {
      const value = args[++index];
      if (value === undefined) throw new Error("--scenarios 需要场景名称。");
      scenarios = value.split(",").map((name) => {
        if (name !== "controlled" && name !== "cfpa" && name !== "kuma")
          throw new Error(`不支持的评估场景：${name}`);
        return name;
      });
    } else if (argument === "--external") {
      const value = args[++index];
      if (value === undefined) throw new Error("--external 需要语料名称。");
      external = value.split(",").map((name) => {
        if (name !== "cfpa" && name !== "kuma")
          throw new Error(`不支持的外部语料：${name}`);
        return name;
      });
    } else if (argument === "--cfpa-root") cfpaRoot = args[++index];
    else if (argument === "--kuma-root") kumaRoot = args[++index];
    else if (argument === "--retries") {
      const value = Number(args[++index]);
      if (!Number.isSafeInteger(value)) throw new Error("--retries 需要整数。");
      retries = value;
    } else if (argument === "--timeout-ms") {
      const value = Number(args[++index]);
      if (!Number.isSafeInteger(value))
        throw new Error("--timeout-ms 需要整数。");
      timeoutMs = value;
    } else if (argument === "--generated-count") {
      const value = Number(args[++index]);
      if (!Number.isSafeInteger(value))
        throw new Error("--generated-count 需要整数。");
      generatedEntryCount = value;
    } else if (argument === "--rebuild") rebuild = true;
    else throw new Error(`未知参数：${String(argument)}`);
  }
  if (outputDirectory === "" || cfpaRoot === "" || kumaRoot === "")
    throw new Error("路径参数必须有值。");
  return {
    ...(outputDirectory === undefined ? {} : { outputDirectory }),
    ...(scenarios === undefined
      ? {}
      : { scenarios: Object.freeze([...new Set(scenarios)]) }),
    external: Object.freeze([...new Set(external)]),
    ...(cfpaRoot === undefined ? {} : { cfpaRoot }),
    ...(kumaRoot === undefined ? {} : { kumaRoot }),
    retries,
    timeoutMs,
    generatedEntryCount,
    rebuild,
  };
}

function absolutePath(value: string | undefined): string | undefined {
  return value === undefined ? undefined : resolvePath(process.cwd(), value);
}

async function runQuality(args: readonly string[]): Promise<void> {
  const options = parseArguments(args);
  const outputDirectory = absolutePath(options.outputDirectory);
  const cfpaRoot = absolutePath(options.cfpaRoot);
  const kumaRoot = absolutePath(options.kumaRoot);
  const { timeoutMs, ...definedOptions } = options;
  const abortController = new AbortController();
  const interrupt = () => abortController.abort();
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    const { report, outputDirectory: resultDirectory } =
      await runQualityEvaluation({
        ...definedOptions,
        ...(outputDirectory === undefined ? {} : { outputDirectory }),
        ...(cfpaRoot === undefined ? {} : { cfpaRoot }),
        ...(kumaRoot === undefined ? {} : { kumaRoot }),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        signal: abortController.signal,
      });
    process.stdout.write(
      `评估报告：${resultDirectory}/report.json\n执行状态：${report.status}\n`,
    );
    if (report.status === "failed") process.exitCode = 1;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "quality") await runQuality(args);
  else if (command === "clean") {
    const options = parseArguments(args);
    if (options.outputDirectory === undefined)
      throw new Error("clean 需要 --output 运行目录。");
    const directory = absolutePath(options.outputDirectory)!;
    await cleanupRunDirectory(directory);
    process.stdout.write(`已清理临时运行资料，保留报告：${directory}\n`);
  } else
    throw new Error(
      "用法：quality [--scenarios controlled,cfpa,kuma] [--external cfpa,kuma] [--cfpa-root 目录] [--kuma-root 目录] [--generated-count N] [--retries N] [--timeout-ms N] [--rebuild] [--output 目录]；clean --output 目录",
    );
}

main().catch((error: unknown) => {
  process.stderr.write(
    `术语质量评估执行失败：${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
