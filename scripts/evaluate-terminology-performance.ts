import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";

const root = resolve(import.meta.dirname, "..");
const buildArguments = [
  "exec",
  "turbo",
  "run",
  "build",
  "--filter=@lioni/terminology...",
  "--force",
];

type ChildResult = { readonly code: number; readonly signal?: NodeJS.Signals };

function run(command: string, args: readonly string[], env: NodeJS.ProcessEnv) {
  return new Promise<ChildResult>((resolveResult, reject) => {
    const child = spawn(command, [...args], {
      cwd: root,
      detached: process.platform !== "win32",
      env,
      stdio: "inherit",
    });
    const forward = (signal: NodeJS.Signals) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      if (process.platform !== "win32" && child.pid !== undefined) {
        try {
          process.kill(-child.pid, signal);
        } catch {
          child.kill(signal);
        }
      } else child.kill(signal);
    };
    const interrupt = () => forward("SIGINT");
    const terminate = () => forward("SIGTERM");
    const removeSignalHandlers = () => {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", terminate);
    };

    process.on("SIGINT", interrupt);
    process.on("SIGTERM", terminate);
    child.once("error", (error) => {
      removeSignalHandlers();
      reject(error);
    });
    child.once("close", (code, signal) => {
      removeSignalHandlers();
      resolveResult({
        code: code ?? 1,
        ...(signal === null ? {} : { signal }),
      });
    });
  });
}

function commandResult(label: string, result: ChildResult): number {
  if (result.signal !== undefined) {
    process.stderr.write(`${label} 收到 ${result.signal} 并已停止。\n`);
    return result.signal === "SIGINT" ? 130 : 143;
  }
  return result.code;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args[0] === "--") args.shift();
  const started = performance.now();
  const build = await run("pnpm", buildArguments, process.env);
  const buildDurationMs = performance.now() - started;
  const buildStatus = commandResult("根 Turbo 正式构建", build);
  if (buildStatus !== 0) return buildStatus;

  const evaluationEnvironment = {
    ...process.env,
    LIONI_PERFORMANCE_TURBO_BUILD_MS: String(buildDurationMs),
  };
  const evaluation = await run(
    "pnpm",
    ["--filter", "@lioni/terminology", "evaluation:performance", ...args],
    evaluationEnvironment,
  );
  return commandResult("术语性能评估", evaluation);
}

try {
  process.exitCode = await main();
} catch (error) {
  process.stderr.write(
    `无法完成术语性能评估：${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
