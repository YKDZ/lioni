import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import type { QualityCheckResultCache } from "@lioni/lioni";
import { createDirectoryQualityCheckResultCache } from "@lioni/lioni/node";

type CacheValue = NonNullable<
  Awaited<ReturnType<QualityCheckResultCache["get"]>>
>;

type FileStats = {
  readonly atimeNs: bigint;
  readonly ctimeNs: bigint;
  readonly mtimeNs: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly blocks: bigint;
};

type ScaleResult = {
  readonly backgroundEntries: number;
  readonly totalEntries: number;
  readonly coldWriteMs: number;
  readonly warmReadMs: number;
  readonly warmReadCount: number;
  readonly fileBytes: number;
  readonly allocatedFileBytes: number;
  readonly atimeObservation: "observed" | "unsupported";
  readonly fixedGetTouchedFiles: number;
  readonly fixedSetReadUnrelatedFiles: number;
  readonly fixedSetChangedFiles: number;
  readonly fixedGetMedianMsPerOperation: number;
  readonly fixedSetMedianMsPerOperation: number;
};

const fixedKey = "fixed-query-and-update";
const operationRepeats = 100;
const measuredBlocks = 5;
const scales = [0, 100, 1000, 5000] as const;
const outcome: CacheValue = {
  status: "complete",
  diagnostics: [],
  issues: [],
  coverage: {
    selected: 1,
    evaluated: 1,
    notApplicable: 0,
    incomplete: 0,
    failed: 0,
  },
};
const updatedOutcome: CacheValue = {
  ...outcome,
  coverage: { ...outcome.coverage, selected: 1_000_000 },
};

async function fileSnapshot(
  directory: string,
): Promise<Map<string, FileStats>> {
  const names = await readdir(directory);
  const entries = await Promise.all(
    names.map(async (name) => {
      const info = await stat(path.join(directory, name), { bigint: true });
      return [
        name,
        {
          atimeNs: info.atimeNs,
          ctimeNs: info.ctimeNs,
          mtimeNs: info.mtimeNs,
          ino: info.ino,
          size: info.size,
          blocks: info.blocks,
        },
      ] as const;
    }),
  );
  return new Map(entries);
}

async function resetAccessTimes(directory: string): Promise<void> {
  const epoch = new Date(0);
  await Promise.all(
    (await readdir(directory)).map((name) =>
      utimes(path.join(directory, name), epoch, epoch),
    ),
  );
}

async function supportsAccessTimeObservation(root: string): Promise<boolean> {
  const probePath = path.join(root, "atime-probe");
  await writeFile(probePath, "probe");
  const epoch = new Date(0);
  await utimes(probePath, epoch, epoch);
  const before = await stat(probePath, { bigint: true });
  await readFile(probePath);
  const after = await stat(probePath, { bigint: true });
  await rm(probePath);
  return before.atimeNs !== after.atimeNs;
}

function median(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  const lower = ordered[middle - 1];
  const upper = ordered[middle];
  assert.ok(lower !== undefined && upper !== undefined);
  return ordered.length % 2 === 0 ? (lower + upper) / 2 : upper;
}

async function measureFixedOperations(
  operation: () => Promise<unknown>,
): Promise<number> {
  for (let index = 0; index < 10; index += 1) await operation();
  const blocks: number[] = [];
  for (let block = 0; block < measuredBlocks; block += 1) {
    const started = performance.now();
    for (let index = 0; index < operationRepeats; index += 1) await operation();
    blocks.push((performance.now() - started) / operationRepeats);
  }
  return median(blocks);
}

