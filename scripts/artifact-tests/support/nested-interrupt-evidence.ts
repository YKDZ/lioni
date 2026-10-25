import assert from "node:assert/strict";
import path from "node:path";

import { testArtifactConsumer } from "./consumer.ts";

const mode = process.env.LIONI_ABORT_PROBE_MODE;
assert.ok(mode === "cooperative" || mode === "ignore");
const pidFile = process.env.LIONI_ABORT_PROBE_PID_FILE;
assert.ok(pidFile);

testArtifactConsumer(
  {
    name: `设施验收：外层中断回收嵌套消费者 ${mode}`,
    packages: [],
  },
  async ({ root, runCommand }) => {
    const processIdFile = JSON.stringify(pidFile);
    const signalFile = JSON.stringify(path.join(root, "sigterm"));
    const signalAction =
      mode === "cooperative"
        ? `fs.writeFileSync(${signalFile}, "stopped"); process.exit(0);`
        : `fs.writeFileSync(${signalFile}, "ignored");`;
    const source = [
      'const fs = require("node:fs");',
      `fs.writeFileSync(${processIdFile}, String(process.pid));`,
      `process.on("SIGTERM", () => { ${signalAction} });`,
      "setInterval(() => {}, 1000);",
    ].join("\n");
    await runCommand(process.execPath, ["-e", source], 30_000);
  },
);
