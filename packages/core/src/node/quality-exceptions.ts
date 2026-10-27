import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { isMap, isScalar, isSeq, parseDocument } from "yaml";

import {
  QualityExceptionFormatError,
  validateQualityException,
  validateQualityExceptionFile,
} from "../quality/quality-exceptions.ts";
import type {
  QualityException,
  QualityExceptionFile,
  QualityExceptionStore,
} from "../quality/quality-exceptions.ts";

const EMPTY_QUALITY_EXCEPTION_FILE =
  "format: lioni.qa-exceptions/v1\nexceptions: []\n";

/** 为指定路径创建可手工维护的 YAML 例外存储。 */
export function createFileQualityExceptionStore(
  filePath: string,
): QualityExceptionStore {
  const resolvedFilePath = path.resolve(filePath);
  return {
    async load() {
      const parsed = await readQualityExceptionFile(resolvedFilePath);
      return parsed?.value.exceptions ?? [];
    },

    async upsert(exception) {
      validateQualityException(exception);
      const parsed = await readQualityExceptionFile(resolvedFilePath);
      const current = parsed?.value.exceptions ?? [];
      const idIndex = current.findIndex(({ id }) => id === exception.id);
      const next = [...current];
      if (idIndex === -1) next.push(exception);
      else next[idIndex] = exception;

      const nextValue: QualityExceptionFile = {
        format: "lioni.qa-exceptions/v1",
        exceptions: next,
      };
      validateQualityExceptionFile(nextValue);
      const existing = idIndex === -1 ? undefined : current[idIndex];
      if (existing !== undefined && sameException(existing, exception)) return;

      const document = parsed?.document ?? parseEmptyQualityExceptionFile();
      const exceptionSequence = document.get("exceptions", true);
      if (!isSeq(exceptionSequence))
        throw invalidFile(resolvedFilePath, "exceptions 必须是 YAML 序列。");

      if (idIndex === -1) {
        exceptionSequence.add(document.createNode(exception));
      } else {
        const exceptionNode = exceptionSequence.items[idIndex];
        if (!isMap(exceptionNode))
          throw invalidFile(resolvedFilePath, "例外记录必须是 YAML 映射。");
        setString(exceptionNode, "reason", exception.reason);
        setString(exceptionNode, "checkId", exception.checkId);
        setString(exceptionNode, "sourceKey", exception.sourceKey);
        setString(exceptionNode, "language", exception.language);
        setString(
          exceptionNode,
          "inputFingerprint",
          exception.inputFingerprint,
        );
        const summaryNode = exceptionNode.get("fingerprintSummary", true);
        if (isMap(summaryNode)) {
          setString(
            summaryNode,
            "version",
            exception.fingerprintSummary.version,
          );
          setString(
            summaryNode,
            "configurationFingerprint",
            exception.fingerprintSummary.configurationFingerprint,
          );
          setString(
            summaryNode,
            "inputFingerprint",
            exception.fingerprintSummary.inputFingerprint,
          );
        } else {
          exceptionNode.set(
            "fingerprintSummary",
            document.createNode(exception.fingerprintSummary),
          );
        }
      }

      const serializedValue: unknown = document.toJS({ maxAliasCount: 100 });
      validateQualityExceptionFile(serializedValue);
      await writeQualityExceptionDocument(
        resolvedFilePath,
        document.toString(),
      );
    },
  };
}

/** 将 Node 配置文件路径解析为同目录下的默认例外文件路径。 */
export function resolveDefaultQualityExceptionFilePath(
  configPath: string,
): string {
  const absoluteConfigPath = path.resolve(process.cwd(), configPath);
  return path.join(path.dirname(absoluteConfigPath), "lioni.exceptions.yaml");
}

/** 根据 Node 配置文件位置创建默认 YAML 例外存储。 */
export function createDefaultQualityExceptionStore(
  configPath: string,
): QualityExceptionStore {
  return createFileQualityExceptionStore(
    resolveDefaultQualityExceptionFilePath(configPath),
  );
}

async function readQualityExceptionFile(filePath: string): Promise<
  | {
      readonly document: ReturnType<typeof parseDocument>;
      readonly value: QualityExceptionFile;
    }
  | undefined
> {
  let contents: string;
  try {
    contents = await readFile(filePath, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }

  const document = parseDocument(contents, {
    uniqueKeys: true,
    version: "1.2",
    schema: "core",
  });
  if (document.errors.length > 0)
    throw new QualityExceptionFormatError(
      "invalid",
      `QA 例外文件不是有效 YAML：${filePath}。${document.errors[0]?.message ?? ""}`,
      { cause: document.errors[0] },
    );
  const value: unknown = document.toJS({ maxAliasCount: 100 });
  validateQualityExceptionFile(value);
  return { document, value };
}

function parseEmptyQualityExceptionFile(): ReturnType<typeof parseDocument> {
  return parseDocument(EMPTY_QUALITY_EXCEPTION_FILE, {
    uniqueKeys: true,
    version: "1.2",
    schema: "core",
  });
}

function setString(
  mapping: NonNullable<ReturnType<typeof parseDocument>["contents"]>,
  key: string,
  value: string,
): void {
  if (!isMap(mapping)) return;
  const current = mapping.get(key, true);
  if (isScalar(current)) current.value = value;
  else mapping.set(key, value);
}

function sameException(
  current: QualityException,
  next: QualityException,
): boolean {
  return (
    current.id === next.id &&
    current.reason === next.reason &&
    current.checkId === next.checkId &&
    current.sourceKey === next.sourceKey &&
    current.language === next.language &&
    current.inputFingerprint === next.inputFingerprint &&
    current.fingerprintSummary.version === next.fingerprintSummary.version &&
    current.fingerprintSummary.configurationFingerprint ===
      next.fingerprintSummary.configurationFingerprint &&
    current.fingerprintSummary.inputFingerprint ===
      next.fingerprintSummary.inputFingerprint
  );
}

async function writeQualityExceptionDocument(
  filePath: string,
  contents: string,
): Promise<void> {
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
}

function invalidFile(
  filePath: string,
  message: string,
): QualityExceptionFormatError {
  return new QualityExceptionFormatError(
    "invalid",
    `QA 例外文件格式无效：${filePath}。${message}`,
  );
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
