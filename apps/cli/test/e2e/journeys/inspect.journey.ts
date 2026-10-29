import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import type { CliJourney } from "../journey.ts";

const journey: CliJourney = {
  name: "inspect",
  modes: ["source", "distribution"],
  async setup({ workDir, mode }) {
    const sdkImport = mode === "source" ? "@lioni/core" : "@lioni/lioni";
    await writeFile(
      path.join(workDir, "lioni.config.ts"),
      `import { defineConfig } from "${sdkImport}";

export default defineConfig({
  source: {
    schema: { "~standard": { version: 1, vendor: "inspect-journey", validate(value) {
      const context = value?.context;
      return typeof value === "object" && value !== null && !Array.isArray(value) &&
        typeof value.source === "string" && typeof context === "object" && context !== null &&
        typeof context.file === "string" && typeof context.line === "number" &&
        typeof context.screenshot === "string"
        ? { value }
        : { issues: [{ message: "原文单元结构不匹配。" }] };
    } } },
    read: () => ({ scopes: [{
      range: "src/messages.ts",
      enumeration: "complete",
      records: [{
        value: {
          source: "Save",
          context: { file: "src/messages.ts", line: 18, screenshot: "shots/save.png" }
        },
        bodyAvailability: "available"
      }]
    }] })
  },
  keyOf: (unit) => unit.context.file + ":" + unit.context.line,
  translations: {
    languages: ["fr"],
    keyOf: (translation) => ({ namespace: "messages", key: translation.id }),
    schema: { "~standard": { version: 1, vendor: "inspect-journey-translation", validate(value) {
      const context = value?.context;
      return typeof value === "object" && value !== null && !Array.isArray(value) &&
        typeof value.id === "string" && typeof value.text === "string" && typeof context === "object" && context !== null &&
        typeof context.file === "string" && typeof context.line === "number"
        ? { value }
        : { issues: [{ message: "译文记录结构不匹配。" }] };
    } } },
    contentSchema: { "~standard": { version: 1, vendor: "inspect-journey-content", validate(value) {
      return typeof value === "string"
        ? { value }
        : { issues: [{ message: "译文正文必须是字符串。" }] };
    } } },
    read: (_language, sourceUnits) => ({ scopes: [{
      range: "locales/fr.json",
      covers: sourceUnits.map(({ key }) => key),
      enumeration: "complete",
      records: [
        {
          value: { id: "save-button", text: "Enregistrer", context: { file: "src/messages.ts", line: 18 } },
          bodyAvailability: "available"
        },
        {
          value: { id: "legacy-notice", text: "Avis", context: { file: "legacy/messages.ts", line: 999 } },
          bodyAvailability: "available"
        }
      ]
    }] }),
    matches: (unit, translation) =>
      unit.context.file === translation.context.file &&
      unit.context.line === translation.context.line,
    contentOf: (translation) => translation.text
  }
});
`,
    );
    await writeFile(
      path.join(workDir, "duplicate.config.ts"),
      `import { defineConfig } from "${sdkImport}";

export default defineConfig({
  source: {
    schema: { "~standard": { version: 1, vendor: "inspect-journey", validate(value) {
      const context = value?.context;
      return typeof value === "object" && value !== null && !Array.isArray(value) &&
        typeof value.source === "string" && typeof context === "object" && context !== null &&
        typeof context.file === "string" && typeof context.line === "number"
        ? { value }
        : { issues: [{ message: "原文单元结构不匹配。" }] };
    } } },
    read: () => ({ scopes: [{
      range: "src/messages.ts",
      enumeration: "complete",
      records: [
        { value: { source: "Save", context: { file: "src/messages.ts", line: 18 } }, bodyAvailability: "available" },
        { value: { source: "Submit", context: { file: "src/messages.ts", line: 18 } }, bodyAvailability: "available" }
      ]
    }] })
  },
  keyOf: (unit) => unit.context.file + ":" + unit.context.line
});
`,
    );
    await writeFile(
      path.join(workDir, "qa.config.ts"),
      `import { defineConfig, defineQualityCheck } from "${sdkImport}";
import baseConfig from "./lioni.config.ts";

const enabledConfigurationSchema = {
  "~standard": {
    version: 1,
    vendor: "inspect-journey-qa",
    validate(value) {
      return typeof value === "object" && value !== null && !Array.isArray(value) && typeof value.enabled === "boolean"
        ? { value }
        : { issues: [{ message: "检查器配置必须包含布尔型 enabled 字段。" }] };
    }
  }
};

export default defineConfig({
  ...baseConfig,
  quality: {
    checks: [defineQualityCheck({
      id: "host-rule",
      version: "inspect-journey-qa-v1",
      configurationSchema: enabledConfigurationSchema,
      configuration: { enabled: true },
      check({ configuration, candidate }) {
        return {
          status: configuration.enabled ? "complete" : "not-applicable",
          diagnostics: configuration.enabled ? [{
            severity: "warning",
            object: {
              kind: "translation-unit",
              key: candidate.sourceKey,
              language: candidate.language
            },
            location: {
              language: candidate.language,
              range: "src/messages.ts:18"
            },
            message: "候选需要人工复核。",
            evidence: []
          }] : [],
          issues: [],
          coverage: {
            selected: 1,
            evaluated: 1,
            notApplicable: 0,
            incomplete: 0,
            failed: 0
          }
        };
      }
    })],
    loadDependencies: () => ({ selectedBy: "defineConfig" }),
  },
});
`,
    );
    await writeFile(
      path.join(workDir, "no-checks.config.ts"),
      `export { default } from "./lioni.config.ts";\n`,
    );
  },
  commands() {
    return [
      {
        name: "以结构化格式查看源译资源",
        args: ["inspect", "lioni.config.ts"],
      },
      {
        name: "以文本格式查看源译资源",
        args: ["inspect", "lioni.config.ts", "--output-format", "text"],
      },
      {
        name: "查看资源时报告原文身份重复",
        args: ["inspect", "duplicate.config.ts"],
      },
      {
        name: "explicit host QA checker",
        args: ["qa", "qa.config.ts", "--output-format", "structured"],
      },
      {
        name: "default readable QA candidate summary",
        args: ["qa", "qa.config.ts"],
      },
      {
        name: "QA without a configured checker",
        args: ["qa", "no-checks.config.ts"],
      },
      { name: "help", args: ["--help"] },
      { name: "version", args: ["--version"] },
      { name: "查看资源时缺少配置参数", args: ["inspect"] },
    ];
  },
  async assertions({ results }) {
    const structured = results[0];
    const readable = results[1];
    const duplicate = results[2];
    const qa = results[3];
    const qaText = results[4];
    const noChecks = results[5];
    assert.equal(
      structured?.exitCode,
      0,
      `${structured?.stdout ?? ""}${structured?.stderr ?? ""}`,
    );
    assert.equal(structured?.stderr, "");
    const result = JSON.parse(structured?.stdout ?? "") as {
      schemaVersion: string;
      data: {
        version: string;
        source: {
          totalUnitCount: number | null;
          read: { status: string };
          units: readonly {
            key: string;
            unit: {
              source: string;
              context: { file: string; line: number; screenshot: string };
            };
            bodyAvailability: string;
            scopeIndex: number;
          }[];
        };
        translations: {
          reads: readonly {
            language: string;
            status: string;
            scopes: readonly {
              range: string;
              covers: readonly string[];
              enumeration: string;
              translationIndexes: readonly number[];
            }[];
          }[];
          records: readonly {
            index: number;
            language: string;
            scopeIndex: number;
            range: string;
            identity: { language: string; namespace: string; key: string };
            translation: {
              id: string;
              text: string;
              context: { file: string; line: number };
            };
            content: string;
            bodyAvailability: string;
          }[];
        };
        associations: readonly {
          sourceKey: string;
          language: string;
          status: string;
          coverageStatus: string;
          scopeIndexes: readonly number[];
          translationIndexes: readonly number[];
        }[];
      };
    };
    assert.equal(result.schemaVersion, "2");
    assert.match(result.data.version, /^sha256:[a-f0-9]{64}$/u);
    assert.equal(result.data.source.read.status, "complete");
    assert.equal(result.data.source.totalUnitCount, 1);
    assert.deepEqual(result.data.source.units, [
      {
        key: "src/messages.ts:18",
        unit: {
          source: "Save",
          context: {
            file: "src/messages.ts",
            line: 18,
            screenshot: "shots/save.png",
          },
        },
        bodyAvailability: "available",
        scopeIndex: 0,
      },
    ]);
    assert.deepEqual(result.data.translations.reads, [
      {
        language: "fr",
        status: "complete",
        scopes: [
          {
            range: "locales/fr.json",
            covers: ["src/messages.ts:18"],
            enumeration: "complete",
            translationIndexes: [0, 1],
          },
        ],
      },
    ]);
    assert.deepEqual(result.data.translations.records, [
      {
        index: 0,
        language: "fr",
        scopeIndex: 0,
        range: "locales/fr.json",
        identity: {
          language: "fr",
          namespace: "messages",
          key: "save-button",
        },
        translation: {
          id: "save-button",
          text: "Enregistrer",
          context: { file: "src/messages.ts", line: 18 },
        },
        content: "Enregistrer",
        bodyAvailability: "available",
      },
      {
        index: 1,
        language: "fr",
        scopeIndex: 0,
        range: "locales/fr.json",
        identity: {
          language: "fr",
          namespace: "messages",
          key: "legacy-notice",
        },
        translation: {
          id: "legacy-notice",
          text: "Avis",
          context: { file: "legacy/messages.ts", line: 999 },
        },
        content: "Avis",
        bodyAvailability: "available",
      },
    ]);
    assert.deepEqual(result.data.associations, [
      {
        sourceKey: "src/messages.ts:18",
        language: "fr",
        status: "matched",
        coverageStatus: "complete",
        scopeIndexes: [0],
        translationIndexes: [0],
      },
    ]);
    assert.equal(readable?.exitCode, 0);
    assert.equal(readable?.stderr, "");
    assert.ok(readable?.stdout.includes(result.data.version));
    assert.match(readable?.stdout ?? "", /src\/messages\.ts:18/u);
    assert.ok(readable?.stdout.includes('"source":"Save"'));
    assert.match(readable?.stdout ?? "", /shots\/save\.png/u);
    assert.match(readable?.stdout ?? "", /Enregistrer/u);
    assert.match(readable?.stdout ?? "", /matched/u);
    assert.equal(duplicate?.exitCode, 1);
    assert.equal(duplicate?.stdout, "");
    assert.partialDeepStrictEqual(JSON.parse(duplicate?.stderr ?? ""), {
      schemaVersion: "2",
      kind: "failure",
      variant: "duplicateIdentity",
      data: { key: "src/messages.ts:18" },
    });
    assert.equal(qa?.exitCode, 0, `${qa?.stdout ?? ""}${qa?.stderr ?? ""}`);
    assert.equal(qa?.stderr, "");
    const qaResult = JSON.parse(qa?.stdout ?? "") as {
      data: {
        status: string;
        diagnostics: readonly {
          checkId: string;
          executionId: number;
          message: string;
        }[];
        candidates: readonly {
          sourceKey: string;
          language: string;
          content: string;
        }[];
        dependencies: { selectedBy: string };
        factCoverage: {
          associations: readonly {
            sourceKey: string;
            language: string;
            status: string;
            candidateSelected: boolean;
          }[];
        };
        checks: readonly {
          checkId: string;
          version: string;
          configuration: { enabled: boolean };
          status: string;
          diagnostics: readonly {
            checkId: string;
            executionId: number;
            message: string;
          }[];
          executions: readonly {
            executionId: number;
            candidateIndex: number;
            checkId: string;
            sourceKey: string;
            language: string;
            status: string;
            inputFingerprint?: string;
            fingerprintSummary?: {
              version: string;
              configurationFingerprint: string;
              inputFingerprint: string;
            };
          }[];
        }[];
      };
    };
    assert.equal(qaResult.data.status, "complete");
    assert.deepEqual(qaResult.data.candidates, [
      {
        sourceKey: "src/messages.ts:18",
        language: "fr",
        content: "Enregistrer",
      },
    ]);
    assert.deepEqual(qaResult.data.dependencies, {
      selectedBy: "defineConfig",
    });
    assert.deepEqual(qaResult.data.factCoverage.associations, [
      {
        sourceKey: "src/messages.ts:18",
        language: "fr",
        status: "matched",
        coverageStatus: "complete",
        scopeIndexes: [0],
        translationIndexes: [0],
        candidateSelected: true,
      },
    ]);
    assert.equal(qaResult.data.checks.length, 1);
    const check = qaResult.data.checks[0];
    assert.equal(check?.checkId, "host-rule");
    assert.equal(check?.version, "inspect-journey-qa-v1");
    assert.deepEqual(check?.configuration, { enabled: true });
    assert.equal(check?.status, "complete");
    assert.equal(qaResult.data.diagnostics.length, 1);
    assert.equal(qaResult.data.diagnostics[0]?.checkId, "host-rule");
    assert.equal(qaResult.data.diagnostics[0]?.executionId, 0);
    assert.deepEqual(check?.diagnostics, qaResult.data.diagnostics);
    assert.deepEqual(
      check?.executions.map(
        ({
          executionId,
          candidateIndex,
          checkId,
          sourceKey,
          language,
          status,
        }) => ({
          executionId,
          candidateIndex,
          checkId,
          sourceKey,
          language,
          status,
        }),
      ),
      [
        {
          executionId: 0,
          candidateIndex: 0,
          checkId: "host-rule",
          sourceKey: "src/messages.ts:18",
          language: "fr",
          status: "complete",
        },
      ],
    );
    assert.match(
      check?.executions[0]?.inputFingerprint ?? "",
      /^sha256:[a-f0-9]{64}$/u,
    );
    assert.equal(
      check?.executions[0]?.fingerprintSummary?.version,
      "lioni.check-input/v1:inspect-journey-qa-v1",
    );
    assert.equal(
      qaText?.exitCode,
      0,
      `${qaText?.stdout ?? ""}${qaText?.stderr ?? ""}`,
    );
    assert.equal(qaText?.stderr, "");
    assert.match(qaText?.stdout ?? "", /质量结论：通过/u);
    assert.match(qaText?.stdout ?? "", /执行状态：完整/u);
    assert.match(qaText?.stdout ?? "", /语言范围：读取 fr；所选候选语言 fr/u);
    assert.match(qaText?.stdout ?? "", /检查范围：已选候选 1 条，检查项 1 项/u);
    assert.match(
      qaText?.stdout ?? "",
      /有效问题：错误 0，警告 1，提示 0；已豁免 0/u,
    );
    assert.match(
      qaText?.stdout ?? "",
      /- \[警告\] host-rule src\/messages\.ts:18（fr，src\/messages\.ts:18）：候选需要人工复核/u,
    );
    assert.equal(noChecks?.exitCode, 1);
    assert.match(noChecks?.stdout ?? "", /语言范围：读取 fr；所选候选语言 fr/u);
    assert.match(
      noChecks?.stdout ?? "",
      /检查范围：已选候选 1 条，检查项 0 项/u,
    );
    assert.match(noChecks?.stdout ?? "", /没有配置检查项/u);
    assert.equal(results[6]?.exitCode, 0);
    assert.match(results[6]?.stdout ?? "", /inspect/u);
    assert.equal(results[7]?.exitCode, 0);
    assert.equal(results[7]?.stdout, "lioni 0.1.1\n");
    assert.equal(results[8]?.exitCode, 2);
    assert.equal(results[8]?.stdout, "");
    assert.partialDeepStrictEqual(JSON.parse(results[8]?.stderr ?? ""), {
      schemaVersion: "2",
      kind: "usageFailure",
      issues: [{ code: "missingRequiredField", field: "config" }],
    });
  },
};

export default journey;
