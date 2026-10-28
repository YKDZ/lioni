import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Artifact } from "./artifact-tests/support/consumer.ts";
import { externalInterruptSignal } from "./artifact-tests/support/external-interrupt.ts";
import { runCommand } from "./artifact-tests/support/process.ts";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const scenarios = new URL("./artifact-tests/scenarios/", import.meta.url);

/** 消费已构建的正式包；Turbo 负责前置构建，失败时保留临时目录供复现。 */
async function main(): Promise<void> {
  const available = (await readdir(scenarios))
    .filter((name) => name.endsWith(".test.ts"))
    .map((name) => name.slice(0, -".test.ts".length))
    .sort();
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  if (args.length === 1 && args[0] === "--list") {
    process.stdout.write(`${available.join("\n")}\n`);
    return;
  }
  const selected = args.length === 0 ? available : [...new Set(args)];
  assert.ok(selected.length > 0, "没有可运行的制品场景。");
  for (const name of selected)
    assert.ok(
      available.includes(name),
      `未知场景 ${name}；可选：${available.join("、")}。`,
    );

  const root = await mkdtemp(path.join(tmpdir(), "lioni-artifact-tests-"));
  const artifactsDirectory = path.join(root, "artifacts");
  const commandOptions = {
    cwd: repositoryRoot,
    signal: externalInterruptSignal,
    shell: process.platform === "win32",
  };
  let passed = false;
  try {
    await mkdir(artifactsDirectory);
    const listed = await runCommand(
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
      commandOptions,
    );
    const packages = JSON.parse(listed.stdout) as readonly {
      readonly name: string;
    }[];
    assert.ok(packages.length > 0, "没有可打包的 Lioni 包。");
    const artifacts: Artifact[] = [];
    for (const { name } of packages) {
      const packed = await runCommand(
        "pnpm",
        [
          "--filter",
          name,
          "pack",
          "--pack-destination",
          artifactsDirectory,
          "--json",
        ],
        commandOptions,
      );
      const artifact = JSON.parse(packed.stdout) as Artifact;
      assert.equal(artifact.name, name);
      artifacts.push(artifact);
    }
    await writeFile(
      path.join(root, "artifacts.json"),
      JSON.stringify(artifacts),
    );
    process.stdout.write(`运行制品场景：${selected.join("、")}\n`);
    await runCommand(
      process.execPath,
      [
        "--conditions=source",
        "--import",
        fileURLToPath(
          new URL(
            "./artifact-tests/support/external-interrupt.ts",
            import.meta.url,
          ),
        ),
        "--test",
        "--test-reporter=spec",
        "--test-concurrency=1",
        ...selected.map((name) =>
          fileURLToPath(new URL(`${name}.test.ts`, scenarios)),
        ),
      ],
      {
        ...commandOptions,
        timeoutMs: 15 * 60 * 1000,
        terminationGraceMs: 2_000,
        env: {
          ...process.env,
          LIONI_ARTIFACT_RUN_ROOT: root,
          LIONI_TSC_EXECUTABLE: path.join(
            repositoryRoot,
            "node_modules",
            ".bin",
            process.platform === "win32" ? "tsc.cmd" : "tsc",
          ),
        },
        onStdout: (chunk) => {
          process.stdout.write(chunk);
        },
        onStderr: (chunk) => {
          process.stderr.write(chunk);
        },
      },
    );
    passed = true;
  } finally {
    if (passed && process.env.LIONI_KEEP_ARTIFACT_TESTS !== "1")
      await rm(root, { recursive: true, force: true });
    else process.stderr.write(`保留制品测试现场：${root}\n`);
  }
}

await main();
