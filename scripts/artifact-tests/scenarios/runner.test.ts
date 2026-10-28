import assert from "node:assert/strict";
import { test } from "node:test";

import { runCommand, runSubprocess } from "../support/process.ts";

void test("子进程保留环境并清除 Node 测试上下文", async () => {
  const environment = {
    ...process.env,
    NODE_TEST_CONTEXT: "child-v8",
    PROBE: "kept",
  };
  const result = await runCommand(
    process.execPath,
    [
      "-e",
      "console.log(JSON.stringify({ context: process.env.NODE_TEST_CONTEXT, probe: process.env.PROBE }))",
    ],
    { cwd: process.cwd(), env: environment },
  );
  assert.deepEqual(JSON.parse(result.stdout), { probe: "kept" });
  assert.equal(environment.NODE_TEST_CONTEXT, "child-v8");
});

void test("非零退出保留命令错误输出", async () => {
  await assert.rejects(
    runCommand(
      process.execPath,
      ["-e", "console.error('expected failure'); process.exitCode = 7"],
      { cwd: process.cwd() },
    ),
    /退出码 7[\s\S]*expected failure/u,
  );
});

void test("超时会终止忽略 SIGTERM 的子进程", { timeout: 5_000 }, async () => {
  const result = await runSubprocess(
    process.execPath,
    ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
    { cwd: process.cwd(), timeoutMs: 300, terminationGraceMs: 100 },
  );
  assert.equal(result.timedOut, true);
  assert.notEqual(result.status, 0);
});
