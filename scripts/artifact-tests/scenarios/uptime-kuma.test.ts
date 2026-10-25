import assert from "node:assert/strict";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { testArtifactConsumer } from "../support/consumer.ts";
import type { ConsumerScenario } from "../support/consumer.ts";

const expectedCommit = "d54e4619e52553416e292549f435cc7e57330c29";
const packageNames = [
  "@lioni/core",
  "@lioni/checks",
  "@lioni/memo",
  "@lioni/terminology",
  "@lioni/text-analysis",
] as const;

type Artifact = {
  readonly name: string;
  readonly version: string;
  readonly filename: string;
  readonly sha256: string;
  readonly cachePath?: string;
  readonly cacheState?: string;
};

const requiredEnvironment = (name: string): string => {
  const value = process.env[name];
  assert.ok(value, `正式制品套件必须提供 ${name}。`);
  return value;
};

const scenarioOptions = {
  name: "固定 Uptime Kuma 宿主使用同批正式制品执行本地化 QA 与写回复读",
  packages: packageNames,
  fixtures: new URL("../fixtures/uptime-kuma-lioni/", import.meta.url),
  timeoutMs: 15 * 60 * 1000,
};

const runKumaScenario: ConsumerScenario = async ({
  root,
  runNode,
  runCommand,
  typecheck,
}) => {
  const fixtureTypes = await typecheck();
  assert.equal(fixtureTypes.status, 0);

  const source = requiredEnvironment("LIONI_KUMA_SOURCE");
  const sourceHead = await runCommand("git", [
    "-C",
    source,
    "rev-parse",
    "HEAD",
  ]);
  assert.equal(
    sourceHead.stdout.trim(),
    expectedCommit,
    "宿主来源必须固定在 Uptime Kuma 2.5.7 commit。",
  );
  const sourceStatus = await runCommand("git", [
    "-C",
    source,
    "status",
    "--porcelain",
    "--untracked-files=all",
  ]);
  assert.equal(
    sourceStatus.stdout.trim(),
    "",
    "固定上游宿主副本必须保持只读且干净。",
  );

  const hostRoot = path.join(root, "uptime-kuma-2.5.7");
  await runCommand("git", [
    "clone",
    "--no-hardlinks",
    "--local",
    "--no-checkout",
    source,
    hostRoot,
  ]);
  await runCommand("git", [
    "-C",
    hostRoot,
    "checkout",
    "--detach",
    expectedCommit,
  ]);
  const clonedHead = await runCommand("git", [
    "-C",
    hostRoot,
    "rev-parse",
    "HEAD",
  ]);
  assert.equal(clonedHead.stdout.trim(), expectedCommit);

  const hostQaRoot = path.join(hostRoot, "qa", "lioni");
  await mkdir(hostQaRoot, { recursive: true });
  await cp(path.join(root, "qa", "lioni"), hostQaRoot, { recursive: true });

  const artifacts = JSON.parse(
    await readFile(requiredEnvironment("LIONI_ARTIFACT_MANIFEST"), "utf8"),
  ) as readonly Artifact[];
  const selectedArtifacts = artifacts.filter(({ name }) =>
    packageNames.includes(name as (typeof packageNames)[number]),
  );
  assert.deepEqual(
    new Set(selectedArtifacts.map(({ name }) => name)),
    new Set(packageNames),
    "宿主必须安装当前正式套件中的五个相关包。",
  );

  const artifactDirectory = path.join(hostQaRoot, "artifacts");
  await mkdir(artifactDirectory, { recursive: true });
  const dependencies: Record<string, string> = {};
  for (const artifact of selectedArtifacts) {
    const filename = path.basename(artifact.filename);
    const localArtifact = path.join(artifactDirectory, filename);
    await cp(artifact.filename, localArtifact);
    dependencies[artifact.name] = `file:artifacts/${filename}`;
  }
  await writeFile(
    path.join(hostQaRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "uptime-kuma-lioni-qa-consumer",
        private: true,
        packageManager: "pnpm@12.9.1",
        type: "module",
        dependencies,
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    path.join(hostQaRoot, "pnpm-workspace.yaml"),
    `${JSON.stringify({ overrides: dependencies }, null, 2)}\n`,
  );
  await writeFile(
    path.join(hostQaRoot, "artifacts.json"),
    `${JSON.stringify(
      selectedArtifacts.map(
        ({ name, version, sha256, cachePath, cacheState }) => ({
          name,
          version,
          sha256,
          cachePath: cachePath ?? null,
          cacheState: cacheState ?? null,
        }),
      ),
      null,
      2,
    )}\n`,
  );

  await runCommand("pnpm", [
    "--dir",
    hostQaRoot,
    "install",
    "--offline",
    "--lockfile-only",
  ]);
  await runCommand("pnpm", [
    "--dir",
    hostQaRoot,
    "install",
    "--offline",
    "--frozen-lockfile",
  ]);

  const tscExecutable = requiredEnvironment("LIONI_TSC_EXECUTABLE");
  await runCommand(tscExecutable, [
    "--project",
    path.join(hostQaRoot, "tsconfig.json"),
    "--pretty",
    "false",
  ]);
  const result = await runNode(path.join(hostQaRoot, "consumer.ts"));
  const report = JSON.parse(result.stdout) as {
    readonly host: {
      readonly commit: string;
      readonly applicationBuildStarted: boolean;
      readonly applicationServerStarted: boolean;
    };
    readonly natural: {
      readonly sourceLocale: {
        readonly resource: string;
        readonly entries: number;
        readonly nonemptyEntries: number;
      };
      readonly localeStats: Record<
        string,
        {
          readonly localeEntries: number;
          readonly nonemptyLocaleEntries: number;
          readonly pairedNonemptyEntries: number;
          readonly uniqueSourceStrings: number;
        }
      >;
      readonly allLocalePairs: number;
      readonly uniqueSourceStringsAcrossTargets: number;
      readonly candidateRuns: Record<string, unknown>;
    };
    readonly noAnalysis: {
      readonly simpleCheck: string;
      readonly emptyCandidates: string;
    };
    readonly controlledCorpus: {
      readonly partial: {
        readonly status: string;
        readonly diagnostics: readonly unknown[];
        readonly writeCondition: string;
      };
      readonly forbiddenCandidate: {
        readonly writeCondition: string;
        readonly exception: readonly unknown[];
      };
      readonly hostConditionedWrite: {
        readonly status: string;
        readonly applyStatus: string;
        readonly rereadValue: string;
      };
      readonly heterogeneousBody: {
        readonly negativeDiagnostics: readonly unknown[];
      };
    };
  };

  assert.equal(report.host.commit, expectedCommit);
  assert.equal(report.host.applicationBuildStarted, false);
  assert.equal(report.host.applicationServerStarted, false);
  assert.deepEqual(report.natural.sourceLocale, {
    resource: "src/lang/en.json",
    entries: 1631,
    nonemptyEntries: 1631,
  });
  assert.equal(report.natural.allLocalePairs, 4065);
  assert.ok(
    report.natural.uniqueSourceStringsAcrossTargets <
      report.natural.allLocalePairs,
    "语言配对数不能冒充独特原文数。",
  );
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(report.natural.localeStats).map(([language, item]) => [
        language,
        [item.pairedNonemptyEntries, item.uniqueSourceStrings],
      ]),
    ),
    {
      "zh-CN": [1614, 1522],
      "zh-TW": [1199, 1160],
      ja: [1252, 1215],
    },
  );
  assert.equal(report.controlledCorpus.partial.status, "incomplete");
  assert.ok(report.controlledCorpus.partial.diagnostics.length > 0);
  assert.equal(report.controlledCorpus.partial.writeCondition, "rejected");
  assert.equal(
    report.controlledCorpus.forbiddenCandidate.writeCondition,
    "rejected",
  );
  assert.ok(report.controlledCorpus.forbiddenCandidate.exception.length > 0);
  assert.equal(report.controlledCorpus.hostConditionedWrite.status, "passed");
  assert.equal(
    report.controlledCorpus.hostConditionedWrite.applyStatus,
    "written",
  );
  assert.equal(
    report.controlledCorpus.hostConditionedWrite.rereadValue,
    "无法连接 {service}，代码 {code}。",
  );
  assert.ok(
    report.controlledCorpus.heterogeneousBody.negativeDiagnostics.length > 0,
  );

  const completeReport = {
    status: "executed",
    ...report,
    artifactIdentity: selectedArtifacts.map(
      ({ name, version, sha256, cachePath, cacheState }) => ({
        name,
        version,
        sha256,
        cachePath: cachePath ?? null,
        cacheState: cacheState ?? null,
      }),
    ),
    installation: {
      consumer: "Uptime Kuma clone / qa/lioni",
      packageManager: "pnpm",
      packages: packageNames,
      artifactSources: "同一正式 suite manifest 中散列已校验的 tgz",
    },
  };

  const resultDirectory = process.env.LIONI_ARTIFACT_RESULTS;
  if (resultDirectory !== undefined) {
    await mkdir(resultDirectory, { recursive: true });
    await writeFile(
      path.join(resultDirectory, "uptime-kuma-report.json"),
      `${JSON.stringify(completeReport, null, 2)}\n`,
    );
  }
  process.stdout.write(`${JSON.stringify(completeReport, null, 2)}\n`);
  assert.ok(report.noAnalysis.simpleCheck.includes("未触发语言分析"));
  assert.ok(report.noAnalysis.emptyCandidates.includes("未触发分析"));
};

