import { readFile, rm, mkdir } from "node:fs/promises";
import path from "node:path";

import { canonicalJson, sha256, writeJsonAtomic } from "../support/json.ts";

export type CorpusCacheState = "built" | "reused" | "rebuilt";

export type CachedExternalInput<T> = {
  readonly value: T;
  readonly sha256: string;
  readonly cachePath: string;
  readonly cacheState: CorpusCacheState;
};

export type ExternalInputCacheOptions<T> = {
  readonly id: string;
  readonly sourceCommit: string;
  readonly converterVersion: string;
  readonly expectedSha256: string;
  readonly directory: string;
  readonly rebuild?: boolean;
  readonly build: () => Promise<T>;
};

type CacheEnvelope<T> = {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly sourceCommit: string;
  readonly converterVersion: string;
  readonly inputSha256: string;
  readonly input: T;
};

/** 仅复用来源、转换器和固定内容散列均匹配的转换输入。 */
export async function loadExternalInputCache<T>(
  options: ExternalInputCacheOptions<T>,
): Promise<CachedExternalInput<T>> {
  const cachePath = path.join(
    options.directory,
    `${options.id}-${options.sourceCommit}-${options.converterVersion}-${options.expectedSha256}.json`,
  );
  let existing: CacheEnvelope<T> | undefined;
  if (!options.rebuild) {
    try {
      existing = JSON.parse(
        await readFile(cachePath, "utf8"),
      ) as CacheEnvelope<T>;
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      )
        throw new Error(`转换语料缓存无法读取：${cachePath}。`, {
          cause: error,
        });
    }
  }
  if (existing !== undefined) {
    const actual = sha256(canonicalJson(existing.input));
    if (
      existing.schemaVersion !== 1 ||
      existing.id !== options.id ||
      existing.sourceCommit !== options.sourceCommit ||
      existing.converterVersion !== options.converterVersion ||
      existing.inputSha256 !== options.expectedSha256 ||
      actual !== options.expectedSha256
    )
      throw new Error(
        `转换语料缓存校验失败：${cachePath}，实际输入散列 ${actual}。请显式使用 --rebuild 重建。`,
      );
    return Object.freeze({
      value: existing.input,
      sha256: actual,
      cachePath,
      cacheState: "reused",
    });
  }

  const value = await options.build();
  const actual = sha256(canonicalJson(value));
  if (actual !== options.expectedSha256)
    throw new Error(
      `${options.id} 转换输入散列不符：期望 ${options.expectedSha256}，实际 ${actual}。`,
    );
  await mkdir(options.directory, { recursive: true });
  const envelope: CacheEnvelope<T> = Object.freeze({
    schemaVersion: 1,
    id: options.id,
    sourceCommit: options.sourceCommit,
    converterVersion: options.converterVersion,
    inputSha256: actual,
    input: value,
  });
  await writeJsonAtomic(cachePath, envelope);
  return Object.freeze({
    value,
    sha256: actual,
    cachePath,
    cacheState: options.rebuild ? "rebuilt" : "built",
  });
}

export async function clearExternalInputCache(
  directory: string,
  id: string,
  sourceCommit: string,
  converterVersion: string,
  expectedSha256: string,
): Promise<void> {
  const cachePath = path.join(
    directory,
    `${id}-${sourceCommit}-${converterVersion}-${expectedSha256}.json`,
  );
  await rm(cachePath, { force: true });
}
