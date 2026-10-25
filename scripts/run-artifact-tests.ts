import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  runSubprocess,
  type Artifact,
} from "./artifact-tests/support/consumer.ts";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const scenarioDirectory = path.join(
  repositoryRoot,
  "scripts",
  "artifact-tests",
  "scenarios",
);
const suiteTimeoutMs = 45 * 60 * 1000;
const defaultArtifactCacheDirectory = path.join(
  repositoryRoot,
  "node_modules",
  ".cache",
  "lioni-artifact-tests",
);
const ownedRunMarkerFilename = ".lioni-artifact-suite-run.json";
const ownedRunMarkerVersion = 1;

type CachedArtifact = Artifact & {
  readonly cachePath: string;
  readonly cacheState: "stored" | "reused" | "repaired";
};

function commandFailure(
  label: string,
  result: Awaited<ReturnType<typeof runSubprocess>>,
): Error {
  const reason = result.interrupted
    ? "执行被中断"
    : result.timedOut
      ? `超时（${result.durationMs}ms）`
      : result.error !== undefined
        ? `无法启动：${result.error}`
        : `退出码 ${String(result.status)}${result.signal === null ? "" : `，信号 ${result.signal}`}`;
  return new Error(`${label}失败：${reason}\n${result.stdout}${result.stderr}`);
}

function isFailed(result: Awaited<ReturnType<typeof runSubprocess>>): boolean {
  return (
    result.status !== 0 ||
    result.timedOut ||
    result.interrupted ||
    result.error !== undefined
  );
}

async function runCommand(
  label: string,
  command: string,
  args: readonly string[],
  cwd: string,
  signal: AbortSignal,
  timeoutMs = suiteTimeoutMs,
  forwardOutput = false,
): Promise<Awaited<ReturnType<typeof runSubprocess>>> {
  const outputOptions = forwardOutput
    ? {
        onStdout: (chunk: Buffer): void => {
          process.stdout.write(chunk);
        },
        onStderr: (chunk: Buffer): void => {
          process.stderr.write(chunk);
        },
      }
    : {};
  const result = await runSubprocess(command, args, {
    cwd,
    timeoutMs,
    signal,
    shell: process.platform === "win32",
    ...outputOptions,
  });
  if (isFailed(result)) throw commandFailure(label, result);
  return result;
}

async function discoverScenarios(): Promise<readonly string[]> {
  const files = await readdir(scenarioDirectory);
  return files
    .filter((name) => name.endsWith(".test.ts"))
    .map((name) => name.slice(0, -".test.ts".length))
    .sort();
}

function scenarioName(value: string): string {
  const filename = path.basename(value);
  return filename.endsWith(".test.ts")
    ? filename.slice(0, -".test.ts".length)
    : filename;
}

function selectScenarios(
  available: readonly string[],
  requested: readonly string[],
): readonly string[] {
  const selected =
    requested.length === 0
      ? available
      : [...new Set(requested.map(scenarioName))];
  const unknown = selected.filter((name) => !available.includes(name));
  assert.deepEqual(
    unknown,
    [],
    `未知场景：${unknown.join("、")}。可选场景：${available.join("、")}`,
  );
  assert.ok(selected.length > 0, "没有可运行的制品场景。");
  return selected;
}

async function packArtifacts(
  artifactRoot: string,
  artifactCacheDirectory: string,
  signal: AbortSignal,
  packageSelection: readonly string[],
): Promise<readonly CachedArtifact[]> {
  const packageResult = await runCommand(
    "读取正式包清单",
    "pnpm",
    [
      "--filter",
      "@lioni/*",
      "--filter",
      "!@lioni/tooling-config",
      "list",
      "--recursive",
      "--depth",
      "-1",
      "--json",
    ],
    repositoryRoot,
    signal,
  );
  const packages = JSON.parse(packageResult.stdout) as readonly {
    readonly name: string;
    readonly version: string;
  }[];
  assert.ok(packages.length > 0, "正式制品清单没有可打包的 Lioni 包。");

  const selectedPackages =
    packageSelection.length === 0
      ? packages
      : packages.filter(({ name }) => packageSelection.includes(name));
  const missingPackages = packageSelection.filter(
    (name) => !selectedPackages.some((pkg) => pkg.name === name),
  );
  assert.deepEqual(missingPackages, [], "请求的包不在正式制品清单中。");
  assert.ok(selectedPackages.length > 0, "正式制品清单选择结果为空。");

  const artifacts: CachedArtifact[] = [];
  await mkdir(artifactCacheDirectory, { recursive: true });
  for (const { name, version } of selectedPackages) {
    const packed = await runCommand(
      `打包 ${name}`,
      "pnpm",
      ["--filter", name, "pack", "--pack-destination", artifactRoot, "--json"],
      repositoryRoot,
      signal,
    );
    const artifact = JSON.parse(packed.stdout) as Omit<Artifact, "sha256">;
    assert.equal(artifact.name, name, `pnpm pack 返回了错误包名：${name}`);
    assert.equal(
      artifact.version,
      version,
      `pnpm pack 返回了错误版本：${name}`,
    );
    const sha256 = createHash("sha256")
      .update(await readFile(artifact.filename))
      .digest("hex");
    const safeName = name.replace(/^@/u, "").replaceAll("/", "-");
    const cachePath = path.join(
      artifactCacheDirectory,
      `${safeName}-${version}-${sha256}.tgz`,
    );
    let cacheState: CachedArtifact["cacheState"] = "stored";
    try {
      const cachedSha256 = createHash("sha256")
        .update(await readFile(cachePath))
        .digest("hex");
      if (cachedSha256 === sha256) cacheState = "reused";
      else cacheState = "repaired";
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      )
        throw error;
    }

    if (cacheState !== "reused") {
      const temporaryCachePath = `${cachePath}.tmp-${randomUUID()}`;
      try {
        await copyFile(artifact.filename, temporaryCachePath);
        await rm(cachePath, { force: true });
        await rename(temporaryCachePath, cachePath);
      } finally {
        await rm(temporaryCachePath, { force: true });
      }
      const cachedSha256 = createHash("sha256")
        .update(await readFile(cachePath))
        .digest("hex");
      assert.equal(cachedSha256, sha256, `制品缓存校验失败：${name}`);
    }
    artifacts.push({
      name,
      version,
      filename: cachePath,
      sha256,
      cachePath,
      cacheState,
    });
  }
  return artifacts;
}

