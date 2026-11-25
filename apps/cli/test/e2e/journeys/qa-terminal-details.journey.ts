import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import type { CliJourney } from "../journey.ts";

const journey: CliJourney = {
  name: "qa-terminal-details",
  modes: ["source", "distribution"],
  async setup({ workDir, sdkImport }) {
    const keys = ["k1", "k2", "k3", "k4", "k5"];
    await writeFile(
      path.join(workDir, "lioni.config.ts"),
      `import { defineConfig, defineChecker } from "${sdkImport}";
import * as z from "zod";

const keys = ${JSON.stringify(keys)};

const toneChecker = defineChecker({
  id: "tone",
  version: "1",
  inputSchema: z.object({ key: z.string(), language: z.string() }),
  prepare: ({ association }) => ({
    key: association.sourceKey,
    language: association.language,
  }),
  check({ key, language }) {
    const specs = {
      k1: { severity: "warning", message: "警告一" },
      k2: { severity: "warning", message: "警告二" },
      k3: { severity: "error", message: "错误一" },
      k4: { severity: "info", message: "提示一" },
    };
    const spec = specs[key];
    if (spec === undefined) return [];
    return [
      {
        severity: spec.severity,
        object: { kind: "translation-unit", key, language },
        location: { language, range: "fr.json", key },
        message: spec.message,
        evidence: [],
      },
    ];
  },
});

const styleChecker = defineChecker({
  id: "style",
  version: "1",
  inputSchema: z.object({ key: z.string(), language: z.string() }),
  prepare: ({ association }) => ({
    key: association.sourceKey,
    language: association.language,
  }),
  check({ key, language }) {
    if (key !== "k5") return [];
    return [
      {
        severity: "info",
        object: { kind: "translation-unit", key, language },
        location: { language, range: "fr.json", key },
        message: "样式提示",
        evidence: [],
      },
    ];
  },
});

export default defineConfig({
  source: {
    schema: z.object({ id: z.string(), source: z.string() }),
    read: () => ({
      scopes: [
        {
          range: "source",
          enumeration: "complete",
          records: keys.map((id) => ({
            value: { id, source: "Text " + id },
            bodyAvailability: "available",
          })),
        },
      ],
    }),
  },
  keyOf: (unit) => unit.id,
  translations: {
    languages: ["fr"],
    schema: z.object({ id: z.string(), text: z.string() }),
    contentSchema: z.string(),
    contentOf: (translation) => translation.text,
    keyOf: (translation) => translation.id,
    read: () => ({
      scopes: [
        {
          range: "fr.json",
          covers: keys,
          enumeration: "complete",
          records: keys.map((id) => ({
            value: { id, text: "Texte " + id },
            bodyAvailability: "available",
          })),
        },
      ],
    }),
  },
  quality: {
    checks: [toneChecker, styleChecker],
  },
});
`,
    );
  },
  commands() {
    return [
      {
        name: "查询 QA 输入契约",
        args: ["qa", "--schema=input"],
      },
      {
        name: "默认展开全部明细",
        args: ["qa", "lioni.config.ts"],
      },
      {
        name: "单选 --severity warning 隐藏错误仍以 1 退出",
        args: ["qa", "lioni.config.ts", "--severity", "warning"],
      },
      {
        name: "多选 --severity warning --severity error 取并集",
        args: [
          "qa",
          "lioni.config.ts",
          "--severity",
          "warning",
          "--severity",
          "error",
        ],
      },
      {
        name: "联合筛选并按每项检查上限 1 折叠",
        args: [
          "qa",
          "lioni.config.ts",
          "--severity",
          "warning",
          "--severity",
          "error",
          "--max-per-check",
          "1",
        ],
      },
      {
        name: "结构化输出不受筛选与折叠参数影响",
        args: [
          "qa",
          "lioni.config.ts",
          "--severity",
          "warning",
          "--severity",
          "error",
          "--max-per-check",
          "1",
          "--output",
          "structured",
        ],
      },
      {
        name: "默认结构化输出基线",
        args: ["qa", "lioni.config.ts", "--output", "structured"],
      },
      {
        name: "拒绝未知严重度取值",
        args: ["qa", "lioni.config.ts", "--severity", "critical"],
      },
      {
        name: "拒绝非正整数上限",
        args: ["qa", "lioni.config.ts", "--max-per-check", "0"],
      },
    ];
  },
  async assertions({ results }) {
    const schemaInput = results[0];
    assert.equal(schemaInput?.exitCode, 0, schemaInput?.stderr ?? "");
    const inputDoc = JSON.parse(schemaInput?.stdout ?? "") as {
      readonly fields: readonly { readonly key: string }[];
      readonly input: {
        readonly inputSchema: {
          readonly properties: Readonly<Record<string, unknown>>;
        };
      };
    };
    assert.ok(inputDoc.fields.some(({ key }) => key === "severity"));
    assert.ok(inputDoc.fields.some(({ key }) => key === "maxPerCheck"));
    assert.ok("severity" in inputDoc.input.inputSchema.properties);
    assert.ok("maxPerCheck" in inputDoc.input.inputSchema.properties);

    const defaultRun = results[1];
    assert.equal(defaultRun?.exitCode, 1, defaultRun?.stderr ?? "");
    assert.ok(defaultRun?.stdout.includes("警告一"));
    assert.ok(defaultRun?.stdout.includes("警告二"));
    assert.ok(defaultRun?.stdout.includes("错误一"));
    assert.ok(defaultRun?.stdout.includes("提示一"));
    assert.ok(defaultRun?.stdout.includes("样式提示"));
    assert.doesNotMatch(defaultRun?.stdout ?? "", /被省略/u);

    const warningOnly = results[2];
    assert.equal(warningOnly?.exitCode, 1, warningOnly?.stderr ?? "");
    assert.ok(
      warningOnly?.stdout.includes(
        "有效问题：错误 1，警告 2，提示 2；已豁免 0",
      ),
    );
    assert.ok(warningOnly?.stdout.includes("翻译进度 fr：0/5（0%）"));
    assert.ok(warningOnly?.stdout.includes("警告一"));
    assert.ok(warningOnly?.stdout.includes("警告二"));
    assert.doesNotMatch(
      warningOnly?.stdout ?? "",
      /错误一|提示一|样式提示|被省略/u,
    );

    const unionRun = results[3];
    assert.equal(unionRun?.exitCode, 1, unionRun?.stderr ?? "");
    assert.ok(unionRun?.stdout.includes("警告一"));
    assert.ok(unionRun?.stdout.includes("警告二"));
    assert.ok(unionRun?.stdout.includes("错误一"));
    assert.doesNotMatch(unionRun?.stdout ?? "", /提示一|样式提示|被省略/u);

    const foldedRun = results[4];
    assert.equal(foldedRun?.exitCode, 1, foldedRun?.stderr ?? "");
    assert.ok(
      foldedRun?.stdout.includes("有效问题：错误 1，警告 2，提示 2；已豁免 0"),
    );
    assert.ok(foldedRun?.stdout.includes("翻译进度 fr：0/5（0%）"));
    assert.ok(foldedRun?.stdout.includes("警告一"));
    assert.doesNotMatch(
      foldedRun?.stdout ?? "",
      /警告二|错误一|提示一|样式提示/u,
    );
    assert.match(
      foldedRun?.stdout ?? "",
      /tone：另有 2 条匹配明细因上限（1）被省略/u,
    );
    assert.doesNotMatch(foldedRun?.stdout ?? "", /style.*被省略/u);

    const structuredFiltered = results[5];
    const structuredDefault = results[6];
    assert.equal(
      structuredFiltered?.exitCode,
      1,
      structuredFiltered?.stderr ?? "",
    );
    assert.equal(
      structuredDefault?.exitCode,
      1,
      structuredDefault?.stderr ?? "",
    );
    assert.deepEqual(
      JSON.parse(structuredFiltered?.stdout ?? ""),
      JSON.parse(structuredDefault?.stdout ?? ""),
    );

    const invalidSeverity = results[7];
    assert.equal(invalidSeverity?.exitCode, 2);
    assert.equal(
      JSON.parse(invalidSeverity?.stderr ?? "").issues[0]?.code,
      "invalidFieldChoice",
    );

    const invalidMax = results[8];
    assert.equal(invalidMax?.exitCode, 2);
    assert.equal(JSON.parse(invalidMax?.stderr ?? "").kind, "usageFailure");
  },
};

export default journey;
