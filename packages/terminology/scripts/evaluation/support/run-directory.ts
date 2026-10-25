import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";

import { writeJsonAtomic } from "./json.ts";
import { packageRoot } from "./report.ts";

const ownerFilename = ".lioni-evaluation-run.json";
const ownedDirectories = ["prepared", "attempts", "scratch"] as const;

export function defaultEvaluationRoot(): string {
  return path.join(
    packageRoot,
    "node_modules",
    ".cache",
    "lioni-terminology-evaluation",
  );
}

export function defaultRunDirectory(runId: string): string {
  return path.join(defaultEvaluationRoot(), "runs", runId);
}

type OwnerRecord = {
  readonly schemaVersion: 1;
  readonly package: "@lioni/terminology";
  readonly runId: string;
};

/** 建立空运行目录，或复用带有本设施标记的目录。 */
export async function initializeRunDirectory(
  directory: string,
  runId: string,
): Promise<void> {
  await mkdir(directory, { recursive: true });
  let existingOwner: OwnerRecord | undefined;
  try {
    existingOwner = JSON.parse(
      await readFile(path.join(directory, ownerFilename), "utf8"),
    ) as OwnerRecord;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw new Error(`评估运行目录标记无法读取：${directory}`, {
        cause: error,
      });
  }

  if (existingOwner === undefined) {
    const entries = await readdir(directory);
    if (entries.length)
      throw new Error(`评估运行目录已有非本设施内容，拒绝覆盖：${directory}`);
  } else if (
    existingOwner.schemaVersion !== 1 ||
    existingOwner.package !== "@lioni/terminology" ||
    typeof existingOwner.runId !== "string"
  ) {
    throw new Error(`评估运行目录标记无效：${directory}`);
  }

  if (existingOwner !== undefined)
    await Promise.all(
      ownedDirectories.map((name) =>
        rm(path.join(directory, name), { recursive: true, force: true }),
      ),
    );

  const owner: OwnerRecord = Object.freeze({
    schemaVersion: 1,
    package: "@lioni/terminology",
    runId,
  });
  await writeJsonAtomic(path.join(directory, ownerFilename), owner);
}

/** 只移除已知临时目录，并保留报告和日志。 */
export async function cleanupRunDirectory(directory: string): Promise<void> {
  const markerPath = path.join(directory, ownerFilename);
  let owner: OwnerRecord;
  try {
    owner = JSON.parse(await readFile(markerPath, "utf8")) as OwnerRecord;
  } catch (error) {
    throw new Error(`无法确认评估运行目录归属：${directory}`, { cause: error });
  }
  if (
    owner.schemaVersion !== 1 ||
    owner.package !== "@lioni/terminology" ||
    typeof owner.runId !== "string"
  )
    throw new Error(`评估运行目录标记无效：${directory}`);

  await Promise.all(
    ownedDirectories.map((name) =>
      rm(path.join(directory, name), { recursive: true, force: true }),
    ),
  );
}
