import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  validateProcessingBaseline,
  type ProcessingBaselineStore,
} from "./baselines.ts";
import {
  validateFrameworkConfig,
  type FrameworkConfig,
  type TranslationUnitInput,
} from "./index.ts";
import { validateUpdatePlan, type UpdatePlanStore } from "./plans.ts";
import { StandardSchemaContractError } from "./standard-schema.ts";

/** 从 Node.js 配置模块加载并验证默认导出的宿主配置。 */
export async function loadConfig<
  TUnit extends TranslationUnitInput = TranslationUnitInput,
  TTranslation = unknown,
>(configPath: string): Promise<FrameworkConfig<TUnit, TTranslation>> {
  const configUrl = pathToFileURL(path.resolve(process.cwd(), configPath));
  const configModule = (await import(configUrl.href)) as {
    readonly default?: unknown;
  };
  if (configModule.default === undefined)
    throw new TypeError("宿主配置必须默认导出 defineConfig(...) 的结果。");
  validateFrameworkConfig(configModule.default);
  return configModule.default as unknown as FrameworkConfig<
    TUnit,
    TTranslation
  >;
}

/** 为 Node.js 宿主创建文件处理基线存储。 */
export function createFileProcessingBaselineStore(
  filePath: string,
): ProcessingBaselineStore {
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
          "处理基线文件",
          "invalid-json",
          `处理基线文件不是有效 JSON：${filePath}`,
          undefined,
          { cause: error },
        );
      }
      validateProcessingBaseline(value);
      return value;
    },

    async save(baseline) {
      validateProcessingBaseline(baseline);
      const contents = `${JSON.stringify(baseline, null, 2)}\n`;
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
