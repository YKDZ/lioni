import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createQaSuppression,
  upsertQaSuppressionFromReport,
  QaSuppressionFormatError,
  validateQaSuppression,
  validateQaSuppressionFile,
  validateQaSuppressions,
  type QaSuppression,
} from "../src/index.ts";
import { assertQaSuppressionBindings } from "../src/quality/qa-suppressions.ts";

const execution = {
  executionId: 4,
  candidateIndex: 2,
  checkId: "copy/meaning",
  sourceKey: "save",
  language: "fr",
  inputFingerprint: "sha256:complete-input",
  fingerprintSummary: {
    version: "2",
    inputFingerprint: "sha256:business-input",
  },
};

void describe("QA 豁免", () => {
  void it("从报告执行记录构造豁免绑定", () => {
    const suppression = createQaSuppression({
      id: "save-copy-meaning-fr",
      reason: "译文保留了预期动作。",
      execution,
    });

    assert.deepEqual(suppression, {
      id: "save-copy-meaning-fr",
      reason: "译文保留了预期动作。",
      checkId: "copy/meaning",
      sourceKey: "save",
      language: "fr",
      inputFingerprint: "sha256:complete-input",
      fingerprintSummary: {
        version: "2",
        inputFingerprint: "sha256:business-input",
      },
    });
    assert.equal("candidateIndex" in suppression, false);
    assert.equal("executionId" in suppression, false);
  });

  void it("从 SDK 或 CLI 报告按检查和执行身份保存指定候选", async () => {
    const executions = [
      { ...execution, executionId: 10, candidateIndex: 0 },
      {
        ...execution,
        executionId: 11,
        candidateIndex: 1,
        inputFingerprint: "sha256:second-candidate",
        fingerprintSummary: {
          ...execution.fingerprintSummary,
          inputFingerprint: "sha256:second-business-input",
        },
      },
    ];
    const sdkReport = {
      suppressions: [],
      version: "sha256:report",
      diagnostics: [
        { checkId: execution.checkId, executionId: 10 },
        { checkId: execution.checkId, executionId: 11 },
      ],
      checks: [
        {
          checkId: execution.checkId,
          diagnostics: [
            { checkId: execution.checkId, executionId: 10 },
            { checkId: execution.checkId, executionId: 11 },
          ],
          executions,
        },
      ],
    };
    const writes: QaSuppression[] = [];
    let loads = 0;
    const store = {
      async load() {
        loads += 1;
        return [];
      },
      async upsert(suppression: QaSuppression) {
        writes.push(suppression);
      },
    };

    const sdkSuppression = await upsertQaSuppressionFromReport({
      report: sdkReport,
      checkId: execution.checkId,
      executionId: 11,
      id: "second-candidate-approval",
      reason: "第二个候选已由维护者确认。",
      store,
    });
    const cliSuppression = await upsertQaSuppressionFromReport({
      report: {
        schemaVersion: "3",
        command: "qa",
        outputMode: "structured",
        kind: "data",
        variant: "notPassed",
        data: sdkReport,
      },
      checkId: execution.checkId,
      executionId: 10,
      id: "first-candidate-approval",
      reason: "第一个候选已由维护者确认。",
      store,
    });

    assert.equal(sdkSuppression.inputFingerprint, "sha256:second-candidate");
    assert.equal(cliSuppression.inputFingerprint, execution.inputFingerprint);
    assert.deepEqual(writes, [sdkSuppression, cliSuppression]);
    assert.equal(loads, 0);
  });

  void it("报告缺少绑定依据时拒绝写入豁免", async () => {
    let writes = 0;
    const store = {
      async load() {
        return [];
      },
      async upsert() {
        writes += 1;
      },
    };

    await assert.rejects(
      upsertQaSuppressionFromReport({
        report: {
          suppressions: [],
          diagnostics: [{ checkId: execution.checkId, executionId: 12 }],
          checks: [
            {
              checkId: execution.checkId,
              diagnostics: [{ checkId: execution.checkId, executionId: 12 }],
              executions: [
                {
                  ...execution,
                  executionId: 12,
                  inputFingerprint: undefined,
                },
              ],
            },
          ],
        },
        checkId: execution.checkId,
        executionId: 12,
        id: "invalid-report-approval",
        reason: "依据不可用。",
        store,
      }),
      QaSuppressionFormatError,
    );
    assert.equal(writes, 0);
  });

  void it("禁止使用零诊断或缺少诊断明细的执行建立豁免", async () => {
    let writes = 0;
    const store = {
      async load() {
        return [];
      },
      async upsert() {
        writes += 1;
      },
    };

    await assert.rejects(
      upsertQaSuppressionFromReport({
        report: {
          suppressions: [],
          diagnostics: [{ checkId: execution.checkId, executionId: 99 }],
          checks: [
            {
              checkId: execution.checkId,
              diagnostics: [{ checkId: execution.checkId, executionId: 99 }],
              executions: [
                { ...execution, executionId: 99 },
                { ...execution, executionId: 100, sourceKey: "clean" },
              ],
            },
          ],
        },
        checkId: execution.checkId,
        executionId: 100,
        id: "clean-execution-approval",
        reason: "无诊断记录不应建立豁免。",
        store,
      }),
      {
        name: "QaSuppressionFormatError",
        reason: "invalid",
      },
    );

    await assert.rejects(
      upsertQaSuppressionFromReport({
        report: {
          suppressions: [],
          checks: [
            {
              checkId: execution.checkId,
              executions: [{ ...execution, executionId: 101 }],
            },
          ],
        },
        checkId: execution.checkId,
        executionId: 101,
        id: "missing-diagnostics-approval",
        reason: "缺少诊断数组不应建立豁免。",
        store,
      }),
      {
        name: "QaSuppressionFormatError",
        reason: "invalid",
      },
    );
    assert.equal(writes, 0);
  });

  void it("报告中的空原文键保持原值", async () => {
    let saved: QaSuppression | undefined;
    const suppression = await upsertQaSuppressionFromReport({
      report: {
        suppressions: [],
        diagnostics: [{ checkId: execution.checkId, executionId: 13 }],
        checks: [
          {
            checkId: execution.checkId,
            diagnostics: [{ checkId: execution.checkId, executionId: 13 }],
            executions: [{ ...execution, executionId: 13, sourceKey: "" }],
          },
        ],
      },
      checkId: execution.checkId,
      executionId: 13,
      id: "empty-source-key-approval",
      reason: "空键资源经审核确认。",
      store: {
        async load() {
          return [];
        },
        async upsert(value) {
          saved = value;
        },
      },
    });

    assert.equal(suppression.sourceKey, "");
    assert.equal(saved?.sourceKey, "");
  });

  void it("缺少可比较依据时拒绝创建豁免", () => {
    assert.throws(
      () =>
        createQaSuppression({
          id: "unbound",
          reason: "已确认。",
          execution: {
            executionId: execution.executionId,
            candidateIndex: execution.candidateIndex,
            checkId: execution.checkId,
            sourceKey: execution.sourceKey,
            language: execution.language,
            fingerprintSummary: execution.fingerprintSummary,
          },
        }),
      QaSuppressionFormatError,
    );
    assert.throws(
      () =>
        createQaSuppression({
          id: "unexplained",
          reason: "已确认。",
          execution: {
            executionId: execution.executionId,
            candidateIndex: execution.candidateIndex,
            checkId: execution.checkId,
            sourceKey: execution.sourceKey,
            language: execution.language,
            inputFingerprint: execution.inputFingerprint,
          },
        }),
      QaSuppressionFormatError,
    );
  });

  void it("校验手写豁免使用的同一数据结构", () => {
    const suppression = createQaSuppression({
      id: "save-copy-meaning-fr",
      reason: "译文保留了预期动作。",
      execution,
    });
    const value: unknown = suppression;

    assert.doesNotThrow(() => validateQaSuppression(value));
    assert.throws(
      () => validateQaSuppression({ ...execution, id: "wrong-shape" }),
      QaSuppressionFormatError,
    );
    assert.throws(
      () =>
        validateQaSuppression(
          Object.assign(Object.create({ inherited: true }), suppression),
        ),
      QaSuppressionFormatError,
    );
  });

  void it("只接受新格式并拒绝重复身份与同绑定多身份冲突", () => {
    const suppression = createQaSuppression({
      id: "save-copy-meaning-fr",
      reason: "保留原意。",
      execution,
    });
    assert.throws(
      () =>
        validateQaSuppressionFile({
          format: "unsupported",
          suppressions: [],
        }),
      QaSuppressionFormatError,
    );
    assert.doesNotThrow(() =>
      validateQaSuppressionFile({
        format: "lioni.qa-suppressions/v1",
        suppressions: [
          suppression,
          {
            ...suppression,
            id: "second-approval",
            sourceKey: "submit",
          },
          {
            ...suppression,
            id: "third-approval",
            inputFingerprint: "sha256:other-input",
          },
        ],
      }),
    );
    assert.throws(
      () =>
        validateQaSuppressionFile({
          format: "lioni.qa-suppressions/v1",
          suppressions: [
            suppression,
            { ...suppression, id: "second-approval" },
          ],
        }),
      (error: Error) => {
        assert.ok(error instanceof QaSuppressionFormatError);
        assert.equal(error.reason, "invalid");
        assert.match(error.message, /save-copy-meaning-fr/u);
        assert.match(error.message, /second-approval/u);
        return true;
      },
    );
    assert.throws(
      () =>
        validateQaSuppressions([
          suppression,
          {
            ...suppression,
            sourceKey: "submit",
            inputFingerprint: "sha256:other-input",
          },
        ]),
      QaSuppressionFormatError,
    );
  });

  void it("完整资源检查逐条收集失效的豁免，按语言运行时只校验所选记录", () => {
    const valid = createQaSuppression({
      id: "valid",
      reason: "保留原文。",
      execution,
    });
    const input = {
      configuredCheckIds: [execution.checkId],
      configuredLanguages: [execution.language, "de"],
      completeSourceKeys: new Set([execution.sourceKey, "clean"]),
      savedChecks: [
        {
          executions: [
            execution,
            { ...execution, executionId: 5, sourceKey: "clean" },
          ],
          diagnostics: [{ executionId: execution.executionId }],
        },
      ],
      suppressions: [
        valid,
        {
          ...valid,
          id: "changed-input",
          inputFingerprint: "sha256:previous",
          fingerprintSummary: {
            ...valid.fingerprintSummary,
            inputFingerprint: "sha256:previous-business-input",
          },
        },
        {
          ...valid,
          id: "changed-version",
          inputFingerprint: "sha256:previous",
          fingerprintSummary: { ...valid.fingerprintSummary, version: "1" },
        },
        {
          ...valid,
          id: "changed-both",
          inputFingerprint: "sha256:previous",
          fingerprintSummary: {
            version: "1",
            inputFingerprint: "sha256:previous-business-input",
          },
        },
        { ...valid, id: "changed-fingerprint", inputFingerprint: "sha256:old" },
        { ...valid, id: "clean", sourceKey: "clean" },
        { ...valid, id: "removed-key", sourceKey: "deleted" },
        { ...valid, id: "removed-check", checkId: "obsolete" },
        { ...valid, id: "removed-language", language: "es" },
      ],
    };
    assert.throws(
      () => assertQaSuppressionBindings(input),
      (error: Error) => {
        for (const [id, reason] of [
          ["changed-input", "检查输入指纹已改变"],
          ["changed-version", "检查实现版本已改变"],
          ["changed-both", "检查实现版本已改变、检查输入指纹已改变"],
          ["changed-fingerprint", "检查指纹已改变"],
          ["clean", "没有可豁免的诊断"],
          ["removed-key", "原文键已不存在"],
          ["removed-check", "检查项已不存在"],
          ["removed-language", "目标语言已不存在"],
        ] as const)
          assert.ok(
            error.message
              .split("\n")
              .some((line) => line.startsWith(id) && line.endsWith(reason)),
          );
        assert.doesNotMatch(error.message, /valid（/u);
        return true;
      },
    );
    assert.doesNotThrow(() =>
      assertQaSuppressionBindings({ ...input, selectedLanguages: ["de"] }),
    );
  });
});
