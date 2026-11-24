import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { createQaSuppression } from "../src/index.ts";
import {
  createFileQaSuppressionStore,
  resolveDefaultQaSuppressionFilePath,
} from "../src/node/index.ts";

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
    inputFingerprint: "sha256:business-input",
  },
};

const suppression = createQaSuppression({
  id: "save-copy-meaning-fr",
  reason: "译文保留了预期动作。",
  execution,
});

async function withDirectory(
  run: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "lioni-qa-suppressions-"),
  );
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

void describe("Node.js QA 豁免存储", () => {
  void it("缺少默认文件时返回空豁免列表", async () => {
    await withDirectory(async (directory) => {
      const store = createFileQaSuppressionStore(
        path.join(directory, "lioni.suppressions.yaml"),
      );

      assert.deepEqual(await store.load(), []);
      await store.upsert(suppression);
      assert.deepEqual(await store.load(), [suppression]);
      const contents = await readFile(
        path.join(directory, "lioni.suppressions.yaml"),
        "utf8",
      );
      assert.match(contents, /^format: lioni\.qa-suppressions\/v1$/mu);
    });
  });

  void it("读取手写 YAML 并校验版本化记录", async () => {
    await withDirectory(async (directory) => {
      const filePath = path.join(directory, "lioni.suppressions.yaml");
      await writeFile(
        filePath,
        [
          "# 人工维护的批准记录",
          "format: lioni.qa-suppressions/v1",
          "suppressions:",
          "  - id: save-copy-meaning-fr",
          "    reason: 译文保留了预期动作。",
          "    checkId: copy/meaning",
          "    sourceKey: save",
          "    language: fr",
          "    inputFingerprint: sha256:complete-input",
          "    fingerprintSummary:",
          '      version: "2"',
          "      inputFingerprint: sha256:business-input",
          "",
        ].join("\n"),
        "utf8",
      );
      const store = createFileQaSuppressionStore(filePath);

      assert.deepEqual(await store.load(), [suppression]);
    });
  });

  void it("拒绝旧豁免并保留原文件供用户重建", async () => {
    await withDirectory(async (directory) => {
      const filePath = path.join(directory, "lioni.suppressions.yaml");
      const oldContents = ["format: unsupported", "suppressions: []", ""].join(
        "\n",
      );
      await writeFile(filePath, oldContents, "utf8");
      const store = createFileQaSuppressionStore(filePath);

      await assert.rejects(store.load(), {
        name: "QaSuppressionFormatError",
        reason: "unsupported",
        message: /依据当前 QA 报告重新建立/u,
      });
      await assert.rejects(store.upsert(suppression), {
        name: "QaSuppressionFormatError",
      });
      assert.equal(await readFile(filePath, "utf8"), oldContents);
    });
  });

  void it("无效 YAML、错误格式或冲突身份会明确失败", async () => {
    await withDirectory(async (directory) => {
      const filePath = path.join(directory, "lioni.suppressions.yaml");
      const store = createFileQaSuppressionStore(filePath);
      await writeFile(filePath, "suppressions: [\n", "utf8");
      await assert.rejects(store.load(), {
        name: "QaSuppressionFormatError",
      });

      await writeFile(
        filePath,
        "format: unsupported\nsuppressions: []\n",
        "utf8",
      );
      await assert.rejects(store.load(), {
        name: "QaSuppressionFormatError",
      });

      await writeFile(filePath, "", "utf8");
      await assert.rejects(store.load(), {
        name: "QaSuppressionFormatError",
      });

      await writeFile(
        filePath,
        [
          "format: lioni.qa-suppressions/v1",
          "suppressions:",
          "  - id: first",
          "    reason: 第一个理由",
          "    checkId: copy/meaning",
          "    sourceKey: save",
          "    language: fr",
          "    inputFingerprint: sha256:complete-input",
          '    fingerprintSummary: { version: "2", inputFingerprint: sha256:business-input }',
          "  - id: first",
          "    reason: 重复身份",
          "    checkId: copy/meaning",
          "    sourceKey: save",
          "    language: fr",
          "    inputFingerprint: sha256:complete-input",
          '    fingerprintSummary: { version: "2", inputFingerprint: sha256:business-input }',
          "",
        ].join("\n"),
        "utf8",
      );
      await assert.rejects(store.load(), {
        name: "QaSuppressionFormatError",
      });

      const unreadablePath = path.join(directory, "directory-not-a-file");
      await mkdir(unreadablePath);
      await assert.rejects(createFileQaSuppressionStore(unreadablePath).load());
    });
  });

  void it("更新单条记录时保留注释和其他记录顺序", async () => {
    await withDirectory(async (directory) => {
      const filePath = path.join(directory, "lioni.suppressions.yaml");
      await writeFile(
        filePath,
        [
          "# 文件说明保留",
          "format: lioni.qa-suppressions/v1",
          "suppressions:",
          "  # 第一条说明保留",
          "  - id: save-copy-meaning-fr",
          "    reason: 旧理由",
          "    checkId: copy/meaning",
          "    sourceKey: save",
          "    language: fr",
          "    inputFingerprint: sha256:complete-input",
          "    fingerprintSummary:",
          '      version: "2"',
          "      inputFingerprint: sha256:business-input",
          "  # 第二条说明保留",
          "  - id: another-suppression",
          "    reason: 另一项人工批准",
          "    checkId: copy/meaning",
          "    sourceKey: submit",
          "    language: fr",
          "    inputFingerprint: sha256:other-input",
          "    fingerprintSummary:",
          '      version: "2"',
          "      inputFingerprint: sha256:other-business-input",
          "",
        ].join("\n"),
        "utf8",
      );
      const store = createFileQaSuppressionStore(filePath);

      await store.upsert(suppression);

      const contents = await readFile(filePath, "utf8");
      assert.match(contents, /# 文件说明保留/u);
      assert.match(contents, /# 第一条说明保留/u);
      assert.match(contents, /# 第二条说明保留/u);
      assert.ok(
        contents.indexOf("save-copy-meaning-fr") <
          contents.indexOf("another-suppression"),
      );
      assert.deepEqual(await store.load(), [
        suppression,
        {
          id: "another-suppression",
          reason: "另一项人工批准",
          checkId: "copy/meaning",
          sourceKey: "submit",
          language: "fr",
          inputFingerprint: "sha256:other-input",
          fingerprintSummary: {
            version: "2",
            inputFingerprint: "sha256:other-business-input",
          },
        },
      ]);
    });
  });

  void it("从配置文件路径定位同目录下的默认豁免文件", () => {
    assert.equal(
      resolveDefaultQaSuppressionFilePath("configs/lioni.config.ts"),
      path.resolve("configs/lioni.suppressions.yaml"),
    );
  });
});
