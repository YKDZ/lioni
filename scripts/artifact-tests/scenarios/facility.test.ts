import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  runSubprocess,
  scenarioResultsFilename,
  type ScenarioResult,
} from "../support/consumer.ts";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

async function waitForFile(file: string): Promise<string | undefined> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    try {
      return await readFile(file, "utf8");
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  return undefined;
}

async function waitForProcessExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const contents = await readFile(`/proc/${pid}/stat`, "utf8");
      const state = contents.slice(contents.lastIndexOf(")") + 2)[0];
      if (state === "Z" || state === "X") return;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  assert.fail(`中断后的消费者进程仍存活：${pid}`);
}

async function runNestedAbortProbe(
  mode: "cooperative" | "ignore",
  suiteInterrupt = false,
): Promise<ScenarioResult> {
  const root = await mkdtemp(
    path.join(tmpdir(), "lioni-artifact-nested-abort-"),
  );
  const runRoot = path.join(root, "runs");
  const resultsRoot = path.join(root, "results");
  const manifestPath = path.join(root, "artifacts.json");
  const pidPath = path.join(root, "consumer.pid");
  const fixture = path.join(
    repositoryRoot,
    "scripts",
    "artifact-tests",
    "support",
    "nested-interrupt-evidence.ts",
  );
  const interruptModule = path.join(
    repositoryRoot,
    "scripts",
    "artifact-tests",
    "support",
    "external-interrupt.ts",
  );
  await Promise.all([
    mkdir(runRoot, { recursive: true }),
    mkdir(resultsRoot, { recursive: true }),
    writeFile(manifestPath, "[]\n", "utf8"),
  ]);
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    LIONI_ARTIFACT_MANIFEST: manifestPath,
    LIONI_ARTIFACT_RESULTS: resultsRoot,
    LIONI_ARTIFACT_RUN_ROOT: runRoot,
    LIONI_ABORT_PROBE_MODE: mode,
    LIONI_ABORT_PROBE_PID_FILE: pidPath,
  };
  delete environment.NODE_TEST_CONTEXT;
  const controller = new AbortController();
  const args = [
    "--conditions=source",
    ...(suiteInterrupt ? ["--import", interruptModule] : []),
    "--test",
    fixture,
  ];
  const task = runSubprocess(process.execPath, args, {
    cwd: repositoryRoot,
    env: environment,
    signal: controller.signal,
    ...(suiteInterrupt
      ? { interruptSignal: "SIGTERM" as const, terminationGraceMs: 2_000 }
      : {}),
    timeoutMs: 15_000,
  });

  let pid: number | undefined;
  try {
    const processId = await waitForFile(pidPath);
    assert.ok(processId, "嵌套消费者没有启动。");
    pid = Number(processId);
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    controller.abort();
    const interrupted = await task;
    assert.equal(interrupted.interrupted, true);
    await waitForProcessExit(pid);

    const output = await waitForFile(
      path.join(resultsRoot, scenarioResultsFilename),
    );
    assert.ok(output, "中断场景没有保存结果记录。");
    const records = output
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as ScenarioResult);
    assert.equal(records.length, 1);
    const record = records[0];
    assert.ok(record);
    assert.equal(record.status, "failed");
    assert.match(record.failure ?? "", /执行被中断/u);
    if (mode === "ignore") assert.match(record.failure ?? "", /SIGKILL/u);
    assert.ok(record.consumerRoot);
    assert.ok((await stat(record.consumerRoot)).isDirectory());
    assert.equal(
      await readFile(path.join(record.consumerRoot, "sigterm"), "utf8"),
      mode === "ignore" ? "ignored" : "stopped",
    );
    return record;
  } finally {
    if (!controller.signal.aborted) controller.abort();
    await task;
    if (pid !== undefined) await waitForProcessExit(pid);
    await rm(root, { recursive: true, force: true });
  }
}

