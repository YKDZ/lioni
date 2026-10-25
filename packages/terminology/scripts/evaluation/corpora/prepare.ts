import { readFile } from "node:fs/promises";
import path from "node:path";

import { sha256 } from "../support/json.ts";
import { packageRoot } from "../support/report.ts";
import { loadExternalInputCache, type CorpusCacheState } from "./cache.ts";
import {
  convertCfpaSource,
  convertKumaSource,
  transformedExternalInput,
  type CfpaPreparedInput,
  type KumaPreparedInput,
  type TransformedExternalInput,
} from "./convert.ts";
import { cfpaSource, kumaSource } from "./manifest.ts";
import { verifySourceRoot, type VerifiedSource } from "./source.ts";

export type ExternalCorpusId = "cfpa" | "kuma";

export type PreparedExternalCorpus =
  | {
      readonly id: "cfpa";
      readonly source: VerifiedSource;
      readonly input: CfpaPreparedInput;
      readonly inputSha256: string;
      readonly cache: {
        readonly state: CorpusCacheState;
        readonly path: string;
      };
    }
  | {
      readonly id: "kuma";
      readonly source: VerifiedSource;
      readonly input: KumaPreparedInput;
      readonly inputSha256: string;
      readonly cache: {
        readonly state: CorpusCacheState;
        readonly path: string;
      };
    };

export type PrepareExternalCorpusOptions = {
  readonly id: ExternalCorpusId;
  readonly sourceRoot: string;
  readonly cacheDirectory?: string;
  readonly rebuild?: boolean;
};

const defaultCacheDirectory = path.join(
  packageRoot,
  "node_modules",
  ".cache",
  "lioni-terminology-evaluation",
  "inputs",
);

async function readVerifiedSourceFile(
  source: VerifiedSource,
  relativePath: string,
): Promise<string> {
  const manifest = source.id === "cfpa" ? cfpaSource : kumaSource;
  const expected = manifest.files.find(
    ({ path: filename }) => filename === relativePath,
  );
  if (!expected)
    throw new Error(`${source.id} 转换器尝试读取未登记文件：${relativePath}`);
  const buffer = await readFile(path.join(source.root, relativePath));
  const actual = sha256(buffer);
  if (actual !== expected.sha256)
    throw new Error(
      `${source.id} 原始文件在校验后发生变化：${relativePath}，期望 ${expected.sha256}，实际 ${actual}。`,
    );
  return buffer.toString("utf8");
}

async function prepareCfpa(
  sourceRoot: string,
  cacheDirectory: string,
  rebuild: boolean,
): Promise<PreparedExternalCorpus> {
  const source = await verifySourceRoot(cfpaSource, sourceRoot);
  const cached = await loadExternalInputCache<TransformedExternalInput>({
    id: "cfpa",
    sourceCommit: source.commit,
    converterVersion: source.converterVersion,
    expectedSha256: cfpaSource.expectedTransformedSha256,
    directory: cacheDirectory,
    rebuild,
    build: async () =>
      transformedExternalInput(
        await convertCfpaSource(source, (filename) =>
          readVerifiedSourceFile(source, filename),
        ),
      ),
  });
  if (cached.value.id !== "cfpa") throw new Error("CFPA 转换缓存类型不符。");
  const input: CfpaPreparedInput = Object.freeze({
    ...cached.value,
    source,
  });
  return Object.freeze({
    id: "cfpa",
    source,
    input,
    inputSha256: cached.sha256,
    cache: Object.freeze({ state: cached.cacheState, path: cached.cachePath }),
  });
}

async function prepareKuma(
  sourceRoot: string,
  cacheDirectory: string,
  rebuild: boolean,
): Promise<PreparedExternalCorpus> {
  const source = await verifySourceRoot(kumaSource, sourceRoot);
  const cached = await loadExternalInputCache<TransformedExternalInput>({
    id: "kuma",
    sourceCommit: source.commit,
    converterVersion: source.converterVersion,
    expectedSha256: kumaSource.expectedTransformedSha256,
    directory: cacheDirectory,
    rebuild,
    build: async () =>
      transformedExternalInput(
        await convertKumaSource(source, (filename) =>
          readVerifiedSourceFile(source, filename),
        ),
      ),
  });
  if (cached.value.id !== "kuma")
    throw new Error("Uptime Kuma 转换缓存类型不符。");
  const input: KumaPreparedInput = Object.freeze({
    ...cached.value,
    source,
  });
  return Object.freeze({
    id: "kuma",
    source,
    input,
    inputSha256: cached.sha256,
    cache: Object.freeze({ state: cached.cacheState, path: cached.cachePath }),
  });
}

/** 校验固定本地副本，复用或重建被固定散列确认的转换输入。 */
export async function prepareExternalCorpus(
  options: PrepareExternalCorpusOptions,
): Promise<PreparedExternalCorpus> {
  const cacheDirectory = options.cacheDirectory ?? defaultCacheDirectory;
  return options.id === "cfpa"
    ? prepareCfpa(options.sourceRoot, cacheDirectory, options.rebuild ?? false)
    : prepareKuma(options.sourceRoot, cacheDirectory, options.rebuild ?? false);
}