function printSelection(selected: readonly string[]): void {
  process.stdout.write(`本次选择 ${selected.length} 个制品场景：\n`);
  for (const name of selected) process.stdout.write(`- ${name}\n`);
}

async function writeSuiteResult(
  resultsRoot: string,
  result: Record<string, unknown>,
): Promise<void> {
  await mkdir(resultsRoot, { recursive: true });
  await writeFile(
    path.join(resultsRoot, "suite.json"),
    JSON.stringify(result, null, 2),
    "utf8",
  );
}

async function cleanOwnedRun(runPath: string): Promise<void> {
  const runRoot = path.resolve(runPath);
  const markerPath = path.join(runRoot, ownedRunMarkerFilename);
  const marker = JSON.parse(await readFile(markerPath, "utf8")) as {
    readonly version: number;
    readonly runRoot: string;
  };
  assert.equal(
    marker.version,
    ownedRunMarkerVersion,
    "运行现场标记版本不受支持。",
  );
  assert.equal(marker.runRoot, runRoot, "运行现场标记与目录路径不匹配。");

  const removed: string[] = [];
  for (const entry of await readdir(runRoot, { withFileTypes: true })) {
    const isConsumer =
      entry.isDirectory() && entry.name.startsWith("consumer-");
    if (!entry.isDirectory() || (entry.name !== "artifacts" && !isConsumer))
      continue;
    await rm(path.join(runRoot, entry.name), { recursive: true, force: true });
    removed.push(entry.name);
  }
  process.stdout.write(
    `${JSON.stringify({ status: "cleaned", runRoot, removed }, null, 2)}\n`,
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((argument) => argument !== "--");
  let listOnly = false;
  let prepareOnly = false;
  let cleanRunPath: string | undefined;
  const requested: string[] = [];
  const packageSelection: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) continue;
    if (argument === "--list") listOnly = true;
    else if (argument === "--prepare-only") prepareOnly = true;
    else if (argument === "--scenario") {
      const scenario = args[index + 1];
      assert.ok(scenario, "--scenario 后必须指定场景名称。");
      requested.push(scenario);
      index += 1;
    } else if (argument === "--clean-run") {
      const runPath = args[index + 1];
      assert.ok(runPath, "--clean-run 后必须指定运行现场路径。");
      cleanRunPath = runPath;
      index += 1;
    } else if (argument === "--package") {
      const packageName = args[index + 1];
      assert.ok(packageName, "--package 后必须指定包名。");
      packageSelection.push(packageName);
      index += 1;
    } else requested.push(argument);
  }
  assert.ok(!(listOnly && prepareOnly), "--list 与 --prepare-only 不能并用。");
  assert.ok(
    cleanRunPath === undefined ||
      (!listOnly &&
        !prepareOnly &&
        requested.length === 0 &&
        packageSelection.length === 0),
    "--clean-run 只能单独使用。",
  );
  assert.ok(
    prepareOnly || packageSelection.length === 0,
    "--package 只可与 --prepare-only 并用。",
  );
  assert.ok(
    !prepareOnly || requested.length === 0,
    "--prepare-only 不接收场景名称。",
  );
  if (cleanRunPath !== undefined) {
    await cleanOwnedRun(cleanRunPath);
    return;
  }
  const available = await discoverScenarios();
  const selected = prepareOnly ? [] : selectScenarios(available, requested);
  if (listOnly) {
    printSelection(selected);
    return;
  }
  if (prepareOnly)
    process.stdout.write("只准备并验证正式制品缓存，不执行场景。\n");
  else printSelection(selected);

  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "lioni-artifact-test-suite-"),
  );
  await writeFile(
    path.join(temporaryRoot, ownedRunMarkerFilename),
    JSON.stringify({ version: ownedRunMarkerVersion, runRoot: temporaryRoot }),
    { flag: "wx" },
  );
  const artifactRoot = path.join(temporaryRoot, "artifacts");
  const resultsRoot = path.join(temporaryRoot, "results");
  const artifactManifestPath = path.join(temporaryRoot, "artifacts.json");
  const artifactCacheDirectory = path.resolve(
    repositoryRoot,
    process.env.LIONI_ARTIFACT_CACHE ?? defaultArtifactCacheDirectory,
  );
  await Promise.all([
    mkdir(artifactRoot, { recursive: true }),
    mkdir(resultsRoot, { recursive: true }),
  ]);
  const controller = new AbortController();
  let interruptedBy: NodeJS.Signals | undefined;
  const interrupt = (signal: NodeJS.Signals): void => {
    interruptedBy = signal;
    controller.abort();
  };
  const handleInterrupt = (): void => interrupt("SIGINT");
  const handleTerminate = (): void => interrupt("SIGTERM");
  process.on("SIGINT", handleInterrupt);
  process.on("SIGTERM", handleTerminate);
  const startedAt = new Date().toISOString();
  let suiteStatus: "passed" | "failed" = "failed";
  let failure: string | undefined;
  let artifactIdentity: readonly {
    readonly name: string;
    readonly version: string;
    readonly sha256: string;
    readonly cacheState: CachedArtifact["cacheState"];
    readonly cachePath: string;
  }[] = [];

  try {
    const artifacts = await packArtifacts(
      artifactRoot,
      artifactCacheDirectory,
      controller.signal,
      packageSelection,
    );
    artifactIdentity = artifacts.map(
      ({ name, version, sha256, cacheState, cachePath }) => ({
        name,
        version,
        sha256,
        cacheState,
        cachePath,
      }),
    );
    await writeFile(
      artifactManifestPath,
      JSON.stringify(artifacts, null, 2),
      "utf8",
    );
    if (prepareOnly) {
      process.stdout.write(
        `${JSON.stringify(
          {
            status: "prepared",
            artifacts: artifactIdentity,
          },
          null,
          2,
        )}\n`,
      );
      suiteStatus = "passed";
    } else {
      const testFiles = selected.map((name) =>
        path.join(scenarioDirectory, `${name}.test.ts`),
      );
      const testEnvironment: NodeJS.ProcessEnv = {
        ...process.env,
        LIONI_ARTIFACT_MANIFEST: artifactManifestPath,
        LIONI_ARTIFACT_RESULTS: resultsRoot,
        LIONI_ARTIFACT_RUN_ROOT: temporaryRoot,
        LIONI_ARTIFACT_SELECTED_SCENARIOS: JSON.stringify(selected),
        LIONI_ARTIFACT_REQUESTED_SCENARIOS: JSON.stringify(requested),
        LIONI_REPOSITORY_ROOT: repositoryRoot,
        LIONI_TSC_EXECUTABLE: path.join(
          repositoryRoot,
          "node_modules",
          ".bin",
          process.platform === "win32" ? "tsc.cmd" : "tsc",
        ),
      };
      if (process.env.LIONI_KEEP_ARTIFACT_TESTS === "1")
        testEnvironment.LIONI_KEEP_ARTIFACT_TESTS = "1";
      else delete testEnvironment.LIONI_KEEP_ARTIFACT_TESTS;
      const testResult = await runSubprocess(
        process.execPath,
        [
          "--conditions=source",
          "--import",
          path.join(
            repositoryRoot,
            "scripts",
            "artifact-tests",
            "support",
            "external-interrupt.ts",
          ),
          "--test",
          "--test-reporter=spec",
          "--test-concurrency=1",
          ...testFiles,
        ],
        {
          cwd: repositoryRoot,
          env: testEnvironment,
          signal: controller.signal,
          interruptSignal: "SIGTERM",
          terminationGraceMs: 2_000,
          timeoutMs: suiteTimeoutMs,
          onStdout: (chunk) => process.stdout.write(chunk),
          onStderr: (chunk) => process.stderr.write(chunk),
        },
      );
      if (isFailed(testResult))
        throw commandFailure("node:test 制品套件", testResult);
      suiteStatus = "passed";
    }
  } catch (error) {
    failure =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${failure}\n`);
  } finally {
    process.off("SIGINT", handleInterrupt);
    process.off("SIGTERM", handleTerminate);
    await writeSuiteResult(resultsRoot, {
      status: suiteStatus,
      prepareOnly,
      selected,
      artifacts: artifactIdentity,
      node: process.version,
      platform: process.platform,
      startedAt,
      finishedAt: new Date().toISOString(),
      interruptedBy,
      failure,
    });
  }

  if (
    suiteStatus === "failed" ||
    process.env.LIONI_KEEP_ARTIFACT_TESTS === "1"
  ) {
    process.stdout.write(`保留制品测试现场：${temporaryRoot}\n`);
  } else {
    await rm(temporaryRoot, { recursive: true, force: true });
  }

  if (suiteStatus === "failed")
    process.exitCode = interruptedBy === "SIGINT" ? 130 : 1;
}

await main();