const explicitlySelected = (() => {
  const value = process.env.LIONI_ARTIFACT_REQUESTED_SCENARIOS;
  if (value === undefined) return false;
  const selected: unknown = JSON.parse(value);
  return (
    Array.isArray(selected) &&
    selected.some((entry) => {
      if (typeof entry !== "string") return false;
      const filename = path.basename(entry);
      return filename.replace(/\.test\.ts$/u, "") === "uptime-kuma";
    })
  );
})();
const explicitlyEnabled = process.env.LIONI_ENABLE_KUMA === "1";
const hasHostSource = process.env.LIONI_KUMA_SOURCE !== undefined;

if (explicitlySelected || explicitlyEnabled || hasHostSource)
  testArtifactConsumer(scenarioOptions, runKumaScenario);
else {
  void test(
    "Uptime Kuma 宿主场景未启用",
    { skip: "设置 LIONI_KUMA_SOURCE 或显式选择 uptime-kuma 场景后执行。" },
    () => {},
  );
  const resultDirectory = process.env.LIONI_ARTIFACT_RESULTS;
  if (resultDirectory !== undefined) {
    await mkdir(resultDirectory, { recursive: true });
    await writeFile(
      path.join(resultDirectory, "uptime-kuma-status.json"),
      `${JSON.stringify(
        {
          status: "not-executed",
          requested: false,
          enabled: false,
          reason: "普通完整套件未提供固定宿主副本；Kuma 场景明确跳过。",
        },
        null,
        2,
      )}\n`,
    );
  }
}