async function runFailureFixture(
  fixtureName: string,
  expectedFailure: RegExp,
  stoppedChildMarker?: string,
): Promise<ScenarioResult> {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "lioni-artifact-failure-report-"),
  );
  const consumerRoot = path.join(temporaryRoot, "consumers");
  const resultsRoot = path.join(temporaryRoot, "results");
  const artifactManifest = path.join(temporaryRoot, "artifacts.json");
  await Promise.all([
    mkdir(consumerRoot, { recursive: true }),
    mkdir(resultsRoot, { recursive: true }),
    writeFile(artifactManifest, "[]\n", "utf8"),
  ]);

  try {
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      LIONI_ARTIFACT_MANIFEST: artifactManifest,
      LIONI_ARTIFACT_RESULTS: resultsRoot,
      LIONI_ARTIFACT_RUN_ROOT: consumerRoot,
    };
    delete environment.NODE_TEST_CONTEXT;
    const fixture = path.join(
      repositoryRoot,
      "scripts",
      "artifact-tests",
      "support",
      fixtureName,
    );
    const failed = await runSubprocess(
      process.execPath,
      ["--conditions=source", "--test", fixture],
      {
        cwd: repositoryRoot,
        timeoutMs: 10_000,
        env: environment,
      },
    );
    assert.equal(failed.status, 1, failed.stdout + failed.stderr);
    const records = (
      await readFile(path.join(resultsRoot, scenarioResultsFilename), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as ScenarioResult);
    assert.equal(records.length, 1);
    const result = records[0];
    assert.ok(result);
    assert.equal(result.status, "failed");
    assert.match(result.failure ?? "", expectedFailure);
    assert.ok(result.consumerRoot);
    assert.ok(
      result.consumerRoot.startsWith(`${consumerRoot}${path.sep}`),
      result.consumerRoot,
    );
    assert.ok((await stat(result.consumerRoot)).isDirectory());
    if (stoppedChildMarker !== undefined)
      assert.equal(
        await readFile(
          path.join(result.consumerRoot, stoppedChildMarker),
          "utf8",
        ),
        "stopped",
      );
    return result;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function prepareCoreArtifact(cacheRoot: string): Promise<{
  readonly name: string;
  readonly sha256: string;
  readonly cacheState: "stored" | "reused" | "repaired";
  readonly cachePath: string;
}> {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    LIONI_ARTIFACT_CACHE: cacheRoot,
  };
  delete environment.LIONI_KEEP_ARTIFACT_TESTS;
  const result = await runSubprocess(
    "pnpm",
    ["verify:artifacts", "--", "--prepare-only", "--package", "@lioni/core"],
    {
      cwd: repositoryRoot,
      env: environment,
      timeoutMs: 60_000,
      shell: process.platform === "win32",
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.timedOut, false);
  assert.equal(result.error, undefined);
  const reportStart = result.stdout.indexOf("{");
  assert.notEqual(reportStart, -1, result.stdout);
  const reportEnd = findJsonObjectEnd(result.stdout, reportStart);
  const report = JSON.parse(result.stdout.slice(reportStart, reportEnd)) as {
    readonly status: string;
    readonly artifacts: readonly {
      readonly name: string;
      readonly sha256: string;
      readonly cacheState: "stored" | "reused" | "repaired";
      readonly cachePath: string;
    }[];
  };
  assert.equal(report.status, "prepared");
  assert.equal(report.artifacts.length, 1);
  const artifact = report.artifacts[0];
  assert.ok(artifact);
  assert.equal(artifact.name, "@lioni/core");
  return artifact;
}

function retainedRunPath(output: string): string {
  const marker = "保留制品测试现场：";
  const line = output.split("\n").find((value) => value.startsWith(marker));
  assert.ok(line, output);
  return line.slice(marker.length);
}

async function cleanRun(runRoot: string): Promise<{
  readonly status: string;
  readonly removed: readonly string[];
}> {
  const result = await runSubprocess(
    "pnpm",
    ["verify:artifacts", "--", "--clean-run", runRoot],
    {
      cwd: repositoryRoot,
      timeoutMs: 10_000,
      shell: process.platform === "win32",
    },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const start = result.stdout.indexOf("{");
  assert.notEqual(start, -1, result.stdout);
  const end = findJsonObjectEnd(result.stdout, start);
  return JSON.parse(result.stdout.slice(start, end)) as {
    readonly status: string;
    readonly removed: readonly string[];
  };
}

function findJsonObjectEnd(output: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < output.length; index += 1) {
    const character = output[index];
    if (character === undefined) continue;
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  throw new Error("缓存准备结果中没有完整 JSON 对象。");
}

void test("超时会终止子进程树，中断后仍能运行新进程", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lioni-artifact-process-"));
  try {
    const timeoutMarker = path.join(root, "timeout-child-stopped");
    const childSource = [
      `process.on("SIGTERM", () => { require("node:fs").writeFileSync(${JSON.stringify(timeoutMarker)}, "stopped"); process.exit(0); });`,
      "setInterval(() => {}, 1000)",
    ].join(";");
    const parentSource = [
      `const { spawn } = require("node:child_process"); spawn(process.execPath, ["-e", ${JSON.stringify(childSource)}], { stdio: "ignore" });`,
      "setInterval(() => {}, 1000)",
    ].join(";");
    const expired = await runSubprocess(
      process.execPath,
      ["-e", parentSource],
      { cwd: root, timeoutMs: 40 },
    );
    assert.equal(expired.timedOut, true);
    assert.ok(expired.signal !== null || expired.status !== 0);
    assert.equal(await waitForFile(timeoutMarker), "stopped");

    const interruptMarker = path.join(root, "interrupt-child-stopped");
    const interruptChildSource = childSource.replace(
      timeoutMarker,
      interruptMarker,
    );
    const interruptParentSource = [
      `const { spawn } = require("node:child_process"); spawn(process.execPath, ["-e", ${JSON.stringify(interruptChildSource)}], { stdio: "ignore" });`,
      "setInterval(() => {}, 1000)",
    ].join(";");
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 40);
    const interrupted = await runSubprocess(
      process.execPath,
      ["-e", interruptParentSource],
      { cwd: root, timeoutMs: 1_000, signal: controller.signal },
    );
    assert.equal(interrupted.interrupted, true);
    assert.equal(interrupted.timedOut, false);
    assert.equal(await waitForFile(interruptMarker), "stopped");

    const recovered = await runSubprocess(
      process.execPath,
      ["-e", "process.stdout.write('ready')"],
      { cwd: root, timeoutMs: 1_000 },
    );
    assert.equal(recovered.timedOut, false);
    assert.equal(recovered.status, 0);
    assert.equal(recovered.stdout, "ready");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("套件外层中断会回收嵌套消费者并保存失败记录", async () => {
  await runNestedAbortProbe("cooperative");
  await runNestedAbortProbe("ignore", true);
});

void test("公开入口按请求选择场景", async () => {
  const selection = await runSubprocess(
    "pnpm",
    [
      "verify:artifacts",
      "--",
      "--list",
      "--scenario",
      "facility",
      "--scenario",
      "composition",
    ],
    {
      cwd: repositoryRoot,
      timeoutMs: 5_000,
      shell: process.platform === "win32",
    },
  );
  assert.equal(selection.status, 0, selection.stderr);
  assert.deepEqual(
    selection.stdout.split("\n").filter((line) => line.startsWith("- ")),
    ["- facility", "- composition"],
  );
});

void test("失败场景保存结果并保留现场", async () => {
  const result = await runFailureFixture(
    "failure-evidence.ts",
    /制品清单缺少场景声明的包/u,
  );
  assert.equal(result.name, "设施验收：制品缺失时记录失败");
});

void test("正式制品缓存校验、损坏修复和缺失重建", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lioni-artifact-cache-"));
  try {
    const first = await prepareCoreArtifact(root);
    assert.equal(first.cacheState, "stored");

    const second = await prepareCoreArtifact(root);
    assert.equal(second.cacheState, "reused");
    assert.equal(second.sha256, first.sha256);
    assert.equal(second.cachePath, first.cachePath);

    await writeFile(first.cachePath, "损坏的制品缓存", "utf8");
    const repaired = await prepareCoreArtifact(root);
    assert.equal(repaired.cacheState, "repaired");
    assert.equal(repaired.sha256, first.sha256);
    assert.equal(
      createHash("sha256")
        .update(await readFile(repaired.cachePath))
        .digest("hex"),
      repaired.sha256,
    );

    await rm(repaired.cachePath, { force: true });
    const rebuilt = await prepareCoreArtifact(root);
    assert.equal(rebuilt.cacheState, "stored");
    assert.equal(rebuilt.sha256, first.sha256);
    assert.equal(
      createHash("sha256")
        .update(await readFile(rebuilt.cachePath))
        .digest("hex"),
      rebuilt.sha256,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("保留运行现场可重复清理并保留失败报告和外部哨兵", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lioni-artifact-cleanup-"));
  const cacheRoot = path.join(root, "artifact-cache");
  const externalSentinel = path.join(root, "external-sentinel.txt");
  let retainedRoot: string | undefined;
  try {
    await writeFile(externalSentinel, "keep\n", "utf8");
    const cachedArtifact = await prepareCoreArtifact(cacheRoot);
    const failedRun = await runSubprocess(
      "pnpm",
      [
        "verify:artifacts",
        "--",
        "--prepare-only",
        "--package",
        "@lioni/unknown",
      ],
      {
        cwd: repositoryRoot,
        timeoutMs: 60_000,
        env: { ...process.env, LIONI_ARTIFACT_CACHE: cacheRoot },
        shell: process.platform === "win32",
      },
    );
    assert.equal(failedRun.status, 1, failedRun.stdout + failedRun.stderr);
    retainedRoot = retainedRunPath(failedRun.stdout);

    const markerPath = path.join(
      retainedRoot,
      ".lioni-artifact-suite-run.json",
    );
    const reportPath = path.join(retainedRoot, "results", "suite.json");
    const failedReport = await readFile(reportPath, "utf8");
    assert.equal(
      (JSON.parse(failedReport) as { readonly status: string }).status,
      "failed",
    );
    const consumerPath = path.join(retainedRoot, "consumer-facility-sentinel");
    const temporaryArtifactPath = path.join(
      retainedRoot,
      "artifacts",
      "discarded.tgz",
    );
    const operatorSentinel = path.join(retainedRoot, "operator-sentinel.txt");
    await mkdir(consumerPath, { recursive: true });
    await Promise.all([
      writeFile(path.join(consumerPath, "temporary.txt"), "remove\n", "utf8"),
      writeFile(temporaryArtifactPath, "remove\n", "utf8"),
      writeFile(operatorSentinel, "keep\n", "utf8"),
    ]);

    const firstCleanup = await cleanRun(retainedRoot);
    assert.equal(firstCleanup.status, "cleaned");
    assert.ok(firstCleanup.removed.includes("artifacts"));
    assert.ok(firstCleanup.removed.includes("consumer-facility-sentinel"));
    await assert.rejects(stat(consumerPath));
    await assert.rejects(stat(path.join(retainedRoot, "artifacts")));
    assert.equal(await readFile(reportPath, "utf8"), failedReport);
    assert.ok((await stat(markerPath)).isFile());
    assert.equal(await readFile(operatorSentinel, "utf8"), "keep\n");
    assert.equal(await readFile(externalSentinel, "utf8"), "keep\n");
    assert.equal(
      createHash("sha256")
        .update(await readFile(cachedArtifact.cachePath))
        .digest("hex"),
      cachedArtifact.sha256,
    );

    const secondCleanup = await cleanRun(retainedRoot);
    assert.equal(secondCleanup.status, "cleaned");
    assert.deepEqual(secondCleanup.removed, []);
    assert.equal(await readFile(reportPath, "utf8"), failedReport);
    assert.equal(await readFile(operatorSentinel, "utf8"), "keep\n");
    assert.equal(await readFile(externalSentinel, "utf8"), "keep\n");

    const unownedRoot = path.join(root, "unowned-run");
    const unownedSentinel = path.join(unownedRoot, "operator-sentinel.txt");
    await mkdir(unownedRoot, { recursive: true });
    await writeFile(unownedSentinel, "keep\n", "utf8");
    const rejectedCleanup = await runSubprocess(
      "pnpm",
      ["verify:artifacts", "--", "--clean-run", unownedRoot],
      {
        cwd: repositoryRoot,
        timeoutMs: 10_000,
        shell: process.platform === "win32",
      },
    );
    assert.equal(rejectedCleanup.status, 1);
    assert.equal(await readFile(unownedSentinel, "utf8"), "keep\n");

    const rerunArtifact = await prepareCoreArtifact(cacheRoot);
    assert.equal(rerunArtifact.cacheState, "reused");
    assert.equal(rerunArtifact.sha256, cachedArtifact.sha256);
  } finally {
    if (retainedRoot !== undefined)
      await rm(retainedRoot, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

void test("子进程超时作为失败写入场景结果", async () => {
  const result = await runFailureFixture("timeout-evidence.ts", /超时/u);
  assert.equal(result.name, "设施验收：子进程超时记为失败");
});

void test("node:test 超时会中断进程树并保存失败现场", async () => {
  const result = await runFailureFixture(
    "node-test-timeout.ts",
    /执行被中断/u,
    "node-test-timeout-child-stopped",
  );
  assert.equal(result.name, "设施验收：node:test 超时中断子进程树");
});
