import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import type { CliJourney, CliJourneyResult } from "../journey.ts";

function qualityData(result: CliJourneyResult | undefined) {
  assert.equal(result?.exitCode, 0, result?.stderr ?? "");
  return JSON.parse(result?.stdout ?? "").data;
}

const journey: CliJourney = {
  name: "qa-selection-options",
  modes: ["source", "distribution"],
  async setup({ workDir, mode }) {
    const sdkImport = mode === "source" ? "@lioni/core" : "@lioni/lioni";
    await writeFile(
      path.join(workDir, "lioni.config.ts"),
      `import { defineConfig, defineQualityCheck } from "${sdkImport}";
import * as z from "zod";

function checker(id) {
  return defineQualityCheck({
    id,
    version: "qa-selection-options-v1",
    configurationSchema: z.object({}),
    configuration: {},
    check() {
      return {
        status: "complete",
        diagnostics: [],
        issues: [],
        coverage: { selected: 1, evaluated: 1, notApplicable: 0, incomplete: 0, failed: 0 },
      };
    },
  });
}

export default defineConfig({
  source: {
    schema: z.object({ id: z.string(), source: z.string() }),
    read: () => ({ scopes: [{
      range: "source",
      enumeration: "complete",
      records: [{ value: { id: "save", source: "Save" }, bodyAvailability: "available" }],
    }] }),
  },
  keyOf: (unit) => unit.id,
  translations: {
    languages: ["fr"],
    schema: z.object({ id: z.string(), text: z.string() }),
    contentSchema: z.string(),
    contentOf: (translation) => translation.text,
    keyOf: (translation) => translation.id,
    read: () => ({ scopes: [{
      range: "fr",
      covers: ["save"],
      enumeration: "complete",
      records: [{ value: { id: "save", text: "Enregistrer" }, bodyAvailability: "available" }],
    }] }),
  },
  quality: {
    checks: [checker("first"), checker("second")],
    groups: { daily: ["second"] },
  },
});
`,
    );
  },
  commands() {
    return [
      {
        name: "QA 默认执行全部检查项",
        args: ["qa", "lioni.config.ts", "--output-format", "structured"],
      },
      {
        name: "QA 通过检查项 ID 选择子集",
        args: [
          "qa",
          "lioni.config.ts",
          "--check",
          "second",
          "--output-format",
          "structured",
        ],
      },
      {
        name: "QA 接受重复检查项参数",
        args: [
          "qa",
          "lioni.config.ts",
          "--check",
          "first",
          "--check",
          "second",
          "--output-format",
          "structured",
        ],
      },
      {
        name: "QA 通过命名分组选择子集",
        args: [
          "qa",
          "lioni.config.ts",
          "--group",
          "daily",
          "--output-format",
          "structured",
        ],
      },
      {
        name: "QA 拒绝同时选择检查项和分组",
        args: ["qa", "lioni.config.ts", "--check", "first", "--group", "daily"],
      },
      {
        name: "QA 文本报告显示已选检查项范围",
        args: ["qa", "lioni.config.ts", "--check", "second"],
      },
    ];
  },
  async assertions({ results }) {
    const all = qualityData(results[0]);
    const selected = qualityData(results[1]);
    const repeatedChecks = qualityData(results[2]);
    const selectedGroup = qualityData(results[3]);
    assert.deepEqual(
      all.checks.map(({ checkId }: { readonly checkId: string }) => checkId),
      ["first", "second"],
    );
    assert.deepEqual(all.checkScope, {
      configuredCount: 2,
      selectedIds: ["first", "second"],
    });
    assert.deepEqual(
      selected.checks.map(
        ({ checkId }: { readonly checkId: string }) => checkId,
      ),
      ["second"],
    );
    assert.deepEqual(selected.checkScope, {
      configuredCount: 2,
      selectedIds: ["second"],
    });
    assert.deepEqual(
      repeatedChecks.checks.map(
        ({ checkId }: { readonly checkId: string }) => checkId,
      ),
      ["first", "second"],
    );
    assert.deepEqual(
      selectedGroup.checks.map(
        ({ checkId }: { readonly checkId: string }) => checkId,
      ),
      ["second"],
    );
    assert.deepEqual(selectedGroup.checkScope, {
      configuredCount: 2,
      selectedIds: ["second"],
    });

    const conflictingSelection = results[4];
    assert.equal(conflictingSelection?.exitCode, 2);
    const usageFailure = JSON.parse(
      `${conflictingSelection?.stdout ?? ""}${conflictingSelection?.stderr ?? ""}`,
    ) as {
      readonly kind: string;
      readonly issues: readonly { readonly code: string }[];
    };
    assert.equal(usageFailure.kind, "usageFailure");
    assert.deepEqual(
      usageFailure.issues.map(({ code }) => code),
      ["forbiddenCombinationViolation"],
    );

    const readable = results[5];
    assert.equal(readable?.exitCode, 0, readable?.stderr ?? "");
    assert.match(
      readable?.stdout ?? "",
      /检查项范围：配置 2 项，本次子集 1 项（second）/u,
    );
    assert.match(readable?.stdout ?? "", /候选范围：已选候选 1 条/u);
  },
};

export default journey;
