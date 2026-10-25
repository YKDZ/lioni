import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { testFullConsumer } from "./full-consumer.ts";

testFullConsumer(
  "更新计划保存、跨进程读取与过期输入拒绝",
  async ({ root, runNode, typecheck }) => {
    await typecheck();
    await runNode("update-plan-host.ts", ["establish"]);

    const sourcePath = path.join(root, "update-plan-resources", "source.json");
    const sources = JSON.parse(await readFile(sourcePath, "utf8")) as Array<{
      context: { screenshot: string };
    }>;
    const saveSource = sources[0];
    if (saveSource === undefined) throw new Error("缺少计划场景原文。");
    saveSource.context.screenshot = "shots/save-updated.png";
    await writeFile(sourcePath, JSON.stringify(sources), "utf8");
    await runNode("update-plan-host.ts", ["save"]);

    saveSource.context.screenshot = "shots/after-plan.png";
    await writeFile(sourcePath, JSON.stringify(sources), "utf8");
    const targetPath = path.join(root, "update-plan-resources", "fr.json");
    const targets = JSON.parse(await readFile(targetPath, "utf8")) as Array<{
      text: string;
    }>;
    const saveTarget = targets[0];
    if (saveTarget === undefined) throw new Error("缺少计划场景译文。");
    saveTarget.text = "Sauvegarder";
    await writeFile(targetPath, JSON.stringify(targets), "utf8");

    await runNode("update-plan-host.ts", ["read"]);
    await runNode("update-plan-host.ts", ["stale-apply"]);
    await runNode("update-plan-host.ts", ["refresh"]);
    await runNode("update-plan-host.ts", ["apply"]);
    await runNode("update-plan-host.ts", ["verify"]);
    await runNode("update-plan-host.ts", ["corrupt-plan"]);
    await runNode("update-plan-host.ts", ["reject-plan"]);
  },
);
