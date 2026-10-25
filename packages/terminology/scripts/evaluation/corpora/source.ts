import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { sha256 } from "../support/json.ts";
import type { ExternalSourceManifest } from "./manifest.ts";

const execFileAsync = promisify(execFile);

export type VerifiedSource = {
  readonly id: "cfpa" | "kuma";
  readonly root: string;
  readonly repository: string;
  readonly commit: string;
  readonly tag?: string;
  readonly converterVersion: string;
  readonly files: readonly {
    readonly path: string;
    readonly sha256: string;
  }[];
  readonly license: ExternalSourceManifest["license"];
};

export async function assertFileHash(
  filename: string,
  expectedSha256: string,
  sourcePath = filename,
): Promise<string> {
  const actual = sha256(await readFile(filename));
  if (actual !== expectedSha256)
    throw new Error(
      `语料原始文件散列不符：${sourcePath}，期望 ${expectedSha256}，实际 ${actual}。`,
    );
  return actual;
}

async function gitOutput(
  root: string,
  args: readonly string[],
): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", root, ...args], {
      encoding: "utf8",
    });
    return stdout.trim();
  } catch (error) {
    throw new Error(`外部语料需要可核验的 Git 副本：${root}。`, {
      cause: error,
    });
  }
}

export async function verifySourceRoot(
  manifest: ExternalSourceManifest,
  rootValue: string,
): Promise<VerifiedSource> {
  const root = path.resolve(rootValue);
  try {
    if (!(await stat(root)).isDirectory()) throw new Error(`不是目录：${root}`);
  } catch (error) {
    throw new Error(`外部语料目录不存在：${root}。`, { cause: error });
  }

  const commit = await gitOutput(root, ["rev-parse", "HEAD"]);
  if (commit !== manifest.commit)
    throw new Error(
      `${manifest.id} 语料提交不符：期望 ${manifest.commit}，实际 ${commit}。`,
    );
  const dirty = await gitOutput(root, [
    "status",
    "--porcelain",
    "--untracked-files=all",
  ]);
  if (dirty)
    throw new Error(`${manifest.id} 固定语料副本有未提交改动：${dirty}`);
  if (manifest.tag !== undefined) {
    const tag = await gitOutput(root, [
      "describe",
      "--tags",
      "--exact-match",
      "HEAD",
    ]);
    if (tag !== manifest.tag)
      throw new Error(
        `${manifest.id} 语料标签不符：期望 ${manifest.tag}，实际 ${tag}。`,
      );
  }

  const files = [];
  for (const sourceFile of manifest.files) {
    const filename = path.join(root, sourceFile.path);
    const actual = await assertFileHash(
      filename,
      sourceFile.sha256,
      sourceFile.path,
    );
    files.push(Object.freeze({ path: sourceFile.path, sha256: actual }));
  }

  return Object.freeze({
    id: manifest.id,
    root,
    repository: manifest.repository,
    commit,
    ...(manifest.tag === undefined ? {} : { tag: manifest.tag }),
    converterVersion: manifest.converterVersion,
    files: Object.freeze(files),
    license: manifest.license,
  });
}
