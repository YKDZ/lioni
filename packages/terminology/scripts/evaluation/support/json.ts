import { createHash } from "node:crypto";
import { rename, writeFile } from "node:fs/promises";
import path from "node:path";

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined)
      throw new TypeError("评估输入必须是可序列化 JSON。");
    return encoded;
  }
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function writeJsonAtomic(
  filename: string,
  value: unknown,
): Promise<void> {
  const temporary = `${filename}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, filename);
}

export function resolvePath(base: string, value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(base, value);
}
