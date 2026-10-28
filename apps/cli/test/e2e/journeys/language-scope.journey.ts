import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { CliJourney, CliJourneyResult } from "../journey.ts";

function dataOf(result: CliJourneyResult | undefined) {
  assert.equal(result?.exitCode, 0, result?.stderr);
  assert.equal(result?.stderr, "");
  return JSON.parse(result?.stdout ?? "").data;
}

const journey: CliJourney = {
  name: "language-scope",
  modes: ["source", "distribution"],
  async setup({ workDir }) {
    await writeFile(
      path.join(workDir, "lioni.config.ts"),
      `import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { defineConfig, defineQualityCheck } from "@lioni/core";

const schema = { "~standard": { version: 1, vendor: "language-scope-journey", validate: (value) => ({ value }) } };
const resource = (language) => new URL("./" + language + ".json", import.meta.url);
const check = defineQualityCheck({
  id: "selected-language",
  version: "1",
  configurationSchema: schema,
  configuration: {},
  check({ candidate }) {
    return {
      status: "complete",
      diagnostics: [{
        severity: "warning",
        object: { kind: "translation-unit", key: candidate.sourceKey, language: candidate.language },
        location: { language: candidate.language, range: candidate.language + ".json" },
        message: "已检查所选语言。",
        evidence: [],
      }],
      issues: [],
      coverage: { selected: 1, evaluated: 1, notApplicable: 0, incomplete: 0, failed: 0 },
    };
  },
});

export default defineConfig({
  source: {
    schema,
    read: () => ({ scopes: [{
      range: "source",
      enumeration: "complete",
      records: [{ id: "save", source: "Save" }, { id: "submit", source: "Submit" }]
        .map((value) => ({ value, bodyAvailability: "available" })),
    }] }),
  },
  keyOf: (unit) => unit.id,
  sourceToContent: (source) => source,
  translations: {
    languages: ["fr", "de"],
    schema,
    contentSchema: schema,
    contentOf: (translation) => translation.text,
    identityOf: (translation) => ({ namespace: "messages", key: translation.id }),
    matches: (unit, translation) => unit.id === translation.id,
    read(language, sourceUnits) {
      appendFileSync(new URL("./" + process.env.READ_LOG, import.meta.url), language + "\\n");
      return { scopes: [{
        range: language,
        enumeration: "complete",
        covers: sourceUnits.map(({ key }) => key),
        records: JSON.parse(readFileSync(resource(language), "utf8"))
          .map((value) => ({ value, bodyAvailability: "available" })),
      }] };
    },
  },
  completion: {
    criterion: "存在实际译文",
    resolveCompletion: ({ translations }) => translations.length > 0,
  },
  quality: { checks: [check] },
  translationWriteback: {
    locateExistingTarget: ({ translation }) => ({ status: "located", locator: translation.identity }),
    locateNewTarget: ({ sourceKey, language }) => ({ status: "located", locator: { key: sourceKey, language } }),
    write({ request, target }) {
      if (request.operation !== "write") throw new Error("仅支持写入。");
      const { key, language } = target.locator;
      const records = JSON.parse(readFileSync(resource(language), "utf8"));
      const existing = records.find((record) => record.id === key);
      if (existing === undefined) records.push({ id: key, text: request.content });
      else existing.text = request.content;
      writeFileSync(resource(language), JSON.stringify(records) + "\\n");
    },
  },
});
`,
    );
    await writeFile(
      path.join(workDir, "fr.json"),
      '[{"id":"save","text":"Enregistrer"}]\n',
    );
    await writeFile(
      path.join(workDir, "de.json"),
      '[{"id":"save","text":"Speichern"},{"id":"submit","text":"Senden"}]\n',
    );
  },
  commands() {
    return [
      {
        name: "默认读取配置中的全部语言",
        args: ["inspect", "lioni.config.ts"],
        env: { READ_LOG: "all.log" },
      },
      {
        name: "只读取选中的语言",
        args: ["inspect", "lioni.config.ts", "--language", "fr"],
        env: { READ_LOG: "selected.log" },
      },
      {
        name: "重复参数选择多个语言并去重",
        args: [
          "inspect",
          "lioni.config.ts",
          "--language",
          "de",
          "--language",
          "fr",
          "--language",
          "de",
        ],
        env: { READ_LOG: "multiple.log" },
      },
      {
        name: "未知语言在读取前失败",
        args: ["inspect", "lioni.config.ts", "--language", "es"],
        env: { READ_LOG: "unknown.log" },
      },
      {
        name: "完成统计使用所选语言范围",
        args: ["completion", "lioni.config.ts", "--language", "fr"],
        env: { READ_LOG: "completion.log" },
      },
      {
        name: "QA 只检查所选语言的候选",
        args: [
          "qa",
          "lioni.config.ts",
          "--language",
          "de",
          "--output-format",
          "structured",
        ],
        env: { READ_LOG: "qa.log" },
      },
      {
        name: "更新预览只包含所选语言",
        args: ["update", "lioni.config.ts", "--dry-run", "--language", "fr"],
        env: { READ_LOG: "preview.log" },
      },
      {
        name: "更新只写入并复读所选语言",
        args: ["update", "lioni.config.ts", "--language", "fr"],
        env: { READ_LOG: "update.log" },
      },
    ];
  },
  async assertions({ context, results }) {
    const all = dataOf(results[0]);
    const selected = dataOf(results[1]);
    const multiple = dataOf(results[2]);
    assert.deepEqual(
      all.translations.reads.map((read: { language: string }) => read.language),
      ["fr", "de"],
    );
    assert.deepEqual(
      selected.translations.reads.map(
        (read: { language: string }) => read.language,
      ),
      ["fr"],
    );
    assert.deepEqual(multiple, all);
    assert.equal(results[3]?.exitCode, 1);
    assert.match(results[3]?.stderr ?? "", /es/u);
    const completion = dataOf(results[4]);
    assert.deepEqual(completion.scope.targetLanguages, ["fr"]);
    assert.equal(completion.scope.obligationCount, 2);
    const quality = dataOf(results[5]);
    assert.deepEqual(
      quality.candidates.map(
        (candidate: { language: string }) => candidate.language,
      ),
      ["de", "de"],
    );
    assert.equal(quality.diagnostics.length, 2);
    const plan = dataOf(results[6]);
    assert.equal(plan.items.length, 2);
    assert.equal(
      plan.items.every((item: { language: string }) => item.language === "fr"),
      true,
    );
    const execution = dataOf(results[7]);
    assert.equal(execution.status, "completed");
    assert.equal(
      execution.results.some(
        (result: { status: string }) => result.status === "written",
      ),
      true,
    );
    assert.deepEqual(
      JSON.parse(await readFile(path.join(context.workDir, "fr.json"), "utf8")),
      [
        { id: "save", text: "Enregistrer" },
        { id: "submit", text: "Submit" },
      ],
    );
    assert.equal(
      await readFile(path.join(context.workDir, "de.json"), "utf8"),
      '[{"id":"save","text":"Speichern"},{"id":"submit","text":"Senden"}]\n',
    );
    for (const [file, languages] of [
      ["all.log", ["fr", "de"]],
      ["selected.log", ["fr"]],
      ["multiple.log", ["fr", "de"]],
      ["completion.log", ["fr"]],
      ["qa.log", ["de"]],
      ["preview.log", ["fr"]],
    ] as const) {
      const reads = await readFile(path.join(context.workDir, file), "utf8");
      assert.deepEqual(reads.trim().split("\n"), languages);
    }
    const updateReads = await readFile(
      path.join(context.workDir, "update.log"),
      "utf8",
    );
    assert.deepEqual([...new Set(updateReads.trim().split("\n"))], ["fr"]);
    await assert.rejects(readFile(path.join(context.workDir, "unknown.log")), {
      code: "ENOENT",
    });
  },
};

export default journey;
