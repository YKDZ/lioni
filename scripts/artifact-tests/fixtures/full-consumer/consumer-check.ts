import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  analyzeQuality,
  DuplicateTranslationUnitKeyError,
  readFacts,
  readSourceFacts,
} from "@lioni/core";
import "@lioni/checks";

import config, { translationReadCount } from "./lioni.config.ts";
import qaConfig from "./qa.config.ts";
import { parseJson, standardSchema } from "./schemas.ts";

const repositoryRoot = process.env.LIONI_REPOSITORY_ROOT!;
const sourceFacts = await readSourceFacts(config);
const firstSourceFact = sourceFacts.units[0];
assert.ok(firstSourceFact);
assert.equal(translationReadCount, 0);
assert.equal(sourceFacts.read.status, "complete");
assert.equal(sourceFacts.totalUnitCount, 4);
assert.equal(firstSourceFact.key, "src/messages.ts:18");
assert.equal(firstSourceFact.unit.context.screenshot, "shots/save.png");

const facts = await readFacts(config);
assert.equal(translationReadCount, 3);
assert.match(facts.version, /^sha256:[a-f0-9]{64}$/u);
assert.equal(facts.source.totalUnitCount, 4);
assert.deepEqual(
  facts.translations.reads.map(({ language, status }) => [language, status]),
  [
    ["fr", "incomplete"],
    ["ja", "complete"],
    ["de", "failed"],
  ],
);
assert.deepEqual(
  facts.associations.map(
    ({ sourceKey, language, status, coverageStatus, translationIndexes }) => [
      sourceKey,
      language,
      status,
      coverageStatus,
      translationIndexes,
    ],
  ),
  [
    ["src/messages.ts:18", "fr", "unknown", "incomplete", [0]],
    ["src/messages.ts:19", "fr", "unknown", "incomplete", [0]],
    ["src/messages.ts:20", "fr", "conflict", "incomplete", [1, 2]],
    ["src/messages.ts:21", "fr", "missing", "complete", []],
    ["src/messages.ts:18", "ja", "matched", "complete", [4]],
    ["src/messages.ts:19", "ja", "matched", "complete", [4]],
    ["src/messages.ts:20", "ja", "unavailable", "complete", [5]],
    ["src/messages.ts:21", "ja", "matched", "complete", [7]],
    ["src/messages.ts:18", "de", "unknown", "failed", []],
    ["src/messages.ts:19", "de", "unknown", "failed", []],
    ["src/messages.ts:20", "de", "unknown", "failed", []],
    ["src/messages.ts:21", "de", "unknown", "failed", []],
  ],
);
assert.equal(facts.translations.records.length, 8);
const firstTranslation = facts.translations.records[0];
const fourthTranslation = facts.translations.records[3];
const seventhTranslation = facts.translations.records[6];
assert.ok(firstTranslation);
assert.ok(fourthTranslation);
assert.ok(seventhTranslation);
assert.deepEqual(firstTranslation.translation.context.sourceLines, [18, 19]);
assert.deepEqual(fourthTranslation.translation.context.sourceLines, []);
assert.deepEqual(seventhTranslation.translation.context.sourceLines, []);

type DuplicateCaseUnit = {
  readonly source: string;
  readonly context: { readonly file: string };
};
const duplicateCaseSchema = standardSchema<DuplicateCaseUnit>(
  (value): value is DuplicateCaseUnit =>
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "source" in value &&
    typeof value.source === "string" &&
    "context" in value &&
    typeof value.context === "object" &&
    value.context !== null &&
    !Array.isArray(value.context) &&
    "file" in value.context &&
    typeof value.context.file === "string",
);
await assert.rejects(
  readSourceFacts({
    source: {
      schema: duplicateCaseSchema,
      read: () => ({
        scopes: [
          {
            range: "src/messages.ts",
            enumeration: "complete",
            records: [
              {
                value: { source: "Save", context: { file: "src/messages.ts" } },
                bodyAvailability: "available",
              },
              {
                value: {
                  source: "Submit",
                  context: { file: "src/messages.ts" },
                },
                bodyAvailability: "available",
              },
            ],
          },
        ],
      }),
    },
    keyOf: (unit: DuplicateCaseUnit) => unit.context.file,
  }),
  DuplicateTranslationUnitKeyError,
);

