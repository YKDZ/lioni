import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import {
  defineConfig,
  writeTranslationRequests,
  type TranslationIdentity,
  type TranslationWriteRequest,
} from "@lioni/core";

import { createKumaAdapter, loadKumaCatalog } from "../adapter.ts";
import type { Body } from "../model.ts";

void test("官方写入契约编辑真实 JSON 并保留目标独有条目", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kuma-json-writer-"));
  const languageRoot = path.join(root, "src", "lang");
  const lioniRoot = path.join(languageRoot, "lioni");
  const sourcePath = path.join(languageRoot, "en.json");
  const targetPath = path.join(languageRoot, "zh-CN.json");
  try {
    await mkdir(lioniRoot, { recursive: true });
    const sourceText =
      '{\n    "Existing": "English",\n    "New source": "New English"\n}\n';
    await writeFile(sourcePath, sourceText);
    await writeFile(
      targetPath,
      '{\n    "Existing": "旧人工译文",\n    "Target only": "保留的历史目标"\n}\n',
    );
    const catalogPath = path.join(lioniRoot, "catalog.json");
    await writeFile(
      catalogPath,
      '{\n    "source": "en",\n    "targets": ["zh-CN"]\n}\n',
    );

    const catalog = await loadKumaCatalog(pathToFileURL(catalogPath));
    const config = defineConfig({
      ...createKumaAdapter({
        root: pathToFileURL(`${root}${path.sep}`),
        catalog,
      }),
    });
    const identity = (key: string): TranslationIdentity => ({
      language: "zh-CN",
      namespace: "src/lang/zh-CN.json",
      key,
    });
    const body = (text: string): Body => ({ text });
    const expectedTarget = (
      key: string,
      text: string,
    ): Extract<
      TranslationWriteRequest<Body, { key: string; source: { text: string } }>,
      { operation: "write" }
    >["expectedTarget"] => ({
      status: "present",
      identity: identity(key),
      content: body(text),
      range: "src/lang/zh-CN.json",
    });
    const requests: TranslationWriteRequest<
      Body,
      { key: string; source: { text: string } }
    >[] = [
      {
        operation: "write",
        target: { sourceKey: "New source", language: "zh-CN" },
        content: body("待译：New English"),
        expectedTarget: { status: "missing" },
      },
      {
        operation: "write",
        target: { identity: identity("Existing") },
        content: body("已人工修订"),
        expectedTarget: expectedTarget("Existing", "旧人工译文"),
      },
      {
        operation: "delete",
        target: { identity: identity("Target only") },
        expectedTarget: expectedTarget("Target only", "保留的历史目标"),
      },
    ];

    const result = await writeTranslationRequests(requests, config);

    assert.deepEqual(
      result.results.map(({ status }) => status),
      ["written", "written", "written"],
    );
    assert.deepEqual(JSON.parse(await readFile(targetPath, "utf8")), {
      Existing: "已人工修订",
      "New source": "待译：New English",
    });
    assert.equal(await readFile(sourcePath, "utf8"), sourceText);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("目标正文变化时报告冲突且不覆盖最新 JSON", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kuma-json-writer-conflict-"));
  const languageRoot = path.join(root, "src", "lang");
  const lioniRoot = path.join(languageRoot, "lioni");
  const targetPath = path.join(languageRoot, "zh-CN.json");
  try {
    await mkdir(lioniRoot, { recursive: true });
    await writeFile(
      path.join(languageRoot, "en.json"),
      '{"Existing":"English","New source":"New English"}\n',
    );
    await writeFile(targetPath, '{"Existing":"较新的人工译文"}\n');
    const catalogPath = path.join(lioniRoot, "catalog.json");
    await writeFile(catalogPath, '{"source":"en","targets":["zh-CN"]}\n');
    const catalog = await loadKumaCatalog(pathToFileURL(catalogPath));
    const config = defineConfig({
      ...createKumaAdapter({
        root: pathToFileURL(`${root}${path.sep}`),
        catalog,
      }),
    });
    const identity: TranslationIdentity = {
      language: "zh-CN",
      namespace: "src/lang/zh-CN.json",
      key: "Existing",
    };
    const staleRequest: TranslationWriteRequest<
      Body,
      { key: string; source: { text: string } }
    > = {
      operation: "write",
      target: { identity },
      content: { text: "过期更新" },
      expectedTarget: {
        status: "present",
        identity,
        content: { text: "旧译文" },
      },
    };
    const independentRequest: TranslationWriteRequest<
      Body,
      { key: string; source: { text: string } }
    > = {
      operation: "write",
      target: { sourceKey: "New source", language: "zh-CN" },
      content: { text: "待译：New English" },
      expectedTarget: { status: "missing" },
    };

    const result = await writeTranslationRequests(
      [staleRequest, independentRequest],
      config,
    );

    assert.deepEqual(
      result.results.map(({ status }) => status),
      ["conflict", "written"],
    );
    assert.deepEqual(JSON.parse(await readFile(targetPath, "utf8")), {
      Existing: "较新的人工译文",
      "New source": "待译：New English",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("单个 JSON 目标写入失败时继续写入独立语言资源", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kuma-json-writer-partial-"));
  const languageRoot = path.join(root, "src", "lang");
  const lioniRoot = path.join(languageRoot, "lioni");
  const japanesePath = path.join(languageRoot, "ja.json");
  const offlineJapanesePath = `${japanesePath}.temporarily-offline`;
  const chinesePath = path.join(languageRoot, "zh-CN.json");
  try {
    await mkdir(lioniRoot, { recursive: true });
    await writeFile(
      path.join(languageRoot, "en.json"),
      '{"Japanese source":"English","Chinese source":"Another English","New Japanese source":"New English","New Chinese source":"New English"}\n',
    );
    const japaneseText = '{"Japanese source":"既存译文"}\n';
    const chineseText = '{"Chinese source":"已有翻译"}\n';
    await writeFile(japanesePath, japaneseText);
    await writeFile(chinesePath, chineseText);
    const catalogPath = path.join(lioniRoot, "catalog.json");
    await writeFile(catalogPath, '{"source":"en","targets":["ja","zh-CN"]}\n');
    const catalog = await loadKumaCatalog(pathToFileURL(catalogPath));
    const config = defineConfig({
      ...createKumaAdapter({
        root: pathToFileURL(`${root}${path.sep}`),
        catalog,
      }),
    });
    const requests: TranslationWriteRequest<
      Body,
      { key: string; source: { text: string } }
    >[] = [
      {
        operation: "write",
        target: { sourceKey: "New Japanese source", language: "ja" },
        content: { text: "待译：English" },
        expectedTarget: { status: "missing" },
      },
      {
        operation: "write",
        target: { sourceKey: "New Chinese source", language: "zh-CN" },
        content: { text: "待译：Another English" },
        expectedTarget: { status: "missing" },
      },
    ];

    const result = await writeTranslationRequests(
      requests,
      config,
      async ({ request }) => {
        if (
          request.operation === "write" &&
          "sourceKey" in request.target &&
          request.target.language === "ja"
        )
          await rename(japanesePath, offlineJapanesePath);
        return true;
      },
    );

    assert.deepEqual(
      result.results.map(({ status }) => status),
      ["writeFailed", "written"],
    );
    assert.equal(await readFile(offlineJapanesePath, "utf8"), japaneseText);
    assert.deepEqual(JSON.parse(await readFile(chinesePath, "utf8")), {
      "Chinese source": "已有翻译",
      "New Chinese source": "待译：Another English",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
