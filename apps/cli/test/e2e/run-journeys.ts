import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type {
  CliJourney,
  CliJourneyCommand,
  CliJourneyMode,
  CliJourneyResult,
} from "./journey.ts";

const e2eRoot = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(e2eRoot, "..", "..");
const coreDependency = path.join(packageRoot, "node_modules", "@lioni", "core");

function assertNever(value: never): never {
  throw new Error(`unsupported journey mode: ${String(value)}`);
}

const journeyRunnerUsage = [
  "Usage:",
  "  run-journeys.ts <source|distribution> [source|distribution ...]",
].join("\n");

function invalidArguments(message: string): never {
  throw new Error(`${message}\n${journeyRunnerUsage}`);
}

function parseJourneyRunTargets(
  args: readonly string[],
): readonly CliJourneyMode[] {
  const first = args[0];
  if (first === undefined) {
    invalidArguments("missing journey mode");
  }

  const seen = new Set<CliJourneyMode>();
  const targets: CliJourneyMode[] = [];
  for (const argument of args) {
    switch (argument) {
      case "source":
      case "distribution":
        if (seen.has(argument)) {
          invalidArguments(
            `duplicate journey mode ${JSON.stringify(argument)}; each mode may be specified once`,
          );
        }
        seen.add(argument);
        targets.push(argument);
        break;
      default:
        invalidArguments(
          `unknown journey mode ${JSON.stringify(argument)}; expected source or distribution`,
        );
    }
  }
  return targets;
}

async function discoverJourneys(): Promise<readonly CliJourney[]> {
  const journeyRoot = path.join(e2eRoot, "journeys");
  const entries = await readdir(journeyRoot, { withFileTypes: true });
  const journeyFiles = entries
    .filter(
      (entry) =>
        entry.isFile() &&
        (entry.name.endsWith(".journey.ts") ||
          entry.name.endsWith(".journey.js")),
    )
    .map((entry) => entry.name)
    .toSorted();
  return await Promise.all(
    journeyFiles.map(async (fileName) => {
      const loaded = (await import(
        pathToFileURL(path.join(journeyRoot, fileName)).href
      )) as { default: CliJourney };
      return loaded.default;
    }),
  );
}

function invocation(mode: CliJourneyMode): {
  readonly executable: string;
  readonly prefix: readonly string[];
} {
  switch (mode) {
    case "source":
      return {
        executable: process.execPath,
        prefix: [
          "--conditions=source",
          path.join(packageRoot, "src", "cli.ts"),
        ],
      };
    case "distribution":
      return {
        executable: process.execPath,
        prefix: [path.join(packageRoot, "dist", "cli.js")],
      };
    default:
      return assertNever(mode);
  }
}

async function runCommand(options: {
  readonly mode: CliJourneyMode;
  readonly command: CliJourneyCommand;
  readonly cwd: string;
}): Promise<CliJourneyResult> {
  const target = invocation(options.mode);
  return await new Promise((resolve, reject) => {
    const child = spawn(
      target.executable,
      [...target.prefix, ...options.command.args],
      {
        cwd: options.cwd,
        env: { ...process.env, ...options.command.env },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (exitCode) => {
      resolve({
        commandName: options.command.name,
        exitCode: exitCode ?? 1,
        stdout,
        stderr,
      });
    });
  });
}

export async function runJourneys(options: {
  readonly mode: CliJourneyMode;
}): Promise<readonly string[]> {
  const passed: string[] = [];
  for (const journey of await discoverJourneys()) {
    if (!journey.modes.includes(options.mode)) continue;
    const workDir = await mkdtemp(
      path.join(tmpdir(), `cli-${journey.name}-${options.mode}-`),
    );
    const context = { mode: options.mode, packageRoot, workDir };
    try {
      const packageLink = path.join(workDir, "node_modules", "@lioni", "core");
      await mkdir(path.dirname(packageLink), { recursive: true });
      await symlink(
        coreDependency,
        packageLink,
        process.platform === "win32" ? "junction" : "dir",
      );
      await journey.setup(context);
      const results: CliJourneyResult[] = [];
      for (const command of journey.commands(context)) {
        results.push(
          await runCommand({
            mode: options.mode,
            command,
            cwd: workDir,
          }),
        );
      }
      await journey.assertions({ context, results });
      passed.push(`${options.mode}:${journey.name}:passed`);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }
  return passed;
}

async function runJourneyTargets(
  targets: readonly CliJourneyMode[],
): Promise<readonly string[]> {
  const passed: string[] = [];
  for (const mode of targets) passed.push(...(await runJourneys({ mode })));
  return passed;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const passed = await runJourneyTargets(
      parseJourneyRunTargets(process.argv.slice(2)),
    );
    process.stdout.write(`${passed.join("\n")}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`error: ${message}\n`);
    process.exitCode = 1;
  }
}
