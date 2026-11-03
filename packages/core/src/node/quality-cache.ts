import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { isRecord } from "../object-guards.ts";
import {
  isCacheableQualityCheckOutcome,
  type CacheableQualityCheckOutcome,
  type QualityCheckResultCache,
} from "../quality/quality-cache.ts";
import { stableStringify } from "../stable-json.ts";

const QUALITY_CACHE_ENTRY_FORMAT = "lioni.qa-cache-entry/v1" as const;

type QualityCacheEntry = {
  readonly format: typeof QUALITY_CACHE_ENTRY_FORMAT;
  readonly key: string;
  readonly outcome: CacheableQualityCheckOutcome;
  readonly contentDigest: string;
};

/**
 * 在专用目录内按键保存独立缓存条目。
 * 目录可由多个实例共用；文件系统错误按缓存未命中处理。
 */
export function createDirectoryQualityCheckResultCache(
  cacheDirectory: string,
): QualityCheckResultCache {
  const resolvedDirectory = path.resolve(cacheDirectory);
  return {
    async get(key) {
      if (!isCacheKey(key)) return undefined;

      let contents: string;
      try {
        contents = await readFile(
          entryPathForKey(resolvedDirectory, key),
          "utf8",
        );
      } catch {
        return undefined;
      }

      let value: unknown;
      try {
        value = JSON.parse(contents);
      } catch {
        return undefined;
      }
      return isQualityCacheEntry(value, key) ? value.outcome : undefined;
    },

    async set(key, outcome) {
      if (!isCacheKey(key) || !isCacheableQualityCheckOutcome(outcome)) return;

      const entry: QualityCacheEntry = {
        format: QUALITY_CACHE_ENTRY_FORMAT,
        key,
        outcome,
        contentDigest: contentDigest(key, outcome),
      };
      const entryPath = entryPathForKey(resolvedDirectory, key);
      const temporaryPath = `${entryPath}.${process.pid}.${randomUUID()}.tmp`;
      let moved = false;
      try {
        await mkdir(resolvedDirectory, { recursive: true });
        await writeFile(temporaryPath, `${JSON.stringify(entry)}\n`, "utf8");
        await rename(temporaryPath, entryPath);
        moved = true;
      } catch {
        // 缓存 I/O 失败只会让后续执行重新计算。
      } finally {
        if (!moved) await unlink(temporaryPath).catch(() => undefined);
      }
    },
  };
}

/** 解析配置文件同目录 `.lioni/cache/quality-results` 下的默认缓存目录。 */
export function resolveDefaultQualityCheckResultCacheDirectory(
  configPath: string,
): string {
  const absoluteConfigPath = path.resolve(process.cwd(), configPath);
  return path.join(
    path.dirname(absoluteConfigPath),
    ".lioni",
    "cache",
    "quality-results",
  );
}

/** 根据 Node.js 配置文件位置创建默认目录结果缓存；不会自动装配到 QA。 */
export function createDefaultDirectoryQualityCheckResultCache(
  configPath: string,
): QualityCheckResultCache {
  return createDirectoryQualityCheckResultCache(
    resolveDefaultQualityCheckResultCacheDirectory(configPath),
  );
}

function entryPathForKey(directory: string, key: string): string {
  // 保留 JavaScript 字符串的 UTF-16 码元，避免孤立代理项与替换字符共用路径。
  const filename = createHash("sha256").update(key, "utf16le").digest("hex");
  return path.join(directory, `${filename}.json`);
}

function isQualityCacheEntry(
  value: unknown,
  expectedKey: string,
): value is QualityCacheEntry {
  return (
    isRecord(value) &&
    value.format === QUALITY_CACHE_ENTRY_FORMAT &&
    value.key === expectedKey &&
    isCacheableQualityCheckOutcome(value.outcome) &&
    isContentDigest(value.contentDigest) &&
    value.contentDigest === contentDigest(value.key, value.outcome)
  );
}

function contentDigest(
  key: string,
  outcome: CacheableQualityCheckOutcome,
): string {
  const content = stableStringify({ key, outcome });
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function isContentDigest(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function isCacheKey(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
