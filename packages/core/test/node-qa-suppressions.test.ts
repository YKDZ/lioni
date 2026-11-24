import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  createQaSuppression,
  defineChecker,
  defineConfig,
  QaSuppressionFormatError,
  runQa,
  upsertQaSuppressionFromReport,
  type QualityFinding,
} from "../src/index.ts";
import {
  createDirectoryQualityCheckResultCache,
  createFileQaSuppressionStore,
  resolveDefaultQaSuppressionFilePath,
} from "../src/node/index.ts";
import {
  fixtureTranslationKey,
  schemaFromExamples,
  sourceSchemaFromExamples,
} from "./source-schema.ts";

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
      const oldContents = [
        "format: lioni.quality-exceptions/v1",
        "exceptions:",
        "  - id: legacy-approval",
        "    reason: 旧格式例外",
        "",
      ].join("\n");
      await writeFile(filePath, oldContents, "utf8");
      const store = createFileQaSuppressionStore(filePath);

      await assert.rejects(store.load(), {
        name: "QaSuppressionFormatError",
        reason: "unsupported",
        message: /依据当前 QA 报告重新建立/u,
      });
      await assert.rejects(store.upsert(suppression), {
        name: "QaSuppressionFormatError",
        reason: "unsupported",
      });
      assert.equal(await readFile(filePath, "utf8"), oldContents);
    });
  });

  void it("不同身份指向同一检查绑定时拒绝加载与写入并列出两个冲突身份", async () => {
    await withDirectory(async (directory) => {
      const filePath = path.join(directory, "lioni.suppressions.yaml");
      const store = createFileQaSuppressionStore(filePath);
      await store.upsert(suppression);
      const initialContents = await readFile(filePath, "utf8");

      await assert.rejects(
        store.upsert({
          ...suppression,
          id: "duplicate-binding-id",
          reason: "换用新 ID 建立同一绑定",
        }),
        (error: Error) => {
          assert.equal(error.name, "QaSuppressionFormatError");
          assert.match(error.message, /save-copy-meaning-fr/u);
          assert.match(error.message, /duplicate-binding-id/u);
          return true;
        },
      );
      assert.equal(await readFile(filePath, "utf8"), initialContents);

      await writeFile(
        filePath,
        [
          "format: lioni.qa-suppressions/v1",
          "suppressions:",
          "  - id: first-binding-id",
          "    reason: 第一条",
          "    checkId: copy/meaning",
          "    sourceKey: save",
          "    language: fr",
          "    inputFingerprint: sha256:complete-input",
          '    fingerprintSummary: { version: "2", inputFingerprint: sha256:business-input }',
          "  - id: second-binding-id",
          "    reason: 第二条",
          "    checkId: copy/meaning",
          "    sourceKey: save",
          "    language: fr",
          "    inputFingerprint: sha256:complete-input",
          '    fingerprintSummary: { version: "2", inputFingerprint: sha256:business-input }',
          "",
        ].join("\n"),
        "utf8",
      );
      await assert.rejects(store.load(), (error: Error) => {
        assert.equal(error.name, "QaSuppressionFormatError");
        assert.match(error.message, /first-binding-id/u);
        assert.match(error.message, /second-binding-id/u);
        return true;
      });
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

  void it("从实际诊断建立、更新与校验豁免，并在缓存命中、局部与草稿检查中生效", async () => {
    await withDirectory(async (directory) => {
      const store = createFileQaSuppressionStore(
        path.join(directory, "lioni.suppressions.yaml"),
      );
      const cache = createDirectoryQualityCheckResultCache(
        path.join(directory, "cache"),
      );
      const units = [
        { key: "flag", source: "Flag" },
        { key: "clean", source: "Clean" },
      ];
      const translations = [
        { id: "flag", text: "Drapeau" },
        { id: "clean", text: "Propre" },
      ];
      let ruleACalls = 0;
      const makeFinding = (key: string, message: string): QualityFinding => ({
        severity: "error",
        object: { kind: "translation-unit", key, language: "fr" },
        location: { language: "fr", range: "fr.json", key },
        message,
        evidence: [],
      });

      const ruleA = defineChecker.withTypes<
        { readonly key: string; readonly source: string },
        { readonly id: string; readonly text: string },
        string,
        never
      >()({
        id: "rule-a",
        version: "rule-a-v1",
        inputSchema: schemaFromExamples(""),
        prepare: ({ association, candidate }) =>
          `${association.sourceKey}:${candidate?.content ?? ""}`,
        check(input) {
          ruleACalls += 1;
          if (input.startsWith("clean:")) return [];
          return [
            makeFinding("flag", "第一条规则问题"),
            makeFinding("flag", "第二条规则问题"),
          ];
        },
      });
      const ruleB = defineChecker.withTypes<
        { readonly key: string; readonly source: string },
        { readonly id: string; readonly text: string },
        string,
        never
      >()({
        id: "rule-b",
        version: "rule-b-v1",
        inputSchema: schemaFromExamples(""),
        prepare: ({ association, candidate }) =>
          `${association.sourceKey}:${candidate?.content ?? ""}`,
        check(input) {
          if (input.startsWith("clean:")) return [];
          return [makeFinding("flag", "另一检查项的问题")];
        },
      });

      const config = defineConfig({
        source: {
          schema: sourceSchemaFromExamples(units[0]!),
          read: () => ({
            scopes: [
              {
                range: "source.json",
                enumeration: "complete",
                records: units.map((value) => ({
                  value,
                  bodyAvailability: "available",
                })),
              },
            ],
          }),
        },
        keyOf: ({ key }) => key,
        translations: {
          languages: ["fr"],
          schema: schemaFromExamples(translations[0]!),
          contentSchema: schemaFromExamples(""),
          contentOf: ({ text }) => text,
          keyOf: fixtureTranslationKey,
          read: () => ({
            scopes: [
              {
                range: "fr.json",
                covers: ["flag", "clean"],
                enumeration: "complete",
                records: translations.map((value) => ({
                  value,
                  bodyAvailability: "available",
                })),
              },
            ],
          }),
        },
        quality: {
          checks: [ruleA, ruleB],
          suppressionStore: store,
          resultCache: cache,
        },
      });

      const debugReport = await runQa(config, { includeCleanExecutions: true });
      const cleanExecution = debugReport.checks
        .find(({ checkId }) => checkId === "rule-a")
        ?.executions.find(({ sourceKey }) => sourceKey === "clean");
      assert.ok(cleanExecution);
      await assert.rejects(
        upsertQaSuppressionFromReport({
          report: debugReport,
          checkId: "rule-a",
          executionId: cleanExecution.executionId,
          id: "clean-should-fail",
          reason: "零诊断执行不能建立豁免。",
          store,
        }),
        QaSuppressionFormatError,
      );

      const report = await runQa(config);
      const flagExecution = report.checks
        .find(({ checkId }) => checkId === "rule-a")
        ?.executions.find(({ sourceKey }) => sourceKey === "flag");
      assert.ok(flagExecution);

      await upsertQaSuppressionFromReport({
        report,
        checkId: "rule-a",
        executionId: flagExecution.executionId,
        id: "flag-rule-a-fr",
        reason: "初次确认。",
        store,
      });
      await upsertQaSuppressionFromReport({
        report,
        checkId: "rule-a",
        executionId: flagExecution.executionId,
        id: "flag-rule-a-fr",
        reason: "更新后的理由。",
        store,
      });
      await assert.rejects(
        upsertQaSuppressionFromReport({
          report,
          checkId: "rule-a",
          executionId: flagExecution.executionId,
          id: "flag-rule-a-conflict",
          reason: "冲突身份。",
          store,
        }),
        (error: Error) => {
          assert.ok(error instanceof QaSuppressionFormatError);
          assert.match(error.message, /flag-rule-a-fr/u);
          assert.match(error.message, /flag-rule-a-conflict/u);
          return true;
        },
      );

      const callsBeforeCachedRun = ruleACalls;
      const cachedFull = await runQa(config);
      assert.equal(ruleACalls, callsBeforeCachedRun);
      assert.deepEqual(
        cachedFull.diagnostics
          .filter(({ checkId }) => checkId === "rule-a")
          .map(({ handling }) => handling),
        [
          {
            status: "suppressed",
            suppressionId: "flag-rule-a-fr",
            reason: "更新后的理由。",
          },
          {
            status: "suppressed",
            suppressionId: "flag-rule-a-fr",
            reason: "更新后的理由。",
          },
        ],
      );
      assert.deepEqual(
        cachedFull.diagnostics.find(({ checkId }) => checkId === "rule-b")
          ?.handling,
        { status: "active" },
      );

      const partial = await runQa(config, { checkIds: ["rule-a"] });
      assert.equal(partial.progress, undefined);
      assert.equal(partial.diagnostics.length, 2);
      assert.ok(
        partial.diagnostics.every(
          ({ handling }) =>
            handling.status === "suppressed" &&
            handling.suppressionId === "flag-rule-a-fr",
        ),
      );

      const draft = await runQa(config, {
        candidates: [{ sourceKey: "flag", language: "fr", content: "Drapeau" }],
      });
      assert.equal(draft.progress, undefined);
      assert.deepEqual(
        draft.diagnostics.map(({ checkId, handling }) => [
          checkId,
          handling.status,
        ]),
        [
          ["rule-a", "suppressed"],
          ["rule-a", "suppressed"],
          ["rule-b", "active"],
        ],
      );
    });
  });
});
