import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  CacheableQualityCheckOutcome,
  QualityCheckResultCache,
} from "./quality-cache.ts";
import { assertJsonValue } from "./standard-schema.ts";

const QUALITY_CACHE_FORMAT = "lioni.qa-cache/v1" as const;

type QualityCacheDocument = {
  readonly format: typeof QUALITY_CACHE_FORMAT;
  readonly entries: readonly QualityCacheEntry[];
};

type QualityCacheEntry = {
  readonly key: string;
  readonly outcome: CacheableQualityCheckOutcome;
};

/** 创建尽力而为的 Node.js 文件检查结果缓存。 */
export function createFileQualityCheckResultCache(
  filePath: string,
): QualityCheckResultCache {
  const resolvedFilePath = path.resolve(filePath);
  return {
    async get(key) {
      if (!isCacheKey(key)) return undefined;
      const document = await readCacheDocument(resolvedFilePath);
      return document?.entries.find((entry) => entry.key === key)?.outcome;
    },

    async set(key, outcome) {
      if (!isCacheKey(key) || !isCacheableQualityCheckOutcome(outcome)) return;

      const document = await readCacheDocument(resolvedFilePath);
      const entries = [...(document?.entries ?? [])];
      const index = entries.findIndex((entry) => entry.key === key);
      const nextEntry = { key, outcome };
      if (index === -1) entries.push(nextEntry);
      else entries[index] = nextEntry;

      await writeCacheDocument(resolvedFilePath, {
        format: QUALITY_CACHE_FORMAT,
        entries,
      });
    },
  };
}

/** 解析位于配置文件同目录 `.lioni/cache` 下的默认缓存文件。 */
export function resolveDefaultQualityCheckResultCachePath(
  configPath: string,
): string {
  const absoluteConfigPath = path.resolve(process.cwd(), configPath);
  return path.join(
    path.dirname(absoluteConfigPath),
    ".lioni",
    "cache",
    "quality-results.json",
  );
}

/** 根据 Node.js 配置文件位置创建默认文件缓存。 */
export function createDefaultQualityCheckResultCache(
  configPath: string,
): QualityCheckResultCache {
  return createFileQualityCheckResultCache(
    resolveDefaultQualityCheckResultCachePath(configPath),
  );
}

async function readCacheDocument(
  filePath: string,
): Promise<QualityCacheDocument | undefined> {
  let contents: string;
  try {
    contents = await readFile(filePath, "utf8");
  } catch {
    return undefined;
  }

  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    return undefined;
  }
  return isCacheDocument(value) ? value : undefined;
}

async function writeCacheDocument(
  filePath: string,
  document: QualityCacheDocument,
): Promise<void> {
  let contents: string;
  try {
    assertJsonValue(document, "QA 结果缓存");
    contents = `${JSON.stringify(document, null, 2)}\n`;
  } catch {
    return;
  }

  const directory = path.dirname(filePath);
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let moved = false;
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(temporaryPath, contents, "utf8");
    await rename(temporaryPath, filePath);
    moved = true;
  } catch {
    // 缓存 I/O 失败只会让后续执行重新计算。
  } finally {
    if (!moved) await unlink(temporaryPath).catch(() => undefined);
  }
}

function isCacheDocument(value: unknown): value is QualityCacheDocument {
  if (
    !isRecord(value) ||
    value.format !== QUALITY_CACHE_FORMAT ||
    !Array.isArray(value.entries)
  )
    return false;

  const keys = new Set<string>();
  for (const entry of value.entries) {
    if (!isRecord(entry) || !isCacheKey(entry.key)) return false;
    if (keys.has(entry.key)) return false;
    if (!isCacheableQualityCheckOutcome(entry.outcome)) return false;
    keys.add(entry.key);
  }
  return true;
}

function isCacheableQualityCheckOutcome(
  value: unknown,
): value is CacheableQualityCheckOutcome {
  if (
    !isRecord(value) ||
    (value.status !== "complete" && value.status !== "not-applicable") ||
    !Array.isArray(value.diagnostics) ||
    !value.diagnostics.every(isQualityFinding) ||
    !Array.isArray(value.issues) ||
    !value.issues.every(isQualityIssue) ||
    !isRecord(value.coverage)
  )
    return false;

  for (const key of [
    "selected",
    "evaluated",
    "notApplicable",
    "incomplete",
    "failed",
  ]) {
    const count = value.coverage[key];
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)
      return false;
  }

  try {
    assertJsonValue(value, "QA 原始检查结果");
  } catch {
    return false;
  }
  return true;
}

function isQualityFinding(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.severity === "error" ||
      value.severity === "warning" ||
      value.severity === "info") &&
    isQualityObject(value.object) &&
    isQualityLocation(value.location) &&
    typeof value.message === "string" &&
    Array.isArray(value.evidence) &&
    value.evidence.every(isQualityEvidence)
  );
}

function isQualityIssue(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.code === "string" &&
    typeof value.message === "string" &&
    (value.object === undefined || isQualityObject(value.object)) &&
    (value.location === undefined || isQualityLocation(value.location)) &&
    (value.evidence === undefined ||
      (Array.isArray(value.evidence) &&
        value.evidence.every(isQualityEvidence)))
  );
}

function isQualityEvidence(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.role === "string" &&
    isQualityObject(value.object) &&
    isQualityLocation(value.location) &&
    Object.hasOwn(value, "value")
  );
}

function isQualityObject(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.kind === "string" &&
    typeof value.key === "string"
  );
}

function isQualityLocation(value: unknown): boolean {
  return (
    isRecord(value) &&
    (typeof value.language === "string" || value.language === null) &&
    Object.hasOwn(value, "range") &&
    (value.key === undefined || typeof value.key === "string")
  );
}

function isCacheKey(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
