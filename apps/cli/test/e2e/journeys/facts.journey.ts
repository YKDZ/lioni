import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import type { CliJourney } from "../journey.ts";

const journey: CliJourney = {
  name: "facts",
  modes: ["source", "distribution"],
  async setup({ workDir }) {
    await writeFile(
      path.join(workDir, "lioni.config.ts"),
      `import { defineConfig } from "@lioni/core";

export default defineConfig({
  source: {
    schema: { "~standard": { version: 1, vendor: "facts-journey", validate(value) {
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
    schema: { "~standard": { version: 1, vendor: "facts-journey-translation", validate(value) {
      const context = value?.context;
      return typeof value === "object" && value !== null && !Array.isArray(value) &&
        typeof value.text === "string" && typeof context === "object" && context !== null &&
        typeof context.file === "string" && typeof context.line === "number"
        ? { value }
        : { issues: [{ message: "译文记录结构不匹配。" }] };
    } } },
    contentSchema: { "~standard": { version: 1, vendor: "facts-journey-content", validate(value) {
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
          value: { text: "Enregistrer", context: { file: "src/messages.ts", line: 18 } },
          bodyAvailability: "available"
        },
        {
          value: { text: "Avis", context: { file: "legacy/messages.ts", line: 999 } },
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
      `import { defineConfig } from "@lioni/core";

export default defineConfig({
  source: {
    schema: { "~standard": { version: 1, vendor: "facts-journey", validate(value) {
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
      `import { defineConfig, defineQualityCheck } from "@lioni/core";
import baseConfig from "./lioni.config.ts";

const enabledConfigurationSchema = {
  "~standard": {
    version: 1,
    vendor: "facts-journey-qa",
    validate(value) {
      return typeof value === "object" && value !== null && !Array.isArray(value) && typeof value.enabled === "boolean"
        ? { value }
        : { issues: [{ message: "检查器配置必须包含布尔型 enabled 字段。" }] };
    }
  }
};

export default defineConfig({
  ...baseConfig,
  qualityChecks: [defineQualityCheck({
    id: "host-rule",
    configurationSchema: enabledConfigurationSchema,
    configuration: { enabled: true },
    check({ configuration }) {
      return {
        status: configuration.enabled ? "complete" : "not-applicable",
        diagnostics: [],
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
  createQualityRequest(facts) {
    const candidates = facts.associations.flatMap((association) => {
      if (association.status !== "matched") return [];
      const record = facts.translations.records[association.translationIndexes[0]];
      return record?.bodyAvailability !== "available" ? [] : [{
        sourceKey: association.sourceKey,
        language: association.language,
        content: record.content
      }];
    });
    return {
      candidates,
      dependencies: { selectedBy: "defineConfig" },
    };
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
        name: "structured source and translation facts",
        args: ["facts", "lioni.config.ts"],
      },
      {
        name: "readable source and translation facts",
        args: ["facts", "lioni.config.ts", "--output-format", "text"],
      },
      {
        name: "duplicate source identity",
        args: ["facts", "duplicate.config.ts"],
      },
      {
        name: "explicit host QA checker",
        args: ["qa", "qa.config.ts"],
      },
      {
        name: "readable QA candidate summary",
        args: ["qa", "qa.config.ts", "--output-format", "text"],
      },
      {
        name: "QA without a configured checker",
        args: ["qa", "no-checks.config.ts"],
      },
      { name: "help", args: ["--help"] },
      { name: "version", args: ["--version"] },
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
            translation: {
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
        translation: {
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
        translation: {
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
      kind: "failure",
      variant: "duplicateIdentity",
      data: { key: "src/messages.ts:18" },
    });
    assert.equal(qa?.exitCode, 0, `${qa?.stdout ?? ""}${qa?.stderr ?? ""}`);
    assert.equal(qa?.stderr, "");
    const qaResult = JSON.parse(qa?.stdout ?? "") as {
      data: {
        status: string;
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
        checks: readonly { id: string; configuration: { enabled: boolean } }[];
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
    assert.deepEqual(qaResult.data.checks, [
      {
        id: "host-rule",
        configuration: { enabled: true },
        status: "complete",
        diagnostics: [],
        issues: [],
        coverage: {
          selected: 1,
          evaluated: 1,
          notApplicable: 0,
          incomplete: 0,
          failed: 0,
        },
      },
    ]);
    assert.equal(
      qaText?.exitCode,
      0,
      `${qaText?.stdout ?? ""}${qaText?.stderr ?? ""}`,
    );
    assert.equal(qaText?.stderr, "");
    assert.match(qaText?.stdout ?? "", /检查候选：1；诊断：0/u);
    assert.match(qaText?.stdout ?? "", /原文读取：完整；译文读取：fr 完整/u);
    assert.equal(noChecks?.exitCode, 0);
    assert.equal(
      (JSON.parse(noChecks?.stdout ?? "") as { data: { status: string } }).data
        .status,
      "not-run",
    );
    assert.equal(results[6]?.exitCode, 0);
    assert.match(results[6]?.stdout ?? "", /facts/u);
    assert.equal(results[7]?.exitCode, 0);
    assert.equal(results[7]?.stdout, "lioni 0.0.0\n");
  },
};

export default journey;
