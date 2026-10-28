import { execFile } from "node:child_process";
import { mkdir, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { writeJsonAtomic } from "./json.ts";

const execFileAsync = promisify(execFile);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
export const packageRoot = path.resolve(scriptDirectory, "../../..");

function isLocalContextFile(filename: string): boolean {
  return (
    filename === "AGENTS.md" ||
    filename === ".codex" ||
    filename === ".agents" ||
    filename === ".scratch" ||
    filename === "docs" ||
    filename === "GLOSSARY.md" ||
    filename === "GLOSSARY-MAP.md" ||
    filename.startsWith("GLOSSARY-")
  );
}

async function gitOutput(args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", [...args], {
    cwd: packageRoot,
    encoding: "utf8",
  });
  return stdout.trimEnd();
}

export async function collectSourceIdentity() {
  const commit = await gitOutput(["rev-parse", "HEAD"]);
  const status = await gitOutput([
    "status",
    "--porcelain",
    "--untracked-files=all",
  ]);
  const changedFiles = status
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3))
    .filter((filename) => !isLocalContextFile(filename))
    .sort();
  return Object.freeze({
    commit,
    dirty: changedFiles.length > 0,
    changedFiles: Object.freeze(changedFiles),
  });
}

export function collectEnvironment() {
  const cpu = os.cpus()[0];
  return Object.freeze({
    node: process.version,
    icu: process.versions.icu ?? null,
    unicode: process.versions.unicode ?? null,
    platform: process.platform,
    arch: process.arch,
    cpuModel: cpu?.model ?? null,
    cpuCount: os.availableParallelism(),
  });
}

/** 写入本设施的机器报告和简短摘要，替换过程不留下半份目标文件。 */
export async function writeEvaluationReport(
  directory: string,
  report: unknown,
  summary: string,
): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeJsonAtomic(path.join(directory, "report.json"), report);
  const temporary = path.join(directory, "summary.md.tmp");
  await writeFile(temporary, summary, "utf8");
  await rename(temporary, path.join(directory, "summary.md"));
}