async function measureScale(backgroundEntries: number): Promise<ScaleResult> {
  const root = await mkdtemp(path.join(os.tmpdir(), "lioni-directory-cache-"));
  const directory = path.join(root, "quality-results");
  const cache = createDirectoryQualityCheckResultCache(directory);
  const accessTimeSupported = await supportsAccessTimeObservation(root);

  const coldWriteStarted = performance.now();
  for (let index = 0; index < backgroundEntries; index += 1)
    await cache.set(`background:${index}`, outcome);
  await cache.set(fixedKey, outcome);
  const coldWriteMs = performance.now() - coldWriteStarted;

  const initialSnapshot = await fileSnapshot(directory);
  assert.equal(initialSnapshot.size, backgroundEntries + 1);
  const fileBytes = [...initialSnapshot.values()].reduce(
    (total, entry) => total + entry.size,
    0n,
  );
  const allocatedFileBytes = [...initialSnapshot.values()].reduce(
    (total, entry) => total + entry.blocks * 512n,
    0n,
  );

  const warmReadStarted = performance.now();
  for (let index = 0; index < backgroundEntries; index += 1)
    assert.deepEqual(await cache.get(`background:${index}`), outcome);
  assert.deepEqual(await cache.get(fixedKey), outcome);
  const warmReadMs = performance.now() - warmReadStarted;

  await resetAccessTimes(directory);
  const beforeGet = await fileSnapshot(directory);
  assert.deepEqual(await cache.get(fixedKey), outcome);
  const afterGet = await fileSnapshot(directory);
  const fixedGetTouchedFiles = [...beforeGet].filter(
    ([name, previous]) => afterGet.get(name)?.atimeNs !== previous.atimeNs,
  );
  if (accessTimeSupported) assert.equal(fixedGetTouchedFiles.length, 1);

  await resetAccessTimes(directory);
  const beforeSet = await fileSnapshot(directory);
  await cache.set(fixedKey, updatedOutcome);
  const afterSet = await fileSnapshot(directory);
  const fixedSetChangedFiles = [...beforeSet].filter(([name, previous]) => {
    const current = afterSet.get(name);
    return (
      current === undefined ||
      current.ctimeNs !== previous.ctimeNs ||
      current.mtimeNs !== previous.mtimeNs ||
      current.ino !== previous.ino ||
      current.size !== previous.size
    );
  });
  assert.equal(afterSet.size, beforeSet.size);
  assert.equal(fixedSetChangedFiles.length, 1);
  const changedFilename = fixedSetChangedFiles[0]?.[0];
  assert.ok(changedFilename);
  assert.notEqual(
    fixedSetChangedFiles[0]?.[1].size,
    afterSet.get(changedFilename)?.size,
  );
  assert.deepEqual(await cache.get(fixedKey), updatedOutcome);
  const fixedSetReadUnrelatedFiles = [...beforeSet].filter(
    ([name, previous]) =>
      name !== changedFilename &&
      afterSet.get(name)?.atimeNs !== previous.atimeNs,
  );
  if (accessTimeSupported)
    assert.deepEqual(
      fixedSetReadUnrelatedFiles,
      [],
      "固定键 set 不应读取背景条目。",
    );

  const fixedGetMedianMsPerOperation = await measureFixedOperations(
    async () => {
      assert.deepEqual(await cache.get(fixedKey), updatedOutcome);
    },
  );
  const fixedSetMedianMsPerOperation = await measureFixedOperations(() =>
    cache.set(fixedKey, updatedOutcome),
  );

  const result = {
    backgroundEntries,
    totalEntries: initialSnapshot.size,
    coldWriteMs: Number(coldWriteMs.toFixed(2)),
    warmReadMs: Number(warmReadMs.toFixed(2)),
    warmReadCount: backgroundEntries + 1,
    fileBytes: Number(fileBytes),
    allocatedFileBytes: Number(allocatedFileBytes),
    atimeObservation: accessTimeSupported ? "observed" : "unsupported",
    fixedGetTouchedFiles: fixedGetTouchedFiles.length,
    fixedSetReadUnrelatedFiles: fixedSetReadUnrelatedFiles.length,
    fixedSetChangedFiles: fixedSetChangedFiles.length,
    fixedGetMedianMsPerOperation: Number(
      fixedGetMedianMsPerOperation.toFixed(4),
    ),
    fixedSetMedianMsPerOperation: Number(
      fixedSetMedianMsPerOperation.toFixed(4),
    ),
  } satisfies ScaleResult;
  await rm(root, { recursive: true, force: true });
  return result;
}

const results: ScaleResult[] = [];
for (const count of scales) results.push(await measureScale(count));

for (const field of [
  "fixedGetMedianMsPerOperation",
  "fixedSetMedianMsPerOperation",
] as const) {
  const smallest = results[0]?.[field];
  const largest = results.at(-1)?.[field];
  assert.ok(smallest !== undefined && largest !== undefined && smallest > 0);
  assert.ok(
    largest <= smallest * 8,
    `${field} 随背景文件增长超过 8 倍：${smallest} → ${largest} ms/op`,
  );
}

const runRoot = process.env.LIONI_ARTIFACT_RUN_ROOT;
assert.ok(runRoot, "请通过正式制品验收运行目录缓存负载。");
const artifacts = JSON.parse(
  await readFile(path.join(runRoot, "artifacts.json"), "utf8"),
) as readonly { readonly name: string; readonly filename: string }[];
const artifact = artifacts.find(({ name }) => name === "@lioni/lioni");
assert.ok(artifact, "缺少本次正式产品 tarball。");
const sha256 = createHash("sha256")
  .update(await readFile(artifact.filename))
  .digest("hex");
const metadata = JSON.parse(
  await readFile(
    path.join(process.cwd(), "node_modules/@lioni/lioni/package.json"),
    "utf8",
  ),
) as { readonly version: string };
const report = {
  schemaVersion: 1,
  artifact: {
    package: "@lioni/lioni",
    version: metadata.version,
    sourceRevision: process.env.LIONI_ARTIFACT_SOURCE_REVISION ?? "unknown",
    sha256,
  },
  environment: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    filesystemRoot: os.tmpdir(),
  },
  method: {
    cache: "来自已安装 tarball 的公开 createDirectoryQualityCheckResultCache",
    backgroundEntries: scales,
    fixedOperationRepeats: operationRepeats,
    measuredBlocks,
    relativeBudget: "固定操作中位耗时不超过空目录时的8倍",
    structuralObservation:
      "支持时用逐文件访问时间观察 get；用文件元数据观察 set",
  },
  scales: results,
};
const evidencePath = path.join(runRoot, "qa-directory-cache-scale.json");
await writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`目录缓存规模证据：${evidencePath}\n`);
process.stdout.write(`${JSON.stringify(report)}\n`);
