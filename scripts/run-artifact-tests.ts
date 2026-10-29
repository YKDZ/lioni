import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as z from "zod";

import { productPackageName } from "./artifact-tests/product.ts";
import type { Artifact } from "./artifact-tests/support/consumer.ts";
import { externalInterruptSignal } from "./artifact-tests/support/external-interrupt.ts";
import {
  runCommand,
  type ProcessOptions,
} from "./artifact-tests/support/process.ts";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const scenarios = new URL("./artifact-tests/scenarios/", import.meta.url);

const publishPlanSchema = z.object({
  version: z.literal(1),
  plan: z.array(z.array(z.looseObject({ kind: z.string(), name: z.string() }))),
});
const publishedArtifactSchema = z.object({
  tarball: z.object({ path: z.string() }),
});
const workspaceProductSchema = z
  .array(
    z.object({
      name: z.literal(productPackageName),
      private: z.literal(false),
      version: z.string(),
    }),
  )
  .length(1);

/** 从 Changesets 正式发布计划定位已经打包的产品 tarball。 */
async function artifactFromPublishPlan(planPath: string): Promise<Artifact> {
  const absolutePlanPath = path.resolve(repositoryRoot, planPath);
  const parsed = publishPlanSchema.parse(
    JSON.parse(await readFile(absolutePlanPath, "utf8")),
  );
  const release = parsed.plan
    .flat()
    .find(
      (entry) => entry.kind === "publish" && entry.name === productPackageName,
    );
  assert.ok(release, `发布计划中没有 ${productPackageName} 产品。`);
  const tarballPath = publishedArtifactSchema.parse(release).tarball.path;

  const filename = path.resolve(path.dirname(absolutePlanPath), tarballPath);
  const file = await stat(filename);
  assert.ok(file.isFile(), `Changesets tarball 不存在：${filename}`);
  return { name: productPackageName, filename };
}

/** 使用 Changesets 原生 pack 打包当前公开 workspace 版本，且只在验收临时目录写计划和制品。 */
async function artifactFromWorkspaceProduct(
  root: string,
  commandOptions: ProcessOptions,
): Promise<Artifact> {
  const listed = await runCommand(
    "pnpm",
    ["--filter", productPackageName, "list", "--depth", "-1", "--json"],
    commandOptions,
  );
  const [product] = workspaceProductSchema.parse(JSON.parse(listed.stdout));
  assert.ok(product);

  const inputPlanPath = path.join(root, "publish-input.json");
  const outputDirectory = path.join(root, "packed");
  // 正式 Changesets 计划会省略已发布版本；这里仅让原生 pack 消费本地声明版本。
  await writeFile(
    inputPlanPath,
    JSON.stringify({
      version: 1,
      plan: [
        [
          {
            kind: "publish",
            name: product.name,
            version: product.version,
          },
        ],
      ],
    }),
  );
  await runCommand(
    "pnpm",
    [
      "exec",
      "changeset",
      "pack",
      "--from-publish-plan",
      inputPlanPath,
      "--out-dir",
      outputDirectory,
    ],
    commandOptions,
  );
  return await artifactFromPublishPlan(
    path.join(outputDirectory, "publish-plan.json"),
  );
}

/** 消费已构建的产品包；根任务负责前置构建，失败时保留临时目录供复现。 */
async function main(): Promise<void> {
  const available = (await readdir(scenarios))
    .filter((name) => name.endsWith(".test.ts"))
    .map((name) => name.slice(0, -".test.ts".length))
    .sort();
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  const planOption = args.indexOf("--from-publish-plan");
  let publishPlanPath: string | undefined;
  if (planOption !== -1) {
    const providedPlanPath = args[planOption + 1];
    assert.ok(providedPlanPath, "--from-publish-plan 后必须提供文件路径。");
    publishPlanPath = providedPlanPath;
    args.splice(planOption, 2);
  }
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
  const commandOptions = {
    cwd: repositoryRoot,
    signal: externalInterruptSignal,
    shell: process.platform === "win32",
  };
  let passed = false;
  try {
    const artifact =
      publishPlanPath === undefined
        ? await artifactFromWorkspaceProduct(root, commandOptions)
        : await artifactFromPublishPlan(publishPlanPath);
    assert.equal(artifact.name, productPackageName);
    const artifacts = [artifact];
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
