import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { testFullConsumer } from "./full-consumer.ts";

testFullConsumer(
  "跨进程恢复与真实文件 I/O 失败",
  async ({ root, runNode, typecheck }) => {
    await typecheck();
    const resources = path.join(root, "resume-resources");
    const translations = path.join(resources, "fr");
    const blockedTarget = path.join(translations, "blocked-target");
    await Promise.all([
      mkdir(translations, { recursive: true }),
      mkdir(blockedTarget, { recursive: true }),
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
        JSON.stringify({
          targetId: "target-A",
          sourceId: "A",
          text: "译文 A",
        }),
      ),
      writeFile(
        path.join(translations, "B.json"),
        JSON.stringify({
          targetId: "target-B",
          sourceId: "B",
          text: "译文 B",
        }),
      ),
      writeFile(
        path.join(translations, "C.json"),
        JSON.stringify({
          targetId: "target-C",
          sourceId: "C",
          text: "译文 C",
        }),
      ),
    ]);
    const bTargetPath = path.join(translations, "B.json");
    const bTarget = JSON.parse(await readFile(bTargetPath, "utf8")) as Record<
      string,
      unknown
    >;
    bTarget.writePath = blockedTarget;
    await writeFile(bTargetPath, JSON.stringify(bTarget) + "\n", "utf8");
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

    await runNode("resume-host.ts", ["partial"]);
    delete bTarget.writePath;
    await writeFile(bTargetPath, JSON.stringify(bTarget) + "\n", "utf8");
    await runNode("resume-host.ts", ["stale-old-plan"]);
    await runNode("resume-host.ts", ["replan-retain"]);
    await runNode("resume-host.ts", ["resume-write"]);
    await runNode("resume-host.ts", ["verify"]);
  },
);
