import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  createFileQualityExceptionStore,
  resolveDefaultQualityExceptionFilePath,
} from "../src/node.ts";
import { createQualityException } from "../src/quality-exceptions.ts";

const execution = {
  executionId: 0,
  candidateIndex: 0,
  checkId: "copy/meaning",
  sourceKey: "save",
  language: "fr",
  status: "complete",
  inputFingerprint: "sha256:complete-input",
  fingerprintSummary: {
    version: "2",
    configurationFingerprint: "sha256:configuration",
    inputFingerprint: "sha256:business-input",
  },
};

const exception = createQualityException({
  id: "save-copy-meaning-fr",
  reason: "译文保留了预期动作。",
  execution,
});

async function withDirectory(
  run: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "lioni-qa-exceptions-"),
  );
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

void describe("Node.js QA 例外存储", () => {
  void it("缺少默认文件时返回空例外列表", async () => {
    await withDirectory(async (directory) => {
      const store = createFileQualityExceptionStore(
        path.join(directory, "lioni.exceptions.yaml"),
      );

      assert.deepEqual(await store.load(), []);
      await store.upsert(exception);
      assert.deepEqual(await store.load(), [exception]);
    });
  });

  void it("读取手写 YAML 并校验版本化记录", async () => {
    await withDirectory(async (directory) => {
      const filePath = path.join(directory, "lioni.exceptions.yaml");
      await writeFile(
        filePath,
        [
          "# 人工维护的批准记录",
          "format: lioni.qa-exceptions/v1",
          "exceptions:",
          "  - id: save-copy-meaning-fr",
          "    reason: 译文保留了预期动作。",
          "    checkId: copy/meaning",
          "    sourceKey: save",
          "    language: fr",
          "    inputFingerprint: sha256:complete-input",
          "    fingerprintSummary:",
          '      version: "2"',
          "      configurationFingerprint: sha256:configuration",
          "      inputFingerprint: sha256:business-input",
          "",
        ].join("\n"),
        "utf8",
      );
      const store = createFileQualityExceptionStore(filePath);

      assert.deepEqual(await store.load(), [exception]);
    });
  });

  void it("无效 YAML、错误格式或冲突身份会明确失败", async () => {
    await withDirectory(async (directory) => {
      const filePath = path.join(directory, "lioni.exceptions.yaml");
      const store = createFileQualityExceptionStore(filePath);
      await writeFile(filePath, "exceptions: [\n", "utf8");
      await assert.rejects(store.load(), {
        name: "QualityExceptionFormatError",
      });

      await writeFile(
        filePath,
        "format: lioni.qa-exceptions/v2\nexceptions: []\n",
        "utf8",
      );
      await assert.rejects(store.load(), {
        name: "QualityExceptionFormatError",
      });

      await writeFile(filePath, "", "utf8");
      await assert.rejects(store.load(), {
        name: "QualityExceptionFormatError",
      });

      await writeFile(
        filePath,
        [
          "format: lioni.qa-exceptions/v1",
          "exceptions:",
          "  - id: first",
          "    reason: 第一个理由",
          "    checkId: copy/meaning",
          "    sourceKey: save",
          "    language: fr",
          "    inputFingerprint: sha256:complete-input",
          '    fingerprintSummary: { version: "2", configurationFingerprint: sha256:configuration, inputFingerprint: sha256:business-input }',
          "  - id: first",
          "    reason: 重复身份",
          "    checkId: copy/meaning",
          "    sourceKey: save",
          "    language: fr",
          "    inputFingerprint: sha256:complete-input",
          '    fingerprintSummary: { version: "2", configurationFingerprint: sha256:configuration, inputFingerprint: sha256:business-input }',
          "",
        ].join("\n"),
        "utf8",
      );
      await assert.rejects(store.load(), {
        name: "QualityExceptionFormatError",
      });

      const unreadablePath = path.join(directory, "directory-not-a-file");
      await mkdir(unreadablePath);
      await assert.rejects(
        createFileQualityExceptionStore(unreadablePath).load(),
      );
    });
  });

  void it("更新单条记录时保留注释和其他记录顺序", async () => {
    await withDirectory(async (directory) => {
      const filePath = path.join(directory, "lioni.exceptions.yaml");
      await writeFile(
        filePath,
        [
          "# 文件说明保留",
          "format: lioni.qa-exceptions/v1",
          "exceptions:",
          "  # 第一条说明保留",
          "  - id: save-copy-meaning-fr",
          "    reason: 旧理由",
          "    checkId: copy/meaning",
          "    sourceKey: save",
          "    language: fr",
          "    inputFingerprint: sha256:complete-input",
          "    fingerprintSummary:",
          '      version: "2"',
          "      configurationFingerprint: sha256:configuration",
          "      inputFingerprint: sha256:business-input",
          "  # 第二条说明保留",
          "  - id: another-exception",
          "    reason: 另一项人工批准",
          "    checkId: copy/meaning",
          "    sourceKey: submit",
          "    language: fr",
          "    inputFingerprint: sha256:other-input",
          "    fingerprintSummary:",
          '      version: "2"',
          "      configurationFingerprint: sha256:configuration",
          "      inputFingerprint: sha256:other-business-input",
          "",
        ].join("\n"),
        "utf8",
      );
      const store = createFileQualityExceptionStore(filePath);

      await store.upsert(exception);

      const contents = await readFile(filePath, "utf8");
      assert.match(contents, /# 文件说明保留/u);
      assert.match(contents, /# 第一条说明保留/u);
      assert.match(contents, /# 第二条说明保留/u);
      assert.ok(
        contents.indexOf("save-copy-meaning-fr") <
          contents.indexOf("another-exception"),
      );
      assert.deepEqual(await store.load(), [
        exception,
        {
          id: "another-exception",
          reason: "另一项人工批准",
          checkId: "copy/meaning",
          sourceKey: "submit",
          language: "fr",
          inputFingerprint: "sha256:other-input",
          fingerprintSummary: {
            version: "2",
            configurationFingerprint: "sha256:configuration",
            inputFingerprint: "sha256:other-business-input",
          },
        },
      ]);
    });
  });

  void it("从配置文件路径定位同目录下的默认例外文件", () => {
    assert.equal(
      resolveDefaultQualityExceptionFilePath("configs/lioni.config.ts"),
      path.resolve("configs/lioni.exceptions.yaml"),
    );
  });
});