for (const packageName of ["@lioni/core", "@lioni/checks"]) {
  const resolved = fileURLToPath(import.meta.resolve(packageName));
  assert.ok(!resolved.startsWith(repositoryRoot + path.sep), resolved);
}
const cliPackage = await realpath(
  path.join(process.cwd(), "node_modules", "@lioni", "cli"),
);
assert.ok(!cliPackage.startsWith(repositoryRoot + path.sep), cliPackage);

const executable = path.join(
  process.cwd(),
  "node_modules",
  ".bin",
  process.platform === "win32" ? "lioni.cmd" : "lioni",
);
const structured = spawnSync(executable, ["facts", "lioni.config.ts"], {
  encoding: "utf8",
  shell: process.platform === "win32",
});
assert.equal(structured.status, 0, structured.stderr);
assert.equal(JSON.parse(structured.stdout).schemaVersion, "2");
assert.deepEqual(JSON.parse(structured.stdout).data, facts);
const readable = spawnSync(
  executable,
  ["facts", "lioni.config.ts", "--output-format", "text"],
  { encoding: "utf8", shell: process.platform === "win32" },
);
assert.equal(readable.status, 0, readable.stderr);
const firstUnit = facts.source.units[0];
assert.ok(firstUnit);
for (const content of [
  facts.version,
  firstUnit.key,
  "shots/save.png",
  "unknown",
  "conflict",
  "missing",
  "unavailable",
  "German catalogue unavailable",
])
  assert.ok(readable.stdout.includes(content));
const duplicate = spawnSync(executable, ["facts", "duplicate.config.ts"], {
  encoding: "utf8",
  shell: process.platform === "win32",
});
assert.equal(duplicate.status, 1);
assert.equal(JSON.parse(duplicate.stderr).schemaVersion, "2");
assert.equal(JSON.parse(duplicate.stderr).variant, "duplicateIdentity");
assert.equal(JSON.parse(duplicate.stderr).data.key, "src/messages.ts");

const noChecks = spawnSync(executable, ["qa", "lioni.config.ts"], {
  encoding: "utf8",
  shell: process.platform === "win32",
});
assert.equal(noChecks.status, 0, noChecks.stderr);
assert.equal(JSON.parse(noChecks.stdout).data.status, "not-run");

