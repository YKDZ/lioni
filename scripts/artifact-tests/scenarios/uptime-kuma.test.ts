import assert from "node:assert/strict";
import {
  cp,
  mkdir,
  readFile,
  rename,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { test } from "node:test";

import { testArtifactConsumer } from "../support/consumer.ts";
import type { ConsumerScenario } from "../support/consumer.ts";

const expectedCommit = "d54e4619e52553416e292549f435cc7e57330c29";
const packageNames = [
  "@lioni/cli",
  "@lioni/core",
  "@lioni/checks",
  "@lioni/memo",
  "@lioni/terminology",
  "@lioni/text-analysis",
] as const;
const hostDependencies = {
  "@babel/parser": "7.29.9",
  "@intlify/message-compiler": "11.2.8",
  typescript: "5.9.3",
  "@vue/compiler-dom": "3.4.38",
  "@vue/compiler-sfc": "3.4.38",
};

type Artifact = {
  readonly name: string;
  readonly version: string;
  readonly filename: string;
  readonly sha256: string;
  readonly cachePath?: string;
  readonly cacheState?: string;
};
type CliEnvelope<TData> = {
  readonly schemaVersion: string;
  readonly command: string;
  readonly kind: "data";
  readonly variant: string;
  readonly data: TData;
};
type ResourceFacts = {
  readonly version: string;
  readonly source: {
    readonly units: readonly {
      readonly key: string;
      readonly unit: { readonly source: { readonly text: string } };
    }[];
  };
  readonly translations: {
    readonly records: readonly {
      readonly language: string;
      readonly translation: { readonly key: string };
    }[];
  };
  readonly associations: readonly {
    readonly language: string;
    readonly status: string;
  }[];
};
type BaselineResult = {
  readonly outcome: string;
  readonly path: string;
  readonly sourceUnitCount: number;
  readonly translationRecordCount: number;
};
type UpdatePlanResult = {
  readonly items: readonly {
    readonly action: string;
    readonly sourceKey?: string;
    readonly language: string;
    readonly request?: {
      readonly operation: string;
      readonly target: {
        readonly sourceKey?: string;
        readonly language?: string;
        readonly identity?: {
          readonly language: string;
          readonly namespace: string;
          readonly key: string;
        };
      };
      readonly content?: { readonly text: string };
      readonly expectedTarget?: { readonly status: string };
    };
  }[];
};
type QualityResult = {
  readonly status: string;
  readonly candidates: readonly { readonly language: string }[];
  readonly diagnostics: readonly {
    readonly ruleId: string;
    readonly severity: string;
    readonly object: { readonly language?: string };
    readonly location: { readonly language: string | null };
  }[];
  readonly checks: readonly { readonly id: string }[];
};

const requiredEnvironment = (name: string): string => {
  const value = process.env[name];
  assert.ok(value, `正式制品套件必须提供 ${name}。`);
  return value;
};

function readEnvelope<TData>(stdout: string, command: string): TData {
  const envelope: unknown = JSON.parse(stdout.trim());
  assert.ok(envelope !== null && typeof envelope === "object");
  const value = envelope as CliEnvelope<TData>;
  assert.equal(value.kind, "data");
  assert.equal(value.command, command);
  return value.data;
}

const scenarioOptions = {
  name: "固定 Uptime Kuma 使用同批 CLI 和 SDK 制品读取、记录基线并运行真实 QA",
  packages: packageNames,
  additionalDependencies: hostDependencies,
  fixtures: new URL("../fixtures/uptime-kuma-lioni/", import.meta.url),
  timeoutMs: 15 * 60 * 1000,
};

const runKumaScenario: ConsumerScenario = async ({
  root,
  runCommand,
  typecheck,
}) => {
  const wholeRunStarted = performance.now();
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
  await cp(
    path.join(root, "lioni.config.ts"),
    path.join(hostRoot, "lioni.config.ts"),
  );
  await cp(
    path.join(root, "lioni.zh-CN.config.ts"),
    path.join(hostRoot, "lioni.zh-CN.config.ts"),
  );
  await cp(
    path.join(root, "src", "lang", "lioni"),
    path.join(hostRoot, "src", "lang", "lioni"),
    { recursive: true },
  );

  const artifacts = JSON.parse(
    await readFile(requiredEnvironment("LIONI_ARTIFACT_MANIFEST"), "utf8"),
  ) as readonly Artifact[];
  const selectedArtifacts = artifacts.filter(({ name }) =>
    packageNames.includes(name as (typeof packageNames)[number]),
  );
  assert.deepEqual(
    new Set(selectedArtifacts.map(({ name }) => name)),
    new Set(packageNames),
    "宿主必须安装本轮同批 CLI 和 SDK 制品。",
  );

  const artifactDirectory = path.join(hostQaRoot, "artifacts");
  await mkdir(artifactDirectory, { recursive: true });
  const artifactDependencies: Record<string, string> = {};
  for (const artifact of selectedArtifacts) {
    const filename = path.basename(artifact.filename);
    await cp(artifact.filename, path.join(artifactDirectory, filename));
    artifactDependencies[artifact.name] = `file:artifacts/${filename}`;
  }
  const dependencies = { ...artifactDependencies, ...hostDependencies };
  await writeFile(
    path.join(hostQaRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "uptime-kuma-lioni-qa-consumer",
        private: true,
        packageManager: "pnpm@12.9.1",
        type: "module",
        dependencies,
        devDependencies: { "@types/node": "24.19.2" },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    path.join(hostQaRoot, "pnpm-workspace.yaml"),
    `${JSON.stringify({ overrides: artifactDependencies }, null, 2)}\n`,
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
  const hostTypes = await runCommand(tscExecutable, [
    "--project",
    path.join(hostQaRoot, "tsconfig.json"),
    "--pretty",
    "false",
  ]);
  assert.equal(hostTypes.status, 0);
  await runCommand("pnpm", [
    "--dir",
    hostQaRoot,
    "exec",
    "node",
    "--test",
    "test/checks.test.ts",
    "test/declarations.test.ts",
    "test/facts.test.ts",
    "test/quantity-profiles.test.ts",
  ]);

  const resourcePath = (language: string) =>
    path.join(hostRoot, "src", "lang", `${language}.json`);
  const sourceRaw = await readFile(resourcePath("en"));
  const chineseRaw = await readFile(resourcePath("zh-CN"));
  const termbasePath = path.join(hostRoot, "src", "lang", "lioni", "termbase");
  const hiddenTermbasePath = `${termbasePath}.temporarily-hidden`;
  const usageProbePath = path.join(hostRoot, "src", ".lioni-usage-probe.ts");
  const configPath = "../../lioni.config.ts";
  const updateConfigPath = "../../lioni.zh-CN.config.ts";
  const cli = async (
    command: string,
    config = configPath,
    args: readonly string[] = [],
  ) =>
    runCommand("pnpm", [
      "--dir",
      hostQaRoot,
      "exec",
      "lioni",
      command,
      config,
      ...args,
    ]);

  let factsResult: ResourceFacts;
  let baselineResult: BaselineResult;
  let factsMs: number;
  let baselineMs: number;
  let updatePlanResult: UpdatePlanResult;
  let updatePlanningMs: number;
  let updatePreviewMs: number;
  let baselineRawBeforePreview: string;
  await rename(termbasePath, hiddenTermbasePath);
  await symlink("missing-usage-source.ts", usageProbePath);
  try {
    const factsCommand = await cli("facts");
    factsMs = factsCommand.durationMs;
    factsResult = readEnvelope<ResourceFacts>(factsCommand.stdout, "facts");
    const baselineCommand = await cli("baseline", updateConfigPath);
    baselineMs = baselineCommand.durationMs;
    baselineResult = readEnvelope<BaselineResult>(
      baselineCommand.stdout,
      "baseline",
    );
    baselineRawBeforePreview = await readFile(
      path.join(hostRoot, "lioni.baseline.json"),
      "utf8",
    );
    const previewStarted = performance.now();
    const updateCommand = await cli("update", updateConfigPath, ["--dry-run"]);
    updatePreviewMs = performance.now() - previewStarted;
    updatePlanningMs = updateCommand.durationMs;
    updatePlanResult = readEnvelope<UpdatePlanResult>(
      updateCommand.stdout,
      "update",
    );
  } finally {
    await unlink(usageProbePath).catch(() => undefined);
    await rename(hiddenTermbasePath, termbasePath);
  }

  const sourceKeys = new Set(factsResult.source.units.map(({ key }) => key));
  const chineseRecords = factsResult.translations.records.filter(
    ({ language }) => language === "zh-CN",
  );
  const chineseKeys = new Set(
    chineseRecords.map(({ translation }) => translation.key),
  );
  const missingChinese = factsResult.associations.filter(
    ({ language, status }) => language === "zh-CN" && status === "missing",
  ).length;
  const chineseOnly = [...chineseKeys].filter(
    (key) => !sourceKeys.has(key),
  ).length;
  assert.equal(factsResult.source.units.length, 1631);
  assert.equal(chineseRecords.length, 1738);
  assert.equal(missingChinese, 17);
  assert.equal(chineseOnly, 124);
  assert.equal(baselineResult.sourceUnitCount, 1631);
  assert.equal(baselineResult.translationRecordCount, 1738);
  assert.equal(baselineResult.path, path.join(hostRoot, "lioni.baseline.json"));
  const writeItems = updatePlanResult.items.filter(
    ({ action }) => action === "write",
  );
  assert.equal(writeItems.length, 17);
  assert.equal(
    updatePlanResult.items.filter(({ action }) => action === "delete").length,
    0,
  );
  assert.ok(
    updatePlanResult.items.every(({ language }) => language === "zh-CN"),
  );
  const sourceByKey = new Map(
    factsResult.source.units.map(({ key, unit }) => [key, unit.source.text]),
  );
  assert.ok(
    writeItems.every(
      ({ sourceKey, request }) =>
        request?.operation === "write" &&
        request.target.sourceKey === sourceKey &&
        request.target.language === "zh-CN" &&
        request.expectedTarget?.status === "missing" &&
        request.content?.text === sourceByKey.get(sourceKey ?? ""),
    ),
  );
  assert.equal(
    await readFile(path.join(hostRoot, "lioni.baseline.json"), "utf8"),
    baselineRawBeforePreview,
  );
  assert.deepEqual(await readFile(resourcePath("zh-CN")), chineseRaw);

  const qaStarted = performance.now();
  const qaCommand = await cli("qa");
  const qaMs = performance.now() - qaStarted;
  const quality = readEnvelope<QualityResult>(qaCommand.stdout, "qa");
  assert.equal(quality.status, "complete");
  assert.ok(quality.candidates.some(({ language }) => language === "zh-CN"));
  assert.ok(
    quality.checks.some(
      ({ id }) => id === "terminology/reject-forbidden-translation",
    ),
  );

  const byLanguage = Object.fromEntries(
    ["zh-CN", "ja"].map((language) => {
      const diagnostics = quality.diagnostics.filter(
        (diagnostic) =>
          (diagnostic.object.language ?? diagnostic.location.language) ===
          language,
      );
      return [
        language,
        {
          candidates: quality.candidates.filter(
            (candidate) => candidate.language === language,
          ).length,
          diagnostics: diagnostics.length,
          errors: diagnostics.filter(({ severity }) => severity === "error")
            .length,
          warnings: diagnostics.filter(({ severity }) => severity === "warning")
            .length,
        },
      ];
    }),
  );
  assert.deepEqual(await readFile(resourcePath("en")), sourceRaw);
  assert.deepEqual(await readFile(resourcePath("zh-CN")), chineseRaw);

  const report = {
    status: "executed",
    host: {
      commit: expectedCommit,
      applicationBuildStarted: false,
      applicationServerStarted: false,
    },
    artifacts: selectedArtifacts.map(
      ({ name, version, sha256, cachePath, cacheState }) => ({
        name,
        version,
        sha256,
        cachePath: cachePath ?? null,
        cacheState: cacheState ?? null,
      }),
    ),
    installation: {
      consumer: "固定 Uptime Kuma 副本 / qa/lioni",
      packageManager: "pnpm",
      packages: packageNames,
      externalHostDependencies: hostDependencies,
      artifactSources: "同一正式制品清单中散列已校验的 tgz",
    },
    facts: {
      version: factsResult.version,
      sourceEntries: factsResult.source.units.length,
      zhCNEntries: chineseRecords.length,
      zhCNMissingSource: missingChinese,
      zhCNTargetOnly: chineseOnly,
    },
    baseline: baselineResult,
    updatePreview: {
      selectedLanguages: ["zh-CN"],
      decisions: updatePlanResult.items.length,
      writes: writeItems.length,
      deletes: updatePlanResult.items.filter(
        ({ action }) => action === "delete",
      ).length,
      baselineUnchanged: true,
      targetResourcesUnchanged: true,
    },
    quality: {
      status: quality.status,
      diagnostics: quality.diagnostics.length,
      byLanguage,
      checks: quality.checks.map(({ id }) => id),
      findings: quality.diagnostics,
    },
    timings: {
      conditions:
        "Node 24、固定上游副本、已安装同批正式制品；不启动 Kuma 应用。",
      factsReadAndAssociationMs: factsMs,
      baselineReadAndRecordMs: baselineMs,
      updatePlanningMs,
      updatePreviewEndToEndMs: updatePreviewMs,
      qaEndToEndMs: qaMs,
      completeScenarioMs: performance.now() - wholeRunStarted,
      hostTypecheckMs: hostTypes.durationMs,
    },
    environment: {
      node: process.version,
      platform: os.platform(),
      arch: os.arch(),
    },
    resourcesUnchanged: true,
  };

  const resultDirectory = process.env.LIONI_ARTIFACT_RESULTS;
  if (resultDirectory !== undefined) {
    await mkdir(resultDirectory, { recursive: true });
    await writeFile(
      path.join(resultDirectory, "uptime-kuma-report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
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
