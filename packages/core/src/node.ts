import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  validateProcessingBaseline,
  type ProcessingBaseline,
  type ProcessingBaselineStore,
} from "./baselines.ts";

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
        value = JSON.parse(contents) as unknown;
      } catch (error) {
        throw new TypeError(`处理基线文件不是有效 JSON：${filePath}`, {
          cause: error,
        });
      }
      validateProcessingBaseline(value as ProcessingBaseline);
      return value as ProcessingBaseline;
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
