import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { testFullConsumer } from "./full-consumer.ts";

testFullConsumer(
  "跨进程恢复与真实文件权限失败",
  async ({ root, runNode, typecheck }) => {
    await typecheck();
    const resources = path.join(root, "resume-resources");
    const translations = path.join(resources, "fr");
    const baselineDirectory = path.join(root, ".lioni");
    await Promise.all([
      mkdir(translations, { recursive: true }),
      mkdir(baselineDirectory, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(
        path.join(resources, "source.json"),
        JSON.stringify([
          { id: "A", source: "原文 A 旧版" },
          { id: "B", source: "原文 B 旧版" },
          { id: "C", source: "原文 C 旧版" },
        ]),
      ),
      writeFile(
        path.join(translations, "A.json"),
        JSON.stringify({ sourceId: "A", text: "译文 A" }),
      ),
      writeFile(
        path.join(translations, "B.json"),
        JSON.stringify({ sourceId: "B", text: "译文 B" }),
      ),
      writeFile(
        path.join(translations, "C.json"),
        JSON.stringify({ sourceId: "C", text: "译文 C" }),
      ),
    ]);
    await runNode("resume-host.ts", ["initialize"]);

    await writeFile(
      path.join(resources, "source.json"),
      JSON.stringify([
        { id: "A", source: "原文 A 新版" },
        { id: "B", source: "原文 B 新版" },
        { id: "C", source: "原文 C 新版" },
      ]),
    );
    await runNode("resume-host.ts", ["save-plan"]);

    const failedTarget = path.join(translations, "B.json");
    await chmod(failedTarget, 0o444);
    try {
      await runNode("resume-host.ts", ["partial"]);
    } finally {
      await chmod(failedTarget, 0o644);
    }

    await runNode("resume-host.ts", ["resume-write"]);
    await chmod(baselineDirectory, 0o555);
    try {
      await runNode("resume-host.ts", ["baseline-failure"]);
    } finally {
      await chmod(baselineDirectory, 0o755);
    }

    await runNode("resume-host.ts", ["stale-old-plan"]);
    await runNode("resume-host.ts", ["replan-retain"]);
    await runNode("resume-host.ts", ["verify"]);
  },
);
