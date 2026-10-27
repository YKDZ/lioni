import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  stableStringify,
  validateComparisonBaseline,
  type ComparisonBaseline,
  type ComparisonBaselineStore,
} from "./baselines.ts";
import {
  validateFrameworkConfig,
  type FrameworkConfig,
  type TranslationUnitInput,
} from "./index.ts";
import { createDefaultQualityExceptionStore } from "./node-quality-exceptions.ts";
import { validateUpdatePlan, type UpdatePlanStore } from "./plans.ts";
import type { JsonValue } from "./semantic-edits.ts";
import { StandardSchemaContractError } from "./standard-schema.ts";

export {
  createDefaultQualityExceptionStore,
  createFileQualityExceptionStore,
  resolveDefaultQualityExceptionFilePath,
} from "./node-quality-exceptions.ts";
export {
  createDefaultQualityCheckResultCache,
  createFileQualityCheckResultCache,
  resolveDefaultQualityCheckResultCachePath,
} from "./node-quality-cache.ts";
export type { QualityExceptionStore } from "./quality-exceptions.ts";
export type { QualityCheckResultCache } from "./quality-cache.ts";

type RuntimeFrameworkConfig = FrameworkConfig<
  TranslationUnitInput,
  unknown,
  JsonValue,
  unknown
>;

export type LoadedConfig = {
  readonly use: <TResult>(
    consumer: (config: RuntimeFrameworkConfig) => TResult,
  ) => TResult;
};

/** 从 Node.js 配置模块加载并验证默认导出的宿主配置。 */
export async function loadConfig(configPath: string): Promise<LoadedConfig> {
  const absoluteConfigPath = path.resolve(process.cwd(), configPath);
  const configUrl = pathToFileURL(absoluteConfigPath);
  const configModule = (await import(configUrl.href)) as {
    readonly default?: unknown;
  };
  if (configModule.default === undefined)
    throw new TypeError("宿主配置必须默认导出配置对象。");
  const loadedConfig = configModule.default as RuntimeFrameworkConfig;
  validateFrameworkConfig(loadedConfig);
  const config =
    loadedConfig.qualityExceptionStore === undefined
      ? {
          ...loadedConfig,
          qualityExceptionStore:
            createDefaultQualityExceptionStore(absoluteConfigPath),
        }
      : loadedConfig;
  return { use: (consumer) => consumer(config) };
}

/** 为 Node.js 宿主创建文件比较基线存储。 */
export function createFileComparisonBaselineStore<
  TUnit extends TranslationUnitInput = TranslationUnitInput,
  TTranslation = unknown,
  TBody = JsonValue,
  TUnavailable = never,
>(
  filePath: string,
): ComparisonBaselineStore<TUnit, TTranslation, TBody, TUnavailable> {
  return {
    async load() {
      return await readComparisonBaselineFile<
        TUnit,
        TTranslation,
        TBody,
        TUnavailable
      >(filePath);
    },

    async save(baseline) {
      validateComparisonBaseline(baseline);
      const contents = `${stableStringify(baseline)}\n`;
      const existing = await readComparisonBaselineFile<
        TUnit,
        TTranslation,
        TBody,
        TUnavailable
      >(filePath);
      if (
        existing !== undefined &&
        stableStringify(existing) === stableStringify(baseline)
      )
        return;
      const directory = path.dirname(filePath);
      const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
      let moved = false;
      try {
        await mkdir(directory, { recursive: true });
        await writeFile(temporaryPath, contents, "utf8");
        await rename(temporaryPath, filePath);
        moved = true;
      } finally {
        if (!moved) await unlink(temporaryPath).catch(ignoreMissingFile);
      }
    },
  };
}

async function readComparisonBaselineFile<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  filePath: string,
): Promise<
  ComparisonBaseline<TUnit, TTranslation, TBody, TUnavailable> | undefined
> {
  let contents: string;
  try {
    contents = await readFile(filePath, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }

  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch (error) {
    throw new StandardSchemaContractError(
      "比较基线文件",
      "invalid-json",
      `比较基线文件不是有效 JSON：${filePath}`,
      undefined,
      { cause: error },
    );
  }
  validateComparisonBaseline(value);
  return value as unknown as ComparisonBaseline<
    TUnit,
    TTranslation,
    TBody,
    TUnavailable
  >;
}

/** 为 Node.js 宿主创建文件更新计划存储。 */
export function createFileUpdatePlanStore(filePath: string): UpdatePlanStore {
  return {
    async load() {
      let contents: string;
      try {
        contents = await readFile(filePath, "utf8");
      } catch (error) {
        if (isMissingFile(error)) return undefined;
        throw error;
      }

      let value: unknown;
      try {
        value = JSON.parse(contents);
      } catch (error) {
        throw new StandardSchemaContractError(
          "更新计划文件",
          "invalid-json",
          `更新计划文件不是有效 JSON：${filePath}`,
          undefined,
          { cause: error },
        );
      }
      validateUpdatePlan(value);
      return value;
    },

    async save(plan) {
      validateUpdatePlan(plan);
      const serialized = JSON.stringify(plan, null, 2);
      if (serialized === undefined)
        throw new TypeError("更新计划必须可序列化为 JSON。");
      const contents = `${serialized}\n`;
      const roundTripped: unknown = JSON.parse(contents);
      validateUpdatePlan(roundTripped);
      const directory = path.dirname(filePath);
      const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
      let moved = false;
      try {
        await mkdir(directory, { recursive: true });
        await writeFile(temporaryPath, contents, "utf8");
        await rename(temporaryPath, filePath);
        moved = true;
      } finally {
        if (!moved) await unlink(temporaryPath).catch(ignoreMissingFile);
      }
    },
  };
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function ignoreMissingFile(error: NodeJS.ErrnoException): void {
  if (error.code !== "ENOENT") throw error;
}
