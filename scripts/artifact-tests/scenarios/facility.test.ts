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
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      return await readFile(file, "utf8");
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  return undefined;
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
  const result = await runSubprocess(
    "pnpm",
    ["verify:artifacts", "--", "--prepare-only", "--package", "@lioni/core"],
    {
      cwd: repositoryRoot,
      env: { ...process.env, LIONI_ARTIFACT_CACHE: cacheRoot },
      timeoutMs: 60_000,
      shell: process.platform === "win32",
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.timedOut, false);
  assert.equal(result.error, undefined);
  const reportStart = result.stdout.indexOf("{");
  assert.notEqual(reportStart, -1, result.stdout);
  const report = JSON.parse(result.stdout.slice(reportStart)) as {
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

void test("公开入口按请求选择场景", async () => {
  const selection = await runSubprocess(
    "pnpm",
    ["verify:artifacts", "--", "--list", "facility", "composition"],
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
