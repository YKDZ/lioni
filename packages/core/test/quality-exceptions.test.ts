import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createQualityException,
  evaluateQualityExceptionApplicability,
  upsertQualityExceptionFromReport,
  QualityExceptionFormatError,
  validateQualityException,
  validateQualityExceptionFile,
  validateQualityExceptions,
  type QualityException,
} from "../src/index.ts";

const execution = {
  executionId: 4,
  candidateIndex: 2,
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

void describe("QA 例外", () => {
  void it("从报告执行记录构造例外绑定", () => {
    const exception = createQualityException({
      id: "save-copy-meaning-fr",
      reason: "译文保留了预期动作。",
      execution,
    });

    assert.deepEqual(exception, {
      id: "save-copy-meaning-fr",
      reason: "译文保留了预期动作。",
      checkId: "copy/meaning",
      sourceKey: "save",
      language: "fr",
      inputFingerprint: "sha256:complete-input",
      fingerprintSummary: {
        version: "2",
        configurationFingerprint: "sha256:configuration",
        inputFingerprint: "sha256:business-input",
      },
    });
    assert.equal("candidateIndex" in exception, false);
    assert.equal("executionId" in exception, false);
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
      version: "sha256:report",
      checks: [{ checkId: execution.checkId, executions }],
    };
    const writes: QualityException[] = [];
    let loads = 0;
    const store = {
      async load() {
        loads += 1;
        return [];
      },
      async upsert(exception: QualityException) {
        writes.push(exception);
      },
    };

    const sdkException = await upsertQualityExceptionFromReport({
      report: sdkReport,
      checkId: execution.checkId,
      executionId: 11,
      id: "second-candidate-approval",
      reason: "第二个候选已由维护者确认。",
      store,
    });
    const cliException = await upsertQualityExceptionFromReport({
      report: { schemaVersion: "2", data: sdkReport },
      checkId: execution.checkId,
      executionId: 10,
      id: "first-candidate-approval",
      reason: "第一个候选已由维护者确认。",
      store,
    });

    assert.equal(sdkException.inputFingerprint, "sha256:second-candidate");
    assert.equal(cliException.inputFingerprint, execution.inputFingerprint);
    assert.deepEqual(writes, [sdkException, cliException]);
    assert.equal(loads, 0);
  });

  void it("报告缺少绑定依据时拒绝写入例外", async () => {
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
      upsertQualityExceptionFromReport({
        report: {
          checks: [
            {
              checkId: execution.checkId,
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
      QualityExceptionFormatError,
    );
    assert.equal(writes, 0);
  });

  void it("报告中的空原文键保持原值", async () => {
    let saved: QualityException | undefined;
    const exception = await upsertQualityExceptionFromReport({
      report: {
        checks: [
          {
            checkId: execution.checkId,
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

    assert.equal(exception.sourceKey, "");
    assert.equal(saved?.sourceKey, "");
  });

  void it("缺少可比较依据时拒绝创建例外", () => {
    assert.throws(
      () =>
        createQualityException({
          id: "unbound",
          reason: "已确认。",
          execution: {
            executionId: execution.executionId,
            candidateIndex: execution.candidateIndex,
            checkId: execution.checkId,
            sourceKey: execution.sourceKey,
            language: execution.language,
            status: execution.status,
            fingerprintSummary: execution.fingerprintSummary,
          },
        }),
      QualityExceptionFormatError,
    );
    assert.throws(
      () =>
        createQualityException({
          id: "unexplained",
          reason: "已确认。",
          execution: {
            executionId: execution.executionId,
            candidateIndex: execution.candidateIndex,
            checkId: execution.checkId,
            sourceKey: execution.sourceKey,
            language: execution.language,
            status: execution.status,
            inputFingerprint: execution.inputFingerprint,
          },
        }),
      QualityExceptionFormatError,
    );
  });

  void it("校验手写例外使用的同一数据结构", () => {
    const value: unknown = createQualityException({
      id: "save-copy-meaning-fr",
      reason: "译文保留了预期动作。",
      execution,
    });

    assert.doesNotThrow(() => validateQualityException(value));
    assert.throws(
      () => validateQualityException({ ...execution, id: "wrong-shape" }),
      QualityExceptionFormatError,
    );
  });

  void it("拒绝不支持的格式和重复身份，并允许相同绑定有不同身份", () => {
    const exception = createQualityException({
      id: "save-copy-meaning-fr",
      reason: "保留原意。",
      execution,
    });
    assert.throws(
      () =>
        validateQualityExceptionFile({
          format: "lioni.qa-exceptions/v0",
          exceptions: [],
        }),
      QualityExceptionFormatError,
    );
    assert.doesNotThrow(() =>
      validateQualityExceptionFile({
        format: "lioni.qa-exceptions/v1",
        exceptions: [exception, { ...exception, id: "second-approval" }],
      }),
    );
    assert.throws(
      () =>
        validateQualityExceptions([
          exception,
          {
            ...exception,
            sourceKey: "submit",
            inputFingerprint: "sha256:other-input",
          },
        ]),
      QualityExceptionFormatError,
    );
    assert.throws(
      () =>
        validateQualityExceptions([
          exception,
          {
            ...exception,
            sourceKey: "submit",
            inputFingerprint: "sha256:other-input",
          },
        ]),
      QualityExceptionFormatError,
    );
  });

  void it("按执行记录分别表达适用、依据变化及本次未验证", () => {
    const exception = createQualityException({
      id: "save-copy-meaning-fr",
      reason: "保留原意。",
      execution,
    });
    const results = evaluateQualityExceptionApplicability(
      [exception],
      [
        execution,
        {
          ...execution,
          executionId: 5,
          candidateIndex: 3,
          inputFingerprint: "sha256:changed-input",
          fingerprintSummary: {
            ...execution.fingerprintSummary,
            inputFingerprint: "sha256:changed-business-input",
          },
        },
        {
          executionId: 6,
          candidateIndex: 4,
          checkId: execution.checkId,
          sourceKey: execution.sourceKey,
          language: execution.language,
          status: "not-applicable",
        },
      ],
    );

    assert.deepEqual(
      results.map(
        ({ executionId, candidateIndex, status, reasons, reason }) => ({
          executionId,
          candidateIndex,
          status,
          reasons,
          reason,
        }),
      ),
      [
        {
          executionId: 4,
          candidateIndex: 2,
          status: "applicable",
          reasons: undefined,
          reason: undefined,
        },
        {
          executionId: 5,
          candidateIndex: 3,
          status: "basis-changed",
          reasons: ["business-input"],
          reason: undefined,
        },
        {
          executionId: 6,
          candidateIndex: 4,
          status: "not-verified",
          reasons: undefined,
          reason: "no-comparable-basis",
        },
      ],
    );
  });

  void it("区分三类依据变化，并在旧依据恢复后重新适用", () => {
    const exception = createQualityException({
      id: "save-copy-meaning-fr",
      reason: "保留原意。",
      execution,
    });
    const changedExecutions = [
      {
        ...execution,
        inputFingerprint: "sha256:changed-business",
        fingerprintSummary: {
          ...execution.fingerprintSummary,
          inputFingerprint: "sha256:changed-business",
        },
      },
      {
        ...execution,
        inputFingerprint: "sha256:changed-config",
        fingerprintSummary: {
          ...execution.fingerprintSummary,
          configurationFingerprint: "sha256:changed-config",
        },
      },
      {
        ...execution,
        inputFingerprint: "sha256:changed-version",
        fingerprintSummary: {
          ...execution.fingerprintSummary,
          version: "3",
        },
      },
    ];

    assert.deepEqual(
      changedExecutions.map(
        (changed) =>
          evaluateQualityExceptionApplicability([exception], [changed])[0]
            ?.reasons,
      ),
      [["business-input"], ["configuration"], ["check-implementation"]],
    );
    assert.equal(
      evaluateQualityExceptionApplicability([exception], [execution])[0]
        ?.status,
      "applicable",
    );
    assert.equal(
      evaluateQualityExceptionApplicability(
        [exception],
        [{ ...execution, status: "not-applicable" }],
      )[0]?.status,
      "applicable",
    );
  });

  void it("没有对应执行记录时保留为本次未验证", () => {
    const exception = createQualityException({
      id: "save-copy-meaning-fr",
      reason: "保留原意。",
      execution,
    });

    assert.deepEqual(
      evaluateQualityExceptionApplicability([exception], [])[0],
      {
        exceptionId: exception.id,
        checkId: exception.checkId,
        sourceKey: exception.sourceKey,
        language: exception.language,
        status: "not-verified",
        reason: "not-run",
      },
    );
  });
});
