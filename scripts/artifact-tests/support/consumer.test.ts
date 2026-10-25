import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { runSubprocess } from "./consumer.ts";

void test("超时会终止子进程，随后仍能运行新进程", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lioni-artifact-process-"));
  try {
    const expired = await runSubprocess(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { cwd: root, timeoutMs: 40 },
    );
    assert.equal(expired.timedOut, true);
    assert.ok(expired.signal !== null || expired.status !== 0);

    const recovered = await runSubprocess(
      process.execPath,
      ["-e", "process.stdout.write('ready')"],
      { cwd: root, timeoutMs: 1_000 },
    );
    assert.equal(recovered.timedOut, false);
    assert.equal(recovered.status, 0);
    assert.equal(recovered.stdout, "ready");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
