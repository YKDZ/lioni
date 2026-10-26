import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { analyzeQuality } from "@lioni/core";

import {
  defineConfig,
  loadKumaCatalog,
  loadKumaQaProject,
  createKumaAdapter,
  createKumaAnalysis,
  createTerminologyChecks,
} from "../index.ts";

void test("修改相邻语言声明即可改变术语政策，元数据不会成为翻译候选", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "kuma-declarations-"));
  const root = pathToFileURL(directory + path.sep);
  const write = async (filename: string, data: unknown) =>
    writeFile(new URL(filename, root), JSON.stringify(data));
  try {
    await mkdir(new URL("src/lang/lioni/", root), { recursive: true });
    await mkdir(new URL("src/lang/lioni/termbase/", root), { recursive: true });
    await write("src/lang/en.json", { label: "monitor" });
    await write("src/lang/ja.json", { label: "表示器" });
    await write("src/lang/lioni/catalog.json", {
      source: "en",
      targets: ["ja"],
    });
    await write("src/lang/lioni/messages.json", {
      literals: {},
      scopes: [],
      usageScopes: [],
    });
    await write("src/lang/lioni/en.json", {});
    await write("src/lang/lioni/ja.json", {});
    const writeTermbase = (file: string, value: string) =>
      writeFile(new URL(`src/lang/lioni/termbase/${file}`, root), value);
    await writeTermbase("concepts.yaml", "concepts:\n  monitor: {}\n");
    await writeTermbase(
      "en.yaml",
      "concepts:\n  monitor:\n    expressions:\n      - id: en\n        text: monitor\n        usage: preferred\n",
    );
    const target = (usage: "allowed" | "forbidden") =>
      `concepts:\n  monitor:\n    expressions:\n      - id: ja\n        text: モニター\n        usage: preferred\n      - id: variant\n        text: 表示器\n        usage: ${usage}\n`;
    const run = async () => {
      const files = {
        root,
        catalog: await loadKumaCatalog(
          new URL("src/lang/lioni/catalog.json", root),
        ),
      };
      const project = await loadKumaQaProject(files);
      return analyzeQuality(
        defineConfig({
          ...createKumaAdapter(files),
          qualityChecks: createTerminologyChecks(project, createKumaAnalysis()),
        }),
      );
    };
    await writeTermbase("ja.yaml", target("forbidden"));
    const before = await run();
    assert.equal(before.candidates.length, 1);
    assert.ok(
      before.diagnostics.some((d) => d.object.code === "forbidden-translation"),
    );
    assert.ok(
      before.diagnostics.every(
        (d) =>
          d.location.language === "ja" &&
          d.location.range === "src/lang/ja.json",
      ),
    );
    await writeTermbase("ja.yaml", target("allowed"));
    const after = await run();
    assert.equal(after.status, "complete");
    assert.equal(after.diagnostics.length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
