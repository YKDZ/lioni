import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { testFullConsumer } from "./full-consumer.ts";

testFullConsumer(
  "跨进程删除写回与复读",
  async ({ root, runNode, typecheck }) => {
    await typecheck();
    await mkdir(path.join(root, ".lioni"), { recursive: true });
    const resources = path.join(root, "deletion-resources");
    const sourcePath = path.join(resources, "source.json");
    const targetPath = path.join(resources, "fr.json");
    const dependencyPath = path.join(resources, "dependencies.json");
    const originalTarget = await readFile(targetPath);

    await runNode("deletion-host.ts", ["initialize"]);
    await writeFile(sourcePath, "[]\n", "utf8");
    await runNode("deletion-host.ts", ["save-plan"]);
    await runNode("deletion-host.ts", ["read-plan"]);
    await writeFile(dependencyPath, JSON.stringify({ revision: 2 }), "utf8");
    await runNode("deletion-host.ts", ["apply", "stale-dependency"]);
    await writeFile(dependencyPath, JSON.stringify({ revision: 1 }), "utf8");
    await runNode("deletion-host.ts", ["apply", "physical-target-remains"]);
    await writeFile(targetPath, originalTarget);
    await runNode("deletion-host.ts", ["apply"]);
    await runNode("deletion-host.ts", ["verify"]);
  },
);
