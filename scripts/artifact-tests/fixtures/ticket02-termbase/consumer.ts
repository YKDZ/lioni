import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { loadTermbaseYaml } from "@lioni/terminology/node";

const directory = await mkdtemp(
  path.join(os.tmpdir(), "lioni-packed-termbase-"),
);
try {
  await writeFile(
    path.join(directory, "concepts.yaml"),
    "concepts:\n  service: {}\n",
  );
  await writeFile(
    path.join(directory, "en.yaml"),
    [
      "concepts:",
      "  service:",
      "    expressions:",
      "      - id: service-en",
      "        text: service",
      "        usage: preferred",
      "",
    ].join("\n"),
  );
  await writeFile(path.join(directory, "zh-CN.yaml"), "");

  const termbase = await loadTermbaseYaml(directory);
  assert.equal(termbase.getExpression("service", "service-en")?.language, "en");
  assert.equal(termbase.getConcept("service")?.languages.length, 1);
  console.log("正式术语制品：Node 子路径可读取 YAML 目录并组装原生资料。");
} finally {
  await rm(directory, { recursive: true, force: true });
}
