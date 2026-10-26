import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { readFacts, defineConfig } from "@lioni/core";

import { createKumaAdapter, loadKumaCatalog } from "../adapter.ts";

void test("每次读取当前源译资源且无需 QA 术语与 usage 文件", async () => {
  const rootDirectory = await mkdtemp(path.join(tmpdir(), "kuma-facts-"));
  const root = pathToFileURL(rootDirectory + path.sep);
  const writeJson = (name: string, value: unknown) =>
    writeFile(new URL(name, root), JSON.stringify(value));
  try {
    await mkdir(new URL("src/lang/lioni/", root), { recursive: true });
    await writeJson("src/lang/en.json", { label: "monitor" });
    await writeJson("src/lang/ja.json", { label: "表示器" });
    await writeJson("src/lang/lioni/catalog.json", {
      source: "en",
      targets: ["ja"],
    });
    await symlink("missing-usage-target.ts", new URL("src/broken.ts", root));

    const catalog = await loadKumaCatalog(
      new URL("src/lang/lioni/catalog.json", root),
    );
    const config = defineConfig(createKumaAdapter({ root, catalog }));
    const before = await readFacts(config);
    assert.deepEqual(before.translations.records[0]?.identity, {
      language: "ja",
      namespace: "src/lang/ja.json",
      key: "label",
    });
    assert.equal(before.translations.records[0]?.content?.text, "表示器");

    await writeJson("src/lang/ja.json", { label: "モニター" });
    const after = await readFacts(config);
    assert.equal(after.translations.records[0]?.content?.text, "モニター");
  } finally {
    await rm(rootDirectory, { recursive: true, force: true });
  }
});
