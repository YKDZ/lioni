import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { isMap, isScalar, isSeq, parseDocument } from "yaml";

import {
  QaSuppressionFormatError,
  validateQaSuppression,
  validateQaSuppressionFile,
} from "../quality/qa-suppressions.ts";
import type {
  QaSuppression,
  QaSuppressionFile,
  QaSuppressionStore,
} from "../quality/qa-suppressions.ts";

const EMPTY_QA_SUPPRESSION_FILE =
  "format: lioni.qa-suppressions/v1\nsuppressions: []\n";

/** 为指定路径创建可手工维护的 YAML 豁免存储。 */
export function createFileQaSuppressionStore(
  filePath: string,
): QaSuppressionStore {
  const resolvedFilePath = path.resolve(filePath);
  return {
    async load() {
      const parsed = await readQaSuppressionFile(resolvedFilePath);
      return parsed?.value.suppressions ?? [];
    },

    async upsert(suppression) {
      validateQaSuppression(suppression);
      const parsed = await readQaSuppressionFile(resolvedFilePath);
      const current = parsed?.value.suppressions ?? [];
      const idIndex = current.findIndex(({ id }) => id === suppression.id);
      const next = [...current];
      if (idIndex === -1) next.push(suppression);
      else next[idIndex] = suppression;

      const nextValue: QaSuppressionFile = {
        format: "lioni.qa-suppressions/v1",
        suppressions: next,
      };
      validateQaSuppressionFile(nextValue);
      const existing = idIndex === -1 ? undefined : current[idIndex];
      if (existing !== undefined && sameSuppression(existing, suppression))
        return;

      const document = parsed?.document ?? parseEmptyQaSuppressionFile();
      const suppressionSequence = document.get("suppressions", true);
      if (!isSeq(suppressionSequence))
        throw invalidFile(resolvedFilePath, "suppressions 必须是 YAML 序列。");

      if (idIndex === -1) {
        suppressionSequence.add(document.createNode(suppression));
      } else {
        const suppressionNode = suppressionSequence.items[idIndex];
        if (!isMap(suppressionNode))
          throw invalidFile(resolvedFilePath, "豁免记录必须是 YAML 映射。");
        setString(suppressionNode, "reason", suppression.reason);
        setString(suppressionNode, "checkId", suppression.checkId);
        setString(suppressionNode, "sourceKey", suppression.sourceKey);
        setString(suppressionNode, "language", suppression.language);
        setString(
          suppressionNode,
          "inputFingerprint",
          suppression.inputFingerprint,
        );
        const summaryNode = suppressionNode.get("fingerprintSummary", true);
        if (isMap(summaryNode)) {
          setString(
            summaryNode,
            "version",
            suppression.fingerprintSummary.version,
          );
          setString(
            summaryNode,
            "inputFingerprint",
            suppression.fingerprintSummary.inputFingerprint,
          );
        } else {
          suppressionNode.set(
            "fingerprintSummary",
            document.createNode(suppression.fingerprintSummary),
          );
        }
      }

      const serializedValue: unknown = document.toJS({ maxAliasCount: 100 });
      validateQaSuppressionFile(serializedValue);
      await writeQaSuppressionDocument(resolvedFilePath, document.toString());
    },
  };
}

/** 将 Node 配置文件路径解析为同目录下的默认豁免文件路径。 */
export function resolveDefaultQaSuppressionFilePath(
  configPath: string,
): string {
  const absoluteConfigPath = path.resolve(process.cwd(), configPath);
  return path.join(path.dirname(absoluteConfigPath), "lioni.suppressions.yaml");
}

/** 根据 Node 配置文件位置创建默认 YAML 豁免存储。 */
export function createDefaultQaSuppressionStore(
  configPath: string,
): QaSuppressionStore {
  return createFileQaSuppressionStore(
    resolveDefaultQaSuppressionFilePath(configPath),
  );
}

async function readQaSuppressionFile(filePath: string): Promise<
  | {
      readonly document: ReturnType<typeof parseDocument>;
      readonly value: QaSuppressionFile;
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
    throw new QaSuppressionFormatError(
      "invalid",
      `QA 豁免文件不是有效 YAML：${filePath}。${document.errors[0]?.message ?? ""}`,
      { cause: document.errors[0] },
    );
  const value: unknown = document.toJS({ maxAliasCount: 100 });
  validateQaSuppressionFile(value);
  return { document, value };
}

function parseEmptyQaSuppressionFile(): ReturnType<typeof parseDocument> {
  return parseDocument(EMPTY_QA_SUPPRESSION_FILE, {
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

function sameSuppression(current: QaSuppression, next: QaSuppression): boolean {
  return (
    current.id === next.id &&
    current.reason === next.reason &&
    current.checkId === next.checkId &&
    current.sourceKey === next.sourceKey &&
    current.language === next.language &&
    current.inputFingerprint === next.inputFingerprint &&
    current.fingerprintSummary.version === next.fingerprintSummary.version &&
    current.fingerprintSummary.inputFingerprint ===
      next.fingerprintSummary.inputFingerprint
  );
}

async function writeQaSuppressionDocument(
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
): QaSuppressionFormatError {
  return new QaSuppressionFormatError(
    "invalid",
    `QA 豁免文件格式无效：${filePath}。${message}`,
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
