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
    readonly target?: {
      readonly namespace?: string;
      readonly key?: string;
    };
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
type UpdateExecutionResult = {
  readonly plan: UpdatePlanResult;
  readonly status: "completed" | "failed";
  readonly results: readonly {
    readonly index: number;
    readonly action: string;
    readonly status: string;
    readonly reason?: string;
  }[];
};
type WriteBatchResult = {
  readonly results: readonly {
    readonly status: string;
    readonly reason?: string;
  }[];
};
type QualityResult = {
  readonly status: string;
  readonly candidates: readonly { readonly language: string }[];
  readonly diagnostics: readonly {
    readonly checkId: string;
    readonly severity: string;
    readonly object: { readonly language?: string };
    readonly location: { readonly language: string | null };
  }[];
  readonly checks: readonly {
    readonly checkId: string;
    readonly version: string;
    readonly executions: readonly {
      readonly inputFingerprint?: string;
    }[];
  }[];
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

async function readStringMap(
  filename: string,
): Promise<Record<string, string>> {
  const value: unknown = JSON.parse(await readFile(filename, "utf8"));
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
  );
  const entries: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    assert.ok(typeof entry === "string");
    entries[key] = entry;
  }
  return entries;
}

async function writeStringMap(
  filename: string,
  value: Readonly<Record<string, string>>,
): Promise<void> {
  await writeFile(filename, `${JSON.stringify(value, null, 4)}\n`);
}

