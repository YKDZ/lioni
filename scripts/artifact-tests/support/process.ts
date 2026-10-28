import assert from "node:assert/strict";
import { spawn } from "node:child_process";

export type ProcessResult = {
  readonly command: string;
  readonly args: readonly string[];
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly interrupted: boolean;
  readonly error: string | undefined;
  readonly durationMs: number;
};

export type ProcessOptions = {
  readonly cwd: string;
  readonly timeoutMs?: number;
  readonly terminationGraceMs?: number;
  readonly interruptSignal?: NodeJS.Signals;
  readonly env?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly shell?: boolean;
  readonly onStdout?: (chunk: Buffer) => void;
  readonly onStderr?: (chunk: Buffer) => void;
};

const defaultProcessTimeoutMs = 10 * 60 * 1000;
const defaultTerminationGraceMs = 1_500;
const maxOutputBytes = 32 * 1024 * 1024;

type CapturedOutput = { readonly chunks: Buffer[]; bytes: number };

function retainOutput(current: CapturedOutput, chunk: Buffer): void {
  const available = Math.max(0, maxOutputBytes - current.bytes);
  if (available === 0) return;
  const retained = chunk.subarray(0, available);
  current.chunks.push(retained);
  current.bytes += retained.byteLength;
}

function decodeOutput(value: CapturedOutput): string {
  return Buffer.concat(value.chunks, value.bytes).toString("utf8");
}

function signalProcessTree(
  child: ReturnType<typeof spawn>,
  signal: NodeJS.Signals,
): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform !== "win32") process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // 子进程已经退出。
    }
  }
}

/** 在给定时限内运行外部命令，并以结果形式返回超时或中断状态。 */
export function runSubprocess(
  command: string,
  args: readonly string[],
  options: ProcessOptions,
): Promise<ProcessResult> {
  const timeoutMs = options.timeoutMs ?? defaultProcessTimeoutMs;
  const terminationGraceMs =
    options.terminationGraceMs ?? defaultTerminationGraceMs;
  assert.ok(
    Number.isFinite(timeoutMs) && timeoutMs > 0,
    "子进程超时必须为正数。",
  );
  const environment = { ...(options.env ?? process.env) };
  delete environment.NODE_TEST_CONTEXT;
  const startedAt = Date.now();

  return new Promise((resolveResult) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: environment,
      detached: process.platform !== "win32",
      shell: options.shell ?? false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: CapturedOutput = { chunks: [], bytes: 0 };
    const stderr: CapturedOutput = { chunks: [], bytes: 0 };
    let timedOut = false;
    let interrupted = false;
    let settled = false;
    let terminationScheduled = false;
    let timeout: NodeJS.Timeout | undefined;
    let forceKill: NodeJS.Timeout | undefined;

    const settle = (result: Omit<ProcessResult, "durationMs">): void => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      if (forceKill !== undefined && !timedOut && !interrupted)
        clearTimeout(forceKill);
      options.signal?.removeEventListener("abort", abort);
      resolveResult({ ...result, durationMs: Date.now() - startedAt });
    };

    const terminate = (signal: NodeJS.Signals): void => {
      signalProcessTree(child, signal);
      if (!terminationScheduled) {
        terminationScheduled = true;
        forceKill = setTimeout(() => {
          signalProcessTree(child, "SIGKILL");
          forceKill = undefined;
        }, terminationGraceMs);
      }
    };
    const abort = (): void => {
      interrupted = true;
      terminate(options.interruptSignal ?? "SIGTERM");
    };

    child.stdout.on("data", (chunk: Buffer) => {
      retainOutput(stdout, chunk);
      options.onStdout?.(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      retainOutput(stderr, chunk);
      options.onStderr?.(chunk);
    });
    child.once("error", (error) => {
      settle({
        command,
        args,
        status: null,
        signal: null,
        stdout: decodeOutput(stdout),
        stderr: decodeOutput(stderr),
        timedOut,
        interrupted,
        error: error.message,
      });
    });
    child.once("close", (status, signal) => {
      settle({
        command,
        args,
        status,
        signal,
        stdout: decodeOutput(stdout),
        stderr: decodeOutput(stderr),
        timedOut,
        interrupted,
        error: undefined,
      });
    });
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });
    timeout = setTimeout(() => {
      timedOut = true;
      terminate("SIGTERM");
    }, timeoutMs);
  });
}

function commandFailure(label: string, result: ProcessResult): Error {
  const reason = result.interrupted
    ? `执行被中断${result.signal === null ? "" : `，结束信号 ${result.signal}`}`
    : result.timedOut
      ? `超时（${result.durationMs}ms）`
      : result.error !== undefined
        ? `无法启动：${result.error}`
        : `退出码 ${String(result.status)}${result.signal === null ? "" : `，信号 ${result.signal}`}`;
  return new Error(`${label}失败：${reason}\n${result.stdout}${result.stderr}`);
}

/** 非零退出、启动失败、超时和中断均使调用失败，并保留命令输出供定位。 */
export async function runCommand(
  command: string,
  args: readonly string[],
  options: ProcessOptions,
): Promise<ProcessResult> {
  const result = await runSubprocess(command, args, options);
  if (
    result.status !== 0 ||
    result.timedOut ||
    result.interrupted ||
    result.error !== undefined
  )
    throw commandFailure(command, result);
  return result;
}
