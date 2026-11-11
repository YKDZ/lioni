import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { CliJourney } from "../journey.ts";

const journey: CliJourney = {
  name: "qa-exceptions",
  modes: ["source", "distribution"],
  async setup({ workDir, packageRoot, mode }) {
    const sdkImport = mode === "source" ? "@lioni/core" : "@lioni/lioni";
    await writeFile(
      path.join(workDir, "lioni.config.ts"),
      `import { defineConfig } from "${sdkImport}";
import * as z from "zod";

export default defineConfig({
  source: {
    schema: z.object({ id: z.string(), source: z.string() }),
    read: () => ({ scopes: [{
      range: "messages.json",
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
      range: "fr.json",
      covers: ["save"],
      enumeration: "complete",
      records: [{ value: { id: "save", text: "Enregistrer" }, bodyAvailability: "available" }],
    }] }),
  },
});
`,
    );
    await writeFile(
      path.join(workDir, "qa.config.ts"),
      `import { defineChecker, defineConfig } from "${sdkImport}";
import * as z from "zod";
import baseConfig from "./lioni.config.ts";

const inputSchema = z.strictObject({
  enabled: z.boolean(),
  sourceKey: z.string(),
  language: z.string(),
  content: z.string(),
});

const checker = defineChecker({
  id: "review-required",
  version: "qa-exceptions-journey-v1",
  inputSchema,
  load() {
    const enabledBySource = new Map([["save", true]]);
    return {
      enabledBySource,
      isEnabled: (sourceKey) => enabledBySource.get(sourceKey) ?? false,
    };
  },
  prepare({ candidate, loaded }) {
    return {
      status: "ready",
      input: {
        enabled: loaded.isEnabled(candidate.sourceKey),
        sourceKey: candidate.sourceKey,
        language: candidate.language,
        content: candidate.content,
      },
    };
  },
  check(input) {
    const object = {
      kind: "translation-unit",
      key: input.sourceKey,
      language: input.language,
    };
    const location = { language: input.language, range: "fr.json" };
    return {
      status: input.enabled ? "complete" : "not-applicable",
      diagnostics: input.enabled ? [{
        severity: "error",
        object,
        location,
        message: "候选需要人工确认。",
        evidence: [{ role: "candidate", object, location, value: input.content }],
      }] : [],
      issues: [],
      coverage: {
        selected: 1,
        evaluated: input.enabled ? 1 : 0,
        notApplicable: input.enabled ? 0 : 1,
        incomplete: 0,
        failed: 0,
      },
    };
  },
});

export default defineConfig({
  ...baseConfig,
  quality: { checks: [checker] },
});
`,
    );

    const cliPath =
      mode === "source"
        ? path.join(packageRoot, "src", "cli.ts")
        : path.join(packageRoot, "dist", "cli.js");
    const cliArguments = [
      ...(mode === "source" ? ["--conditions=source"] : []),
      cliPath,
      "qa",
      "qa.config.ts",
      "--output-format",
      "structured",
    ];
    const reportProcess = spawnSync(process.execPath, cliArguments, {
      cwd: workDir,
      encoding: "utf8",
    });
    if (reportProcess.error !== undefined) throw reportProcess.error;
    if (reportProcess.status !== 1)
      throw new Error(
        `QA CLI 未按预期生成未通过报告：${reportProcess.stdout}${reportProcess.stderr}`,
      );
    const report = JSON.parse(reportProcess.stdout) as {
      readonly data?: { readonly checks?: readonly unknown[] };
    };
    if (report.data?.checks === undefined)
      throw new Error("QA CLI 未生成包含 checks 的结构化报告。");
    await writeFile(path.join(workDir, "qa-report.json"), reportProcess.stdout);
  },
  commands() {
    return [
      {
        name: "CLI 输出可用于创建例外的结构化 QA 报告",
        args: ["qa", "qa.config.ts", "--output-format", "structured"],
      },
      {
        name: "CLI 根据报告创建例外",
        args: [
          "exceptions",
          "upsert",
          "qa.config.ts",
          "qa-report.json",
          "--check-id",
          "review-required",
          "--execution-id",
          "0",
          "--id",
          "approved-review",
          "--reason",
          "已由维护者确认。",
        ],
      },
      {
        name: "CLI 在后续检查中应用报告例外",
        args: ["qa", "qa.config.ts", "--output-format", "structured"],
      },
    ];
  },
  async assertions({ context, results }) {
    const initial = results[0];
    const upserted = results[1];
    const updated = results[2];
    assert.equal(initial?.exitCode, 1, initial?.stderr ?? "");
    assert.equal(upserted?.exitCode, 0, upserted?.stderr ?? "");
    assert.equal(updated?.exitCode, 0, updated?.stderr ?? "");

    const initialReport = JSON.parse(initial?.stdout ?? "") as {
      readonly data: {
        readonly diagnostics: readonly {
          readonly handling: { readonly status: string };
        }[];
        readonly checks: readonly {
          readonly checkId: string;
          readonly executions: readonly {
            readonly inputFingerprint?: string;
            readonly fingerprintSummary?: Readonly<Record<string, unknown>>;
          }[];
        }[];
      };
    };
    const initialExecution = initialReport.data.checks[0]?.executions[0];
    assert.equal(initialReport.data.checks[0]?.checkId, "review-required");
    assert.ok(initialExecution?.inputFingerprint);
    assert.equal(initialReport.data.diagnostics[0]?.handling.status, "active");
    assert.deepEqual(
      Object.keys(initialExecution?.fingerprintSummary ?? {}).sort(),
      ["inputFingerprint", "version"],
    );
    assert.doesNotMatch(initial?.stdout ?? "", /enabledBySource|isEnabled/u);

    const upsertReport = JSON.parse(upserted?.stdout ?? "") as {
      readonly data: { readonly id: string; readonly executionId: number };
    };
    assert.deepEqual(upsertReport.data, {
      id: "approved-review",
      checkId: "review-required",
      sourceKey: "save",
      language: "fr",
      executionId: 0,
    });

    const updatedReport = JSON.parse(updated?.stdout ?? "") as {
      readonly data: {
        readonly diagnostics: readonly {
          readonly handling: {
            readonly status: string;
            readonly exceptionId?: string;
          };
        }[];
        readonly exceptionApplicability: readonly {
          readonly status: string;
        }[];
      };
    };
    assert.deepEqual(updatedReport.data.diagnostics[0]?.handling, {
      status: "excepted",
      exceptionId: "approved-review",
      reason: "已由维护者确认。",
    });
    assert.equal(
      updatedReport.data.exceptionApplicability[0]?.status,
      "applicable",
    );

    const exceptionFile = await readFile(
      path.join(context.workDir, "lioni.exceptions.yaml"),
      "utf8",
    );
    assert.match(exceptionFile, /^format: lioni\.qa-exceptions\/v2$/mu);
    assert.doesNotMatch(exceptionFile, /configurationFingerprint/u);
  },
};

export default journey;
