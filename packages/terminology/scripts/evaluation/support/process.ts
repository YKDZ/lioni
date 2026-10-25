import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";

export type ProcessStatus = "passed" | "failed" | "timed-out" | "interrupted";

export type ProcessResult = {
  readonly status: ProcessStatus;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly durationMs: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: string;
};

export type ProcessOptions = {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
};

const evidenceLimit = 16_000;

function boundedEvidence(value: string): string {
  if (value.length <= evidenceLimit) return value;
  return `${value.slice(0, evidenceLimit)}\n…（输出已截断）`;
}

function terminate(child: ReturnType<typeof spawn>): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === "win32") child.kill("SIGTERM");
    else process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      // 进程可能恰好在检查状态和发送信号之间退出。
    }
  }
  const forceTimer = setTimeout(() => {
    try {
      if (process.platform === "win32") child.kill("SIGKILL");
      else process.kill(-child.pid!, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        // 子进程已经退出。
      }
    }
  }, 100);
  forceTimer.unref();
}

/** 隔离运行一个进程，并把超时或中断记录为失败。 */
export function runProcess(options: ProcessOptions): Promise<ProcessResult> {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1)
    throw new RangeError("进程超时必须是正整数毫秒。");

  return new Promise((resolve) => {
    const started = performance.now();
    let stdout = "";
    let stderr = "";
    let reason: "timed-out" | "interrupted" | undefined;
    let settled = false;
    let timedOut = false;
    let interrupted = false;

    const child = spawn(options.command, [...(options.args ?? [])], {
      cwd: options.cwd,
      env: options.env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timeout = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      reason = "timed-out";
      terminate(child);
    }, options.timeoutMs);
    timeout.unref();

    const onAbort = () => {
      if (settled) return;
      interrupted = true;
      reason = "interrupted";
      terminate(child);
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout = `${stdout}${chunk}`.slice(-evidenceLimit * 2);
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-evidenceLimit * 2);
    });

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
      resolve(
        Object.freeze({
          status: reason ?? "failed",
          code: null,
          signal: null,
          durationMs: performance.now() - started,
          stdout: boundedEvidence(stdout),
          stderr: boundedEvidence(stderr),
          error: error.message,
        }),
      );
    });

    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
      const status: ProcessStatus =
        reason ?? (code === 0 ? "passed" : "failed");
      resolve(
        Object.freeze({
          status,
          code,
          signal,
          durationMs: performance.now() - started,
          stdout: boundedEvidence(stdout),
          stderr: boundedEvidence(stderr),
          ...(timedOut
            ? { error: `进程超过 ${options.timeoutMs} ms 限时。` }
            : {}),
          ...(interrupted ? { error: "进程被运行者中断。" } : {}),
        }),
      );
    });
  });
}