const scenarioOptions = {
  name: "固定 Uptime Kuma 使用同批正式 CLI 和 SDK 完成基线、更新及 QA",
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
    "test/writer.test.ts",
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
  const sdkRunnerPath = path.join(hostQaRoot, "lioni-sdk-write.ts");
  await writeFile(
    sdkRunnerPath,
    `import { readFile } from "node:fs/promises";
import { applyUpdatePlan, writeTranslationRequests } from "@lioni/core";

const [inputPath, mode] = process.argv.slice(2);
if (!inputPath || (mode !== "apply" && mode !== "write")) {
  throw new Error("SDK写入接缝需要输入JSON路径和apply/write模式。");
}
const config = (await import("../../lioni.zh-CN.config.ts")).default;
const input = JSON.parse(await readFile(inputPath, "utf8"));
const result =
  mode === "apply"
    ? await applyUpdatePlan(input, config)
    : await writeTranslationRequests(input, config);
process.stdout.write(JSON.stringify(result) + "\\n");
`,
  );
  const runSdk = async (mode: "apply" | "write", input: unknown) => {
    const inputPath = path.join(hostQaRoot, `lioni-sdk-${mode}.json`);
    await writeFile(inputPath, `${JSON.stringify(input)}\n`);
    try {
      const command = await runCommand("pnpm", [
        "--dir",
        hostQaRoot,
        "exec",
        "node",
        sdkRunnerPath,
        inputPath,
        mode,
      ]);
      return {
        result: JSON.parse(command.stdout.trim()) as
          | UpdateExecutionResult
          | WriteBatchResult,
        durationMs: command.durationMs,
      };
    } finally {
      await unlink(inputPath).catch(() => undefined);
    }
  };

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
  const initialChineseMap = await readStringMap(resourcePath("zh-CN"));

  const baselinePath = path.join(hostRoot, "lioni.baseline.json");
  const firstWrite = writeItems[0];
  assert.ok(firstWrite?.request);
  const firstWriteKey = firstWrite.sourceKey;
  assert.ok(firstWriteKey);
  const staleSourceMap = await readStringMap(resourcePath("en"));
  const staleSourceValue = staleSourceMap[firstWriteKey];
  assert.ok(staleSourceValue);
  staleSourceMap[firstWriteKey] = `${staleSourceValue} [票07输入冲突探针]`;
  let staleInputConflictMs: number;
  try {
    await writeStringMap(resourcePath("en"), staleSourceMap);
    const conflictStarted = performance.now();
    const staleResult = await runSdk("write", [firstWrite.request]);
    staleInputConflictMs = performance.now() - conflictStarted;
    const staleBatch = staleResult.result as WriteBatchResult;
    assert.equal(staleBatch.results.length, 1);
    assert.equal(staleBatch.results[0]?.status, "conflict");
    assert.deepEqual(await readFile(resourcePath("zh-CN")), chineseRaw);
    assert.equal(
      await readFile(baselinePath, "utf8"),
      baselineRawBeforePreview,
    );
  } finally {
    await writeFile(resourcePath("en"), sourceRaw);
  }

  const sdkApplyStarted = performance.now();
  let sdkApplyWritebackPhaseMs: number;
  try {
    const sdkApply = await runSdk("apply", updatePlanResult);
    sdkApplyWritebackPhaseMs = performance.now() - sdkApplyStarted;
    const sdkExecution = sdkApply.result as UpdateExecutionResult;
    assert.equal(sdkExecution.status, "completed");
    assert.equal(
      sdkExecution.results.filter(({ status }) => status === "written").length,
      17,
    );
    assert.equal(
      sdkExecution.results.filter(({ status }) => status === "retained").length,
      1738,
    );
    const sdkTarget = await readStringMap(resourcePath("zh-CN"));
    const expectedSdkTarget = { ...initialChineseMap };
    for (const item of writeItems) {
      assert.ok(item.sourceKey);
      assert.equal(sdkTarget[item.sourceKey], sourceByKey.get(item.sourceKey));
      expectedSdkTarget[item.sourceKey] = sourceByKey.get(item.sourceKey)!;
    }
    assert.deepEqual(sdkTarget, expectedSdkTarget);
    assert.equal(
      await readFile(baselinePath, "utf8"),
      baselineRawBeforePreview,
    );
  } finally {
    await writeFile(resourcePath("zh-CN"), chineseRaw);
  }

  const updateStarted = performance.now();
  const actualUpdateCommand = await cli("update", updateConfigPath);
  const updateEndToEndMs = performance.now() - updateStarted;
  const actualUpdate = readEnvelope<UpdateExecutionResult>(
    actualUpdateCommand.stdout,
    "update",
  );
  assert.equal(actualUpdate.status, "completed");
  assert.equal(actualUpdate.results.length, updatePlanResult.items.length);
  assert.equal(
    actualUpdate.results.filter(
      ({ action, status }) => action === "write" && status === "written",
    ).length,
    17,
  );
  assert.equal(
    actualUpdate.results.filter(
      ({ action, status }) => action === "retain" && status === "retained",
    ).length,
    1738,
  );
  assert.ok(
    actualUpdate.results.every(
      ({ action, status }) =>
        (action === "write" && status === "written") ||
        (action === "retain" && status === "retained"),
    ),
  );
  const updatedChinese = await readStringMap(resourcePath("zh-CN"));
  for (const [key, value] of Object.entries(initialChineseMap))
    assert.equal(updatedChinese[key], value);
  for (const item of writeItems) {
    assert.ok(item.sourceKey);
    assert.equal(
      updatedChinese[item.sourceKey],
      sourceByKey.get(item.sourceKey),
    );
  }
  assert.deepEqual(await readFile(resourcePath("en")), sourceRaw);
  assert.equal(await readFile(baselinePath, "utf8"), baselineRawBeforePreview);

  const postUpdateFactsStarted = performance.now();
  const postUpdateFactsCommand = await cli("facts", updateConfigPath);
  const postUpdateFactsMs = performance.now() - postUpdateFactsStarted;
  const postUpdateFacts = readEnvelope<ResourceFacts>(
    postUpdateFactsCommand.stdout,
    "facts",
  );
  const postUpdateChineseRecords = postUpdateFacts.translations.records.filter(
    ({ language }) => language === "zh-CN",
  );
  assert.equal(postUpdateFacts.source.units.length, 1631);
  assert.equal(postUpdateChineseRecords.length, 1755);
  assert.equal(
    postUpdateFacts.associations.filter(
      ({ language, status }) => language === "zh-CN" && status === "missing",
    ).length,
    0,
  );
  assert.equal(
    postUpdateChineseRecords.filter(
      ({ translation }) => !sourceKeys.has(translation.key),
    ).length,
    124,
  );

  const qaStartedAt = new Date().toISOString();
  const qaStarted = performance.now();
  const qaCommand = await cli("qa");
  const qaMs = performance.now() - qaStarted;
  const qaFinishedAt = new Date().toISOString();
  const quality = readEnvelope<QualityResult>(qaCommand.stdout, "qa");
  assert.equal(quality.status, "complete");
  assert.ok(quality.candidates.some(({ language }) => language === "zh-CN"));
  assert.ok(
    quality.checks.some(
      ({ checkId }) => checkId === "terminology/reject-forbidden-translation",
    ),
  );
  const resourceCheck = quality.checks.find(
    ({ checkId }) => checkId === "kuma/resource-contract",
  );
  assert.ok(resourceCheck);
  assert.equal(resourceCheck.version, "kuma-host-text-rule-v1");
  assert.ok(
    resourceCheck.executions.some(
      ({ inputFingerprint }) => typeof inputFingerprint === "string",
    ),
    "Kuma lazy checks must preserve the prepared input fingerprint.",
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

  const postUpdateSourceRaw = await readFile(resourcePath("en"));
  const postUpdateChineseRaw = await readFile(resourcePath("zh-CN"));
  const postUpdateBaselineRaw = await readFile(baselinePath);
  const restorePostUpdateResources = async () => {
    await writeFile(resourcePath("en"), postUpdateSourceRaw);
    await writeFile(resourcePath("zh-CN"), postUpdateChineseRaw);
    await writeFile(baselinePath, postUpdateBaselineRaw);
  };

  const unrecordedKey = "Lioni ticket 07 unrecorded addition and removal";
  const unrecordedText = "临时增加后未记录基线的英文原文";
  let unrecordedAdditionUpdateMs: number;
  let unrecordedRemovalUpdateMs: number;
  try {
    const temporarySource = await readStringMap(resourcePath("en"));
    temporarySource[unrecordedKey] = unrecordedText;
    await writeStringMap(resourcePath("en"), temporarySource);
    const additionStarted = performance.now();
    const additionCommand = await cli("update", updateConfigPath);
    unrecordedAdditionUpdateMs = performance.now() - additionStarted;
    const additionResult = readEnvelope<UpdateExecutionResult>(
      additionCommand.stdout,
      "update",
    );
    assert.equal(additionResult.status, "completed");
    const additionItemIndex = additionResult.plan.items.findIndex(
      ({ sourceKey, language }) =>
        sourceKey === unrecordedKey && language === "zh-CN",
    );
    assert.ok(additionItemIndex >= 0);
    assert.equal(additionResult.plan.items[additionItemIndex]?.action, "write");
    assert.equal(
      additionResult.results.find(({ index }) => index === additionItemIndex)
        ?.status,
      "written",
    );
    assert.equal(
      (await readStringMap(resourcePath("zh-CN")))[unrecordedKey],
      unrecordedText,
    );

    const removedSource = await readStringMap(resourcePath("en"));
    delete removedSource[unrecordedKey];
    await writeStringMap(resourcePath("en"), removedSource);
    const removalStarted = performance.now();
    const removalCommand = await cli("update", updateConfigPath);
    unrecordedRemovalUpdateMs = performance.now() - removalStarted;
    const removalResult = readEnvelope<UpdateExecutionResult>(
      removalCommand.stdout,
      "update",
    );
    assert.equal(removalResult.status, "completed");
    assert.ok(
      !removalResult.plan.items.some(
        ({ action, sourceKey, target }) =>
          action === "delete" &&
          (sourceKey === unrecordedKey || target?.key === unrecordedKey),
      ),
    );
    assert.equal(
      (await readStringMap(resourcePath("zh-CN")))[unrecordedKey],
      unrecordedText,
    );
    assert.deepEqual(await readFile(baselinePath), postUpdateBaselineRaw);
  } finally {
    await restorePostUpdateResources();
  }

  const historicalDeletionKey = "Lioni ticket 07 historically recorded removal";
  const historicalDeletionText = "已有历史基线的临时英文原文";
  let historicalBaselineRecordMs: number;
  let historicalDeletionUpdateMs: number;
  try {
    const temporarySource = await readStringMap(resourcePath("en"));
    const temporaryTarget = await readStringMap(resourcePath("zh-CN"));
    temporarySource[historicalDeletionKey] = historicalDeletionText;
    temporaryTarget[historicalDeletionKey] = "已记录的临时目标译文";
    await writeStringMap(resourcePath("en"), temporarySource);
    await writeStringMap(resourcePath("zh-CN"), temporaryTarget);
    const recordStarted = performance.now();
    const recordCommand = await cli("baseline", updateConfigPath);
    historicalBaselineRecordMs = performance.now() - recordStarted;
    const recorded = readEnvelope<BaselineResult>(
      recordCommand.stdout,
      "baseline",
    );
    assert.equal(recorded.outcome, "saved");
    const recordedBaselineRaw = await readFile(baselinePath);

    const removedSource = await readStringMap(resourcePath("en"));
    delete removedSource[historicalDeletionKey];
    await writeStringMap(resourcePath("en"), removedSource);
    const deletionStarted = performance.now();
    const deletionCommand = await cli("update", updateConfigPath);
    historicalDeletionUpdateMs = performance.now() - deletionStarted;
    const deletionResult = readEnvelope<UpdateExecutionResult>(
      deletionCommand.stdout,
      "update",
    );
    assert.equal(deletionResult.status, "completed");
    const deletionItemIndex = deletionResult.plan.items.findIndex(
      ({ action, sourceKey, target }) =>
        action === "delete" &&
        (sourceKey === historicalDeletionKey ||
          target?.key === historicalDeletionKey),
    );
    assert.ok(deletionItemIndex >= 0);
    assert.equal(
      deletionResult.results.find(({ index }) => index === deletionItemIndex)
        ?.status,
      "written",
    );
    assert.ok(
      !Object.hasOwn(
        await readStringMap(resourcePath("zh-CN")),
        historicalDeletionKey,
      ),
    );
    assert.deepEqual(await readFile(baselinePath), recordedBaselineRaw);
  } finally {
    await restorePostUpdateResources();
  }

  const manuallyEditedKey = [...sourceKeys].find((key) =>
    Object.hasOwn(updatedChinese, key),
  );
  assert.ok(manuallyEditedKey);
  const manualSourceText = "票07独立记录的人工修改原文";
  const manualTargetText = "票07独立记录的人工修改译文";
  let manualBaselineRecordMs: number;
  let manualUpdateMs: number;
  try {
    const manuallyEditedSource = await readStringMap(resourcePath("en"));
    const manuallyEditedTarget = await readStringMap(resourcePath("zh-CN"));
    manuallyEditedSource[manuallyEditedKey] = manualSourceText;
    manuallyEditedTarget[manuallyEditedKey] = manualTargetText;
    await writeStringMap(resourcePath("en"), manuallyEditedSource);
    await writeStringMap(resourcePath("zh-CN"), manuallyEditedTarget);
    const recordStarted = performance.now();
    const recordCommand = await cli("baseline", updateConfigPath);
    manualBaselineRecordMs = performance.now() - recordStarted;
    assert.equal(
      readEnvelope<BaselineResult>(recordCommand.stdout, "baseline").outcome,
      "saved",
    );
    const manuallyRecordedBaselineRaw = await readFile(baselinePath);

    const manualUpdateStarted = performance.now();
    const manualUpdateCommand = await cli("update", updateConfigPath);
    manualUpdateMs = performance.now() - manualUpdateStarted;
    const manualUpdateResult = readEnvelope<UpdateExecutionResult>(
      manualUpdateCommand.stdout,
      "update",
    );
    assert.equal(manualUpdateResult.status, "completed");
    const manualItemIndex = manualUpdateResult.plan.items.findIndex(
      ({ sourceKey, language }) =>
        sourceKey === manuallyEditedKey && language === "zh-CN",
    );
    assert.ok(manualItemIndex >= 0);
    assert.equal(
      manualUpdateResult.plan.items[manualItemIndex]?.action,
      "retain",
    );
    assert.equal(
      manualUpdateResult.results.find(({ index }) => index === manualItemIndex)
        ?.status,
      "retained",
    );
    assert.equal(
      (await readStringMap(resourcePath("zh-CN")))[manuallyEditedKey],
      manualTargetText,
    );
    assert.deepEqual(await readFile(baselinePath), manuallyRecordedBaselineRaw);
  } finally {
    await restorePostUpdateResources();
  }

  assert.deepEqual(await readFile(resourcePath("en")), postUpdateSourceRaw);
  assert.deepEqual(await readFile(resourcePath("zh-CN")), postUpdateChineseRaw);
  assert.deepEqual(await readFile(baselinePath), postUpdateBaselineRaw);

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
    staleInputConflict: {
      result: "conflict",
      targetUnchanged: true,
      baselineUnchanged: true,
    },
    sdkApply: {
      status: "completed",
      decisions: updatePlanResult.items.length,
      written: 17,
      retained: 1738,
      finalTargetRestoredBeforeCliUpdate: true,
      baselineUnchanged: true,
    },
    updateExecution: {
      status: actualUpdate.status,
      selectedLanguages: ["zh-CN"],
      decisions: actualUpdate.results.length,
      writes: actualUpdate.results.filter(
        ({ action, status }) => action === "write" && status === "written",
      ).length,
      retained: actualUpdate.results.filter(
        ({ action, status }) => action === "retain" && status === "retained",
      ).length,
      deletes: actualUpdate.results.filter(({ action }) => action === "delete")
        .length,
      targetEntriesAfterWrite: Object.keys(updatedChinese).length,
      sourceByteIdentical: true,
      existingChineseValuesPreserved: true,
      placeholdersEqualEnglishSource: true,
      baselineUnchanged: true,
    },
    postUpdateFacts: {
      sourceEntries: postUpdateFacts.source.units.length,
      zhCNEntries: postUpdateChineseRecords.length,
      zhCNMissingSource: postUpdateFacts.associations.filter(
        ({ language, status }) => language === "zh-CN" && status === "missing",
      ).length,
      zhCNTargetOnly: postUpdateChineseRecords.filter(
        ({ translation }) => !sourceKeys.has(translation.key),
      ).length,
    },
    controlledResourceCases: {
      unrecordedAdditionThenRemoval: {
        firstUpdate: "wrote placeholder",
        secondUpdate: "retained target-only item",
        baselineUnchanged: true,
        resourcesRestored: true,
      },
      historicalSourceDeletion: {
        baselineRecordedIndependently: true,
        deletionWritten: true,
        baselineUnchangedDuringUpdate: true,
        resourcesRestored: true,
      },
      manualEditsThenIndependentBaseline: {
        baselineRecordedIndependently: true,
        editedTargetRetained: true,
        baselineUnchangedDuringUpdate: true,
        resourcesRestored: true,
      },
      finalSourceMatchesPostUpdate: true,
      finalChineseTargetMatchesPostUpdate: true,
      finalBaselineMatchesPostUpdate: true,
    },
    writebackConformance: {
      executedFromInstalledArtifact: true,
      tests: 3,
      addEditDeletePreservesTargetOnlyItems: true,
      staleTargetIsReportedAsConflictWithoutOverwrite: true,
      partialFailure: { ja: "writeFailed", zhCN: "written" },
    },
    quality: {
      status: quality.status,
      observedAt: { started: qaStartedAt, finished: qaFinishedAt },
      diagnostics: quality.diagnostics.length,
      byLanguage,
      checks: quality.checks.map(({ checkId }) => checkId),
      findings: quality.diagnostics,
    },
    timings: {
      conditions:
        "Node 24、固定上游副本、已安装同批正式制品；不启动 Kuma 应用。",
      phaseNotes: {
        factsReadAndAssociationMs:
          "正式CLI facts端到端，包含进程启动、读取英文与两种目标资源及计算关联。",
        baselineReadAndRecordMs:
          "正式CLI zh-CN baseline端到端，包含进程启动、重读所选事实和写入基线。",
        updatePlanningMs:
          "正式CLI update --dry-run端到端，包含进程启动、资源读取、基线读取和比较规划。",
        sdkApplyWritebackPhaseMs:
          "同批已安装core对CLI序列化计划调用applyUpdatePlan，包含进程启动、计划校验、源/目标条件读取、17项写入及写后回读；不含规划，目标随后恢复。",
        cliUpdateEndToEndMs:
          "正式CLI update端到端，重新规划并执行；包含重复资源/基线读取、条件核对、写入及回读。",
        postUpdateFactsReadMs: "正式CLI facts在写入后重新读取资源并计算关联。",
        qaEndToEndMs:
          "正式CLI qa双语言端到端，包含进程启动、QA按需准备和检查。",
        completeScenarioMs:
          "从宿主typecheck开始，包含消费者安装、全部SDK/CLI调用、额外隔离资源旅程和清理；阶段值有重复读取与进程启动，不可直接相加。",
      },
      factsReadAndAssociationMs: factsMs,
      baselineReadAndRecordMs: baselineMs,
      updatePlanningMs,
      updatePreviewEndToEndMs: updatePreviewMs,
      staleInputConflictMs,
      sdkApplyWritebackPhaseMs,
      cliUpdateEndToEndMs: updateEndToEndMs,
      postUpdateFactsReadMs: postUpdateFactsMs,
      qaEndToEndMs: qaMs,
      controlledCases: {
        unrecordedAdditionUpdateMs,
        unrecordedRemovalUpdateMs,
        historicalBaselineRecordMs,
        historicalDeletionUpdateMs,
        manualBaselineRecordMs,
        manualUpdateMs,
      },
      completeScenarioMs: performance.now() - wholeRunStarted,
      hostTypecheckMs: hostTypes.durationMs,
    },
    environment: {
      node: process.version,
      platform: os.platform(),
      arch: os.arch(),
    },
    resourcesAfterScenario: {
      sourceMatchesPostUpdateSnapshot: true,
      zhCNMatchesPostUpdateSnapshot: true,
      baselineMatchesPostUpdateSnapshot: true,
      updatePlaceholdersRemainInZhCN: true,
    },
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
