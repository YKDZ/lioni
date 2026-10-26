import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { evaluateCompletion, readCompletion, readFacts } from "@lioni/core";

import completionConfig from "./completion.config.ts";

const initial = await readCompletion(completionConfig);
assert.equal(initial.completion.status, "incomplete");
assert.equal(initial.completion.scope.sourceUnitCount, 2);
assert.equal(initial.completion.scope.targetLanguages.join(","), "fr,de");
assert.equal(initial.completion.scope.obligationCount, 4);
assert.equal(initial.completion.confirmedIncompleteCount, 4);
assert.equal(initial.completion.completionRate, 0);

const fixedFacts = await readFacts(completionConfig);
const completionPolicy = completionConfig.completion;
assert.ok(completionPolicy);
const reused = await evaluateCompletion(fixedFacts, completionPolicy);
assert.equal(reused.factsVersion, fixedFacts.version);
assert.equal(reused.status, "incomplete");

const resourcePath = fileURLToPath(
  new URL("./completion-resources/fr.json", import.meta.url),
);
await writeFile(
  resourcePath,
  JSON.stringify([
    { id: "fr-save", text: "Save", context: { sourceLine: 18 } },
  ]),
  "utf8",
);
const executable = path.join(
  process.cwd(),
  "node_modules",
  ".bin",
  process.platform === "win32" ? "lioni.cmd" : "lioni",
);
const updated = spawnSync(executable, ["completion", "completion.config.ts"], {
  encoding: "utf8",
  shell: process.platform === "win32",
});
assert.equal(updated.status, 0, updated.stderr);
const report = JSON.parse(updated.stdout).data;
assert.notEqual(report.factsVersion, initial.completion.factsVersion);
assert.equal(report.confirmedCompleteCount, 1);
assert.equal(report.confirmedIncompleteCount, 3);
assert.equal(report.completionRate, 0.25);
assert.deepEqual(report.obligations[0].translationIndexes, [0]);

const readable = spawnSync(
  executable,
  ["completion", "completion.config.ts", "--output-format", "text"],
  { encoding: "utf8", shell: process.platform === "win32" },
);
assert.equal(readable.status, 0, readable.stderr);
assert.ok(readable.stdout.includes("完成率：25.0%"));