const qaResource = path.join(process.cwd(), "qa-messages.json");
const baselinePath = path.join(process.cwd(), "lioni.baseline.json");
const baselineSnapshot = Buffer.from('{"sentinel":"preserve during QA"}\n');
const originalResource = Buffer.from(
  JSON.stringify({
    messages: [
      { sourceId: "save", nativeKey: "save_label", text: "Bonjour" },
      { sourceId: "submit", nativeKey: "submit_button", text: "Enregistrer" },
    ],
  }),
);
await writeFile(qaResource, JSON.stringify({ messages: [] }));
const skippedQa = spawnSync(executable, ["qa", "qa.config.ts"], {
  encoding: "utf8",
  shell: process.platform === "win32",
});
assert.equal(skippedQa.status, 0, skippedQa.stderr + skippedQa.stdout);
type QaCliResult = {
  readonly version: string;
  readonly status: string;
  readonly candidates: readonly unknown[];
  readonly factCoverage: {
    readonly associations: readonly {
      readonly sourceKey: string;
      readonly status: string;
      readonly candidateSelected: boolean;
    }[];
  };
  readonly diagnostics: readonly {
    readonly checkId: string;
    readonly evidence: readonly unknown[];
    readonly object: { readonly key: string };
    readonly location: { readonly key: string };
    readonly handling: Readonly<Record<string, unknown>>;
  }[];
  readonly exceptions: readonly unknown[];
  readonly exceptionApplicability: readonly {
    readonly exceptionId: string;
    readonly checkId: string;
    readonly sourceKey: string;
    readonly language: string;
    readonly executionId?: number;
    readonly candidateIndex?: number;
    readonly status: string;
    readonly reasons?: readonly string[];
  }[];
  readonly checks: readonly {
    readonly checkId: string;
    readonly executions: readonly {
      readonly executionId: number;
      readonly candidateIndex: number;
      readonly checkId: string;
      readonly sourceKey: string;
      readonly language: string;
      readonly status: string;
      readonly inputFingerprint?: string;
      readonly fingerprintSummary?: {
        readonly version: string;
        readonly configurationFingerprint: string;
        readonly inputFingerprint: string;
      };
    }[];
  }[];
};
const skippedResult = parseJson<{ data: QaCliResult }>(skippedQa.stdout).data;
assert.equal(skippedResult.status, "not-run");
assert.deepEqual(skippedResult.candidates, []);
assert.deepEqual(
  skippedResult.factCoverage.associations.map(
    ({ status, candidateSelected }) => [status, candidateSelected],
  ),
  [
    ["missing", false],
    ["missing", false],
  ],
);
const readableSkippedQa = spawnSync(
  executable,
  ["qa", "qa.config.ts", "--output-format", "text"],
  { encoding: "utf8", shell: process.platform === "win32" },
);
assert.equal(readableSkippedQa.status, 0, readableSkippedQa.stderr);
assert.ok(readableSkippedQa.stdout.includes("质量检查：未执行"));
assert.ok(readableSkippedQa.stdout.includes("关联 sha256:save → fr：missing"));
await writeFile(qaResource, originalResource);
await writeFile(baselinePath, baselineSnapshot);
const initialQa = spawnSync(executable, ["qa", "qa.config.ts"], {
  encoding: "utf8",
  shell: process.platform === "win32",
});
assert.equal(initialQa.status, 0, initialQa.stderr + initialQa.stdout);
const initialResult = parseJson<{ data: QaCliResult }>(initialQa.stdout).data;
assert.equal(initialResult.status, "complete");
assert.deepEqual(initialResult.candidates, [
  { sourceKey: "sha256:save", language: "fr", content: "Bonjour" },
]);
assert.deepEqual(
  initialResult.factCoverage.associations.map(
    ({ sourceKey, status, candidateSelected }) => [
      sourceKey,
      status,
      candidateSelected,
    ],
  ),
  [
    ["sha256:save", "matched", true],
    ["sha256:submit", "matched", false],
  ],
);
assert.equal(initialResult.diagnostics.length, 1);
const initialDiagnostic = initialResult.diagnostics[0];
assert.ok(initialDiagnostic);
assert.equal(initialDiagnostic.checkId, "number-correspondence");
assert.equal(initialDiagnostic.evidence.length, 2);
assert.equal(initialDiagnostic.object.key, "sha256:save");
assert.equal(initialDiagnostic.location.key, "save_label");
assert.deepEqual(initialDiagnostic.handling, { status: "active" });
assert.deepEqual(initialResult.exceptions, []);
assert.deepEqual(initialResult.exceptionApplicability, []);
const initialExecution = initialResult.checks.find(
  ({ checkId }) => checkId === "number-correspondence",
)?.executions[0];
assert.ok(initialExecution?.inputFingerprint);
assert.ok(initialExecution.fingerprintSummary);
const handwrittenException = [
  "format: lioni.qa-exceptions/v1",
  "exceptions:",
  "  - id: approved-number-difference",
  "    reason: 数字差异已由维护者确认。",
  "    checkId: number-correspondence",
  "    sourceKey: sha256:save",
  "    language: fr",
  `    inputFingerprint: ${initialExecution.inputFingerprint}`,
  "    fingerprintSummary:",
  `      version: ${JSON.stringify(initialExecution.fingerprintSummary.version)}`,
  `      configurationFingerprint: ${initialExecution.fingerprintSummary.configurationFingerprint}`,
  `      inputFingerprint: ${initialExecution.fingerprintSummary.inputFingerprint}`,
  "",
].join("\n");
const exceptionPath = path.join(process.cwd(), "lioni.exceptions.yaml");
const exceptionSnapshot = Buffer.from(handwrittenException);
await writeFile(exceptionPath, handwrittenException, "utf8");
const exceptedQa = spawnSync(executable, ["qa", "qa.config.ts"], {
  encoding: "utf8",
  shell: process.platform === "win32",
});
assert.equal(exceptedQa.status, 0, exceptedQa.stderr + exceptedQa.stdout);
const exceptedResult = parseJson<{ data: QaCliResult }>(exceptedQa.stdout).data;
assert.equal(exceptedResult.diagnostics.length, 1);
assert.deepEqual(exceptedResult.diagnostics[0]?.handling, {
  status: "excepted",
  exceptionId: "approved-number-difference",
  reason: "数字差异已由维护者确认。",
});
assert.deepEqual(exceptedResult.exceptionApplicability, [
  {
    exceptionId: "approved-number-difference",
    checkId: "number-correspondence",
    sourceKey: "sha256:save",
    language: "fr",
    executionId: 0,
    candidateIndex: 0,
    status: "applicable",
  },
]);
assert.deepEqual(await readFile(baselinePath), baselineSnapshot);
assert.deepEqual(await readFile(exceptionPath), exceptionSnapshot);
assert.deepEqual(await readFile(qaResource), originalResource);

