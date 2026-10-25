import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  appendFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

export type Artifact = {
  readonly name: string;
  readonly version: string;
  readonly filename: string;
  readonly sha256: string;
};

export type ProcessResult = {
  readonly command: string;
  readonly args: readonly string[];
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly error: string | undefined;
  readonly durationMs: number;
};

export type ProcessOptions = {
  readonly cwd: string;
  readonly timeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
};

export type Consumer = {
  readonly root: string;
  readonly runNode: (
    file: string,
    args?: readonly string[],
    timeoutMs?: number,
  ) => Promise<ProcessResult>;
  readonly typecheck: () => Promise<ProcessResult>;
};

export type ConsumerScenarioOptions = {
  readonly name: string;
  readonly packages: readonly string[];
  readonly fixtures?: URL;
  readonly timeoutMs?: number;
};

export type ConsumerScenario = (consumer: Consumer) => Promise<void> | void;

const defaultProcessTimeoutMs = 10 * 60 * 1000;
const defaultTestTimeoutMs = 15 * 60 * 1000;
const terminationGraceMs = 500;
const maxOutputBytes = 32 * 1024 * 1024;

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  assert.ok(value, `制品套件入口未设置 ${name}。`);
  return value;
}

function retainOutput(current: string, chunk: Buffer): string {
  const available = Math.max(0, maxOutputBytes - Buffer.byteLength(current));
  if (available === 0) return current;
  return current + chunk.subarray(0, available).toString("utf8");
}

function signalProcessTree(
  child: ReturnType<typeof spawn>,
  signal: NodeJS.Signals,
): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform !== "win32") process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The child already exited.
    }
  }
}

/** Run one external command with a bounded lifetime and a recoverable result. */
export function runSubprocess(
  command: string,
  args: readonly string[],
  options: ProcessOptions,
): Promise<ProcessResult> {
  const timeoutMs = options.timeoutMs ?? defaultProcessTimeoutMs;
  assert.ok(
    Number.isFinite(timeoutMs) && timeoutMs > 0,
    "子进程超时必须为正数。",
  );
  const startedAt = Date.now();

  return new Promise((resolveResult) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    let forceKill: NodeJS.Timeout | undefined;

    const settle = (result: Omit<ProcessResult, "durationMs">): void => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      if (forceKill !== undefined) clearTimeout(forceKill);
      resolveResult({ ...result, durationMs: Date.now() - startedAt });
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = retainOutput(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = retainOutput(stderr, chunk);
    });
    child.once("error", (error) => {
      settle({
        command,
        args,
        status: null,
        signal: null,
        stdout,
        stderr,
        timedOut,
        error: error.message,
      });
    });
    child.once("close", (status, signal) => {
      settle({
        command,
        args,
        status,
        signal,
        stdout,
        stderr,
        timedOut,
        error: undefined,
      });
    });
    timeout = setTimeout(() => {
      timedOut = true;
      signalProcessTree(child, "SIGTERM");
      forceKill = setTimeout(
        () => signalProcessTree(child, "SIGKILL"),
        terminationGraceMs,
      );
    }, timeoutMs);
  });
}

function commandFailure(label: string, result: ProcessResult): Error {
  const reason = result.timedOut
    ? `超时（${result.durationMs}ms）`
    : result.error !== undefined
      ? `无法启动：${result.error}`
      : `退出码 ${String(result.status)}${result.signal === null ? "" : `，信号 ${result.signal}`}`;
  return new Error(`${label}失败：${reason}\n${result.stdout}${result.stderr}`);
}

async function recordScenarioResult(
  name: string,
  result: {
    readonly status: "passed" | "failed";
    readonly startedAt: string;
    readonly finishedAt: string;
    readonly consumerRoot: string | undefined;
    readonly failure: string | undefined;
  },
): Promise<void> {
  const resultsRoot = process.env.LIONI_ARTIFACT_RESULTS;
  if (resultsRoot === undefined) return;
  await mkdir(resultsRoot, { recursive: true });
  const record = {
    name,
    attempt: randomUUID(),
    ...result,
  };
  await appendFile(
    path.join(resultsRoot, "scenarios.ndjson"),
    `${JSON.stringify(record)}\n`,
    "utf8",
  );
}

async function readArtifacts(): Promise<readonly Artifact[]> {
  const manifestPath = requiredEnvironment("LIONI_ARTIFACT_MANIFEST");
  const artifacts = JSON.parse(
    await readFile(manifestPath, "utf8"),
  ) as readonly Artifact[];
  for (const artifact of artifacts) {
    const digest = createHash("sha256")
      .update(await readFile(artifact.filename))
      .digest("hex");
    assert.equal(
      digest,
      artifact.sha256,
      `正式制品散列不符：${artifact.name} ${artifact.filename}`,
    );
  }
  return artifacts;
}

