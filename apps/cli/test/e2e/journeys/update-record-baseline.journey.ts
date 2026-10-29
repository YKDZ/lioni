import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { CliJourney, CliJourneyResult } from "../journey.ts";

function dataOf(result: CliJourneyResult | undefined) {
  assert.equal(result?.exitCode, 0, result?.stderr);
  assert.equal(result?.stderr, "");
  return JSON.parse(result?.stdout ?? "").data;
}

const journey: CliJourney = {
  name: "update-record-baseline",
  modes: ["source", "distribution"],
  async setup({ workDir, mode }) {
    const sdkImport = mode === "source" ? "@lioni/core" : "@lioni/lioni";
    await writeFile(
      path.join(workDir, "lioni.config.ts"),
      `import { readFileSync, writeFileSync } from "node:fs";
import { defineConfig } from "${sdkImport}";

const schema = { "~standard": { version: 1, vendor: "update-record-baseline", validate: (value) => ({ value }) } };
const resource = (language) => new URL("./" + language + ".json", import.meta.url);

export default defineConfig({
  source: {
    schema,
    read: () => ({ scopes: [{ range: "source", enumeration: "complete", records: [
      { id: "welcome", source: "Welcome" },
    ].map((value) => ({ value, bodyAvailability: "available" })) }] }),
  },
  keyOf: (unit) => unit.id,
  translations: {
    languages: ["fr", "ja"],
    schema,
    contentSchema: schema,
    keyOf: (translation) => ({ namespace: "messages", key: translation.id }),
    contentOf: (translation) => translation.text,
    matches: (unit, translation) => unit.id === translation.id,
    read: (language, sourceUnits) => ({ scopes: [{
      range: language,
      covers: sourceUnits.map(({ key }) => key),
      enumeration: "complete",
      records: JSON.parse(readFileSync(resource(language), "utf8"))
        .map((value) => ({ value, bodyAvailability: "available" })),
    }] }),
  },
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
    await writeFile(path.join(workDir, "fr.json"), "[]\n");
    await writeFile(path.join(workDir, "ja.json"), "[]\n");
    const partialDir = path.join(workDir, "partial");
    await mkdir(partialDir);
    await writeFile(
      path.join(partialDir, "lioni.config.ts"),
      await readFile(path.join(workDir, "lioni.config.ts"), "utf8"),
    );
    await writeFile(path.join(partialDir, "fr.json"), "[]\n");
    await writeFile(path.join(partialDir, "ja.json"), "[]\n");
  },
  commands() {
    return [
      {
        name: "部分语言拒绝记录共享基线",
        args: [
          "update",
          "partial/lioni.config.ts",
          "--record-baseline",
          "--language",
          "fr",
        ],
      },
      {
        name: "全语言更新后记录基线",
        args: ["update", "lioni.config.ts", "--record-baseline"],
      },
      {
        name: "显式列出全部语言且无变化",
        args: [
          "update",
          "lioni.config.ts",
          "--record-baseline",
          "--language",
          "ja",
          "--language",
          "fr",
        ],
      },
      {
        name: "文本报告基线没有变化",
        args: [
          "update",
          "lioni.config.ts",
          "--record-baseline",
          "--output-format",
          "text",
        ],
      },
    ];
  },
  async assertions({ context, results }) {
    const baselinePath = path.join(context.workDir, "lioni.baseline.json");
    const partialDir = path.join(context.workDir, "partial");
    const partial = results[0];
    assert.equal(partial?.exitCode, 1);
    assert.deepEqual(
      JSON.parse(await readFile(path.join(partialDir, "fr.json"), "utf8")),
      [],
    );
    assert.deepEqual(
      JSON.parse(await readFile(path.join(partialDir, "ja.json"), "utf8")),
      [],
    );
    await assert.rejects(
      readFile(path.join(partialDir, "lioni.baseline.json")),
      { code: "ENOENT" },
    );

    const saved = dataOf(results[1]);
    assert.equal(saved.status, "completed");
    assert.equal(saved.baseline?.outcome, "saved");
    assert.deepEqual(
      JSON.parse(await readFile(path.join(context.workDir, "fr.json"), "utf8")),
      [{ id: "welcome", text: "Welcome" }],
    );
    assert.deepEqual(
      JSON.parse(await readFile(path.join(context.workDir, "ja.json"), "utf8")),
      [{ id: "welcome", text: "Welcome" }],
    );
    const savedBaseline = await readFile(baselinePath, "utf8");
    const snapshot = JSON.parse(savedBaseline).snapshot;
    assert.deepEqual(
      snapshot.translations.reads.map(
        (read: { language: string }) => read.language,
      ),
      ["fr", "ja"],
    );

    const unchanged = dataOf(results[2]);
    assert.equal(unchanged.status, "completed");
    assert.equal(unchanged.baseline?.outcome, "unchanged");
    assert.equal(await readFile(baselinePath, "utf8"), savedBaseline);
    assert.equal(results[3]?.exitCode, 0, results[3]?.stderr);
    assert.match(results[3]?.stdout ?? "", /比较基线没有变化/u);
  },
};

export default journey;