const readableQa = spawnSync(
  executable,
  ["qa", "qa.config.ts", "--output-format", "text"],
  { encoding: "utf8", shell: process.platform === "win32" },
);
assert.equal(readableQa.status, 0, readableQa.stderr);
assert.ok(readableQa.stdout.includes("位置键 save_label"));
assert.ok(
  readableQa.stdout.includes(
    "例外 approved-number-difference：数字差异已由维护者确认。",
  ),
);
assert.ok(
  readableQa.stdout.includes(
    "QA 例外 approved-number-difference number-correspondence sha256:save → fr（候选 1，执行 0）：适用。",
  ),
);

const reorderedNumbers = await analyzeQuality(qaConfig, {
  candidates: [
    { sourceKey: "sha256:save", language: "fr", content: "3.14 puis 12" },
  ],
});
assert.equal(reorderedNumbers.status, "complete");
assert.deepEqual(reorderedNumbers.diagnostics, []);
const repeatedNumber = await analyzeQuality(qaConfig, {
  candidates: [
    { sourceKey: "sha256:save", language: "fr", content: "3.14, 12, 12" },
  ],
});
assert.equal(repeatedNumber.diagnostics[0]?.message, "译文多出数字：12。");

const editedResource = Buffer.from(
  JSON.stringify({
    messages: [
      { sourceId: "save", nativeKey: "save_label", text: "Bonjour 3.14 et 12" },
      { sourceId: "submit", nativeKey: "submit_button", text: "Bonjour" },
    ],
  }),
);
await writeFile(qaResource, editedResource);
const editedQa = spawnSync(executable, ["qa", "qa.config.ts"], {
  encoding: "utf8",
  shell: process.platform === "win32",
});
assert.equal(editedQa.status, 0, editedQa.stderr);
const editedResult = JSON.parse(editedQa.stdout).data;
assert.equal(editedResult.status, "complete");
assert.notEqual(editedResult.version, initialResult.version);
assert.deepEqual(editedResult.diagnostics, []);
assert.deepEqual(editedResult.exceptionApplicability, [
  {
    exceptionId: "approved-number-difference",
    checkId: "number-correspondence",
    sourceKey: "sha256:save",
    language: "fr",
    executionId: 0,
    candidateIndex: 0,
    status: "basis-changed",
    reasons: ["business-input"],
  },
]);
const readableEditedQa = spawnSync(
  executable,
  ["qa", "qa.config.ts", "--output-format", "text"],
  { encoding: "utf8", shell: process.platform === "win32" },
);
assert.equal(readableEditedQa.status, 0, readableEditedQa.stderr);
assert.ok(
  readableEditedQa.stdout.includes(
    "QA 例外 approved-number-difference number-correspondence sha256:save → fr（候选 1，执行 0）：依据变化（业务输入变化）。",
  ),
);
assert.deepEqual(await readFile(baselinePath), baselineSnapshot);
assert.deepEqual(await readFile(exceptionPath), exceptionSnapshot);
assert.deepEqual(await readFile(qaResource), editedResource);

process.stdout.write(
  "独立打包宿主：事实API、完成API、显式QA、基线Node子入口、外部编辑重算和只读检查通过。\n",
);