async function copyFixtures(
  sourceUrl: URL,
  destination: string,
): Promise<void> {
  const sourceRoot = fileURLToPath(sourceUrl);
  for (const name of await readdir(sourceRoot)) {
    await cp(path.join(sourceRoot, name), path.join(destination, name), {
      recursive: true,
      force: true,
    });
  }
}

async function createConsumer(
  root: string,
  artifacts: readonly Artifact[],
  packages: readonly string[],
  fixtures: URL | undefined,
): Promise<void> {
  const selectedPackages = new Set(packages);
  assert.equal(selectedPackages.size, packages.length, "消费包清单不能重复。");
  const selectedArtifacts = artifacts.filter(({ name }) =>
    selectedPackages.has(name),
  );
  assert.deepEqual(
    new Set(selectedArtifacts.map(({ name }) => name)),
    selectedPackages,
    "制品清单缺少场景声明的包。",
  );

  const dependencies = Object.fromEntries(
    selectedArtifacts.map(({ name, filename }) => [
      name,
      `file:${path.relative(root, filename).split(path.sep).join("/")}`,
    ]),
  );
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify(
      {
        name: `lioni-artifact-${randomUUID()}`,
        private: true,
        packageManager: "pnpm@12.9.1",
        type: "module",
        dependencies,
        devDependencies: { "@types/node": "24.19.2" },
      },
      null,
      2,
    ),
  );
  await writeFile(
    path.join(root, "pnpm-workspace.yaml"),
    JSON.stringify({ overrides: dependencies }, null, 2),
  );
  await writeFile(
    path.join(root, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ESNext",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          noEmit: true,
          skipLibCheck: false,
          types: ["node"],
          erasableSyntaxOnly: true,
          allowImportingTsExtensions: true,
          noUncheckedIndexedAccess: true,
        },
        include: ["**/*.ts"],
      },
      null,
      2,
    ),
  );
  if (fixtures !== undefined) await copyFixtures(fixtures, root);

  const install = await runSubprocess("pnpm", ["install", "--lockfile-only"], {
    cwd: root,
  });
  if (install.status !== 0) throw commandFailure("消费者锁文件准备", install);
  const frozenInstall = await runSubprocess(
    "pnpm",
    ["install", "--frozen-lockfile"],
    { cwd: root },
  );
  if (frozenInstall.status !== 0)
    throw commandFailure("消费者正式制品安装", frozenInstall);
}

/** Register an isolated, tgz-installed consumer scenario with node:test. */
export function testArtifactConsumer(
  options: ConsumerScenarioOptions,
  execute: ConsumerScenario,
): void {
  const testTimeoutMs = options.timeoutMs ?? defaultTestTimeoutMs;
  void test(
    options.name,
    { timeout: testTimeoutMs + 60_000 },
    async (context) => {
      const startedAt = new Date().toISOString();
      const runRoot = requiredEnvironment("LIONI_ARTIFACT_RUN_ROOT");
      const consumerRoot = await mkdtemp(path.join(runRoot, "consumer-")).catch(
        async () => {
          await mkdir(runRoot, { recursive: true });
          return mkdtemp(path.join(runRoot, "consumer-"));
        },
      );
      let passed = false;
      let failure: string | undefined;

      try {
        const artifacts = await readArtifacts();
        await createConsumer(
          consumerRoot,
          artifacts,
          options.packages,
          options.fixtures,
        );
        const runNode: Consumer["runNode"] = async (
          file,
          args = [],
          timeoutMs = testTimeoutMs,
        ) => {
          const result = await runSubprocess(
            process.execPath,
            [path.resolve(consumerRoot, file), ...args],
            { cwd: consumerRoot, timeoutMs },
          );
          if (
            result.status !== 0 ||
            result.timedOut ||
            result.error !== undefined
          )
            throw commandFailure(`消费者执行 ${file}`, result);
          return result;
        };
        const typecheck: Consumer["typecheck"] = async () => {
          const result = await runSubprocess(
            requiredEnvironment("LIONI_TSC_EXECUTABLE"),
            ["--project", "tsconfig.json", "--pretty", "false"],
            { cwd: consumerRoot, timeoutMs: testTimeoutMs },
          );
          if (
            result.status !== 0 ||
            result.timedOut ||
            result.error !== undefined
          )
            throw commandFailure("已安装公开声明类型检查", result);
          return result;
        };

        await execute({ root: consumerRoot, runNode, typecheck });
        passed = true;
      } catch (error) {
        failure =
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error);
        context.diagnostic(`保留消费场景现场：${consumerRoot}`);
        throw error;
      } finally {
        await recordScenarioResult(options.name, {
          status: passed ? "passed" : "failed",
          startedAt,
          finishedAt: new Date().toISOString(),
          consumerRoot,
          failure,
        });
        if (passed) await rm(consumerRoot, { recursive: true, force: true });
      }
    },
  );
}
