import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { runProcess } from "../scripts/evaluation/support/process.ts";

const childSource =
  "process.stdout.write(`child=${process.pid}\\n`); setInterval(() => {}, 1000);";

function longRunningProcess(): readonly string[] {
  const spawnChild =
    process.platform === "win32"
      ? ""
      : `spawn(process.execPath, ["-e", ${JSON.stringify(childSource)}], { stdio: ["ignore", "inherit", "inherit"] });`;
  const source = [
    'const { spawn } = require("node:child_process");',
    spawnChild,
    "process.stdout.write(`parent=${process.pid}\\n`);",
    "setInterval(() => {}, 1000);",
  ].join("\n");
  return ["-e", source];
}

async function assertProcessesExited(stdout: string): Promise<void> {
  const pids = [...stdout.matchAll(/(?:parent|child)=(\d+)/gu)].map(
    ([, value]) => Number(value),
  );
  assert.equal(pids.length, process.platform === "win32" ? 1 : 2);
  for (const pid of pids) {
    let exited = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        process.kill(pid, 0);
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ESRCH"
        ) {
          exited = true;
          break;
        }
        throw error;
      }
      await delay(25);
    }
    assert.ok(exited, `进程 ${pid} 应在执行器返回前退出。`);
  }
}

void test("超时和中断都会回收样本进程及其子进程", async () => {
  const timedOut = await runProcess({
    command: process.execPath,
    args: longRunningProcess(),
    timeoutMs: 500,
  });
  assert.equal(timedOut.status, "timed-out");
  await assertProcessesExited(timedOut.stdout);

  const controller = new AbortController();
  const interruptTimer = setTimeout(() => controller.abort(), 500);
  const interrupted = await runProcess({
    command: process.execPath,
    args: longRunningProcess(),
    timeoutMs: 5_000,
    signal: controller.signal,
  });
  clearTimeout(interruptTimer);
  assert.equal(interrupted.status, "interrupted");
  await assertProcessesExited(interrupted.stdout);
});
