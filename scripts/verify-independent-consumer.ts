import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const packageNames = ["@l10n/core", "@l10n/checks", "@l10n/cli"] as const;

type CommandResult = {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
};

function run(
  executable: string,
  args: readonly string[],
  cwd: string,
): CommandResult {
  const result = spawnSync(executable, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    shell: process.platform === "win32",
  });
  if (result.error !== undefined)
    throw new Error(`无法运行 ${executable} ${args.join(" ")}`, {
      cause: result.error,
    });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function runChecked(
  executable: string,
  args: readonly string[],
  cwd: string,
): CommandResult {
  const result = run(executable, args, cwd);
  if (result.status !== 0)
    throw new Error(
      `${executable} ${args.join(" ")} 失败（退出码 ${result.status}）\n${result.stdout}${result.stderr}`,
    );
  return result;
}

async function writeConsumerFiles(
  consumerRoot: string,
  artifactRoot: string,
): Promise<void> {
  const packageFiles = packageNames.map((packageName) => {
    const shortName = packageName.slice("@l10n/".length);
    const tarball = path.join(artifactRoot, `l10n-${shortName}-0.0.0.tgz`);
    const relativeTarball = path
      .relative(consumerRoot, tarball)
      .split(path.sep)
      .join("/");
    return [packageName, `file:${relativeTarball}`];
  });
  const dependencies = Object.fromEntries(packageFiles);
  const packageJson = {
    name: "l10n-independent-consumer",
    private: true,
    packageManager: "pnpm@12.9.1",
    type: "module",
    dependencies,
    devDependencies: {
      "@types/node": "24.19.2",
    },
  };
  const coreTarball = path
    .relative(consumerRoot, path.join(artifactRoot, "l10n-core-0.0.0.tgz"))
    .split(path.sep)
    .join("/");
  const workspaceConfig = `overrides:\n  "@l10n/core@0.0.0": "file:${coreTarball}"\n`;
  const configSource = `import { defineConfig } from "@l10n/core";

export let translationReadCount = 0;

const config = defineConfig({
  source: {
    read: () => ({
      scopes: [{
        range: "src/messages.ts",
        enumeration: "complete",
        records: [
          { value: { source: "Save", context: { file: "src/messages.ts", line: 18, screenshot: "shots/save.png" } }, bodyAvailability: "available" },
          { value: { source: "Submit", context: { file: "src/messages.ts", line: 19, screenshot: "shots/submit.png" } }, bodyAvailability: "available" },
          { value: { source: "Cancel", context: { file: "src/messages.ts", line: 20, screenshot: "shots/cancel.png" } }, bodyAvailability: "available" },
          { value: { source: "Help", context: { file: "src/messages.ts", line: 21, screenshot: "shots/help.png" } }, bodyAvailability: "available" }
        ]
      }]
    }),
  },
  keyOf(unit) {
    return unit.context.file + ":" + unit.context.line;
  },
  translations: {
    languages: ["fr", "ja", "de"],
    read(language, sourceUnits) {
      translationReadCount += 1;
      if (language === "de") throw new Error("German catalogue unavailable");
      if (language === "fr") {
        return {
          scopes: [
            {
              range: "locales/fr/partial.json",
              covers: sourceUnits.slice(0, 3).map(({ key }) => key),
              enumeration: "partial",
              records: [
                { value: { text: "Partagé", context: { sourceLines: [18, 19] } }, bodyAvailability: "available" },
                { value: { text: "Annuler A", context: { sourceLines: [20] } }, bodyAvailability: "available" },
                { value: { text: "Annuler B", context: { sourceLines: [20] } }, bodyAvailability: "available" }
              ]
            },
            {
              range: "locales/fr/complete.json",
              covers: sourceUnits.slice(3).map(({ key }) => key),
              enumeration: "complete",
              records: [
                { value: { text: "Isolé", context: { sourceLines: [] } }, bodyAvailability: "available" }
              ]
            }
          ]
        };
      }
      return {
        scopes: [{
          range: "locales/ja.json",
          covers: sourceUnits.map(({ key }) => key),
          enumeration: "complete",
          records: [
            { value: { text: "共有", context: { sourceLines: [18, 19] } }, bodyAvailability: "available" },
            { value: { text: "取消", context: { sourceLines: [20] } }, bodyAvailability: "unavailable" },
            { value: { text: "孤立", context: { sourceLines: [] } }, bodyAvailability: "available" },
            { value: { text: "ヘルプ", context: { sourceLines: [21] } }, bodyAvailability: "available" }
          ]
        }]
      };
    },
    matches(unit, translation) {
      return translation.context.sourceLines.includes(unit.context.line);
    }
  },
});

export default config;
`;
  const duplicateConfigSource = `import { defineConfig } from "@l10n/core";

export default defineConfig({
  source: {
    read: () => ({
      scopes: [{
        range: "src/messages.ts",
        enumeration: "complete",
        records: [
          { value: { source: "Save", context: { file: "src/messages.ts" } }, bodyAvailability: "available" },
          { value: { source: "Submit", context: { file: "src/messages.ts" } }, bodyAvailability: "available" }
        ]
      }]
    }),
  },
  keyOf(unit) {
    return unit.context.file;
  },
});
`;
  const completionConfigSource = `import { readFileSync } from "node:fs";
import { defineConfig } from "@l10n/core";

type Translation = {
  text: string;
  context: { sourceLine: number };
};

const sourceRecords = [
  { source: "Save", context: { file: "src/messages.ts", line: 18 } },
  { source: "Submit", context: { file: "src/messages.ts", line: 19 } },
];

export default defineConfig({
  source: {
    read: () => ({
      scopes: [{
        range: "src/messages.ts",
        enumeration: "complete",
        records: sourceRecords.map((value) => ({ value, bodyAvailability: "available" })),
      }],
    }),
  },
  keyOf(unit) {
    return unit.context.file + ":" + unit.context.line;
  },
  translations: {
    languages: ["fr", "de"],
    read(language, sourceUnits) {
      const values = JSON.parse(readFileSync(new URL("./completion-resources/" + language + ".json", import.meta.url), "utf8")) as Translation[];
      return {
        scopes: [{
          range: "completion-resources/" + language + ".json",
          covers: sourceUnits.map(({ key }) => key),
          enumeration: "complete",
          records: values.map((value) => ({ value, bodyAvailability: "available" })),
        }],
      };
    },
    matches(unit, translation) {
      return unit.context.line === translation.context.sourceLine;
    },
  },
  completion: {
    criterion: "存在可用正文的实际译文",
    resolveCompletion({ translations }) {
      return translations.some(({ bodyAvailability }) => bodyAvailability === "available");
    },
  },
});
`;
  const editsConfigSource = `import { readFileSync, writeFileSync } from "node:fs";
import { defineConfig } from "@l10n/core";

type Unit = {
  source: string;
  context: {
    identity: string;
    line: number;
    targetKey: string;
    screenshot: string;
    unrelated?: string;
  };
};
type Translation = {
  text: string;
  context: {
    file: string;
    resourceKey: string;
    sourceLines: number[];
    annotation?: string;
    readOnly?: boolean;
    writeFailure?: boolean;
    writeIgnore?: boolean;
  };
};

function readSources(): Unit[] {
  return JSON.parse(readFileSync("edit-sources.json", "utf8")) as Unit[];
}

function readCatalogue(): { enumeration: "complete" | "partial"; records: Translation[]; unrelated: unknown } {
  return JSON.parse(readFileSync("edit-catalogue.json", "utf8")) as {
    enumeration: "complete" | "partial";
    records: Translation[];
    unrelated: unknown;
  };
}

export default defineConfig<Unit, Translation>({
  source: {
    read() {
      return {
        scopes: [{
          range: "edit-sources.json",
          enumeration: "complete",
          records: readSources().map((value) => ({ value, bodyAvailability: "available" as const })),
        }],
      };
    },
  },
  keyOf: (unit) => unit.context.identity,
  translations: {
    languages: ["fr"],
    read(_language, sourceUnits) {
      const catalogue = readCatalogue();
      return {
        scopes: [{
          range: "edit-catalogue.json",
          covers: sourceUnits.map(({ key }) => key),
          enumeration: catalogue.enumeration,
          records: catalogue.records.map((value) => ({ value, bodyAvailability: "available" as const })),
        }],
      };
    },
    matches: (unit, translation) => translation.context.sourceLines.includes(unit.context.line),
  },
  edits: {
    targetContent: (translation) => translation.text,
    locateExistingTarget({ translation }) {
      if (translation.translation.context.readOnly)
        return { status: "notWritable", reason: "该译文资源只读。" };
      return {
        status: "located",
        locator: {
          file: translation.translation.context.file,
          key: translation.translation.context.resourceKey,
        },
      };
    },
    locateNewTarget({ sourceUnit, language }) {
      const key = sourceUnit.unit.context.targetKey;
      if (key === "") return { status: "notWritable", reason: "宿主无法定位新增目标。" };
      return {
        status: "located",
        locator: { file: "locales/" + language + ".json", key },
      };
    },
    dependencies: ({ sourceUnit }) => ({ screenshot: sourceUnit.unit.context.screenshot }),
    write({ edit, sourceUnit, target, currentTranslation }) {
      const catalogue = readCatalogue();
      if (target.kind === "existing") {
        if (currentTranslation?.translation.context.writeFailure)
          throw new Error("宿主资源拒绝保存该译文。");
        if (currentTranslation?.translation.context.writeIgnore) return;
        const locator = target.locator as { file: string; key: string };
        const record = catalogue.records.find((item) =>
          item.context.file === locator.file && item.context.resourceKey === locator.key,
        );
        if (record === undefined) throw new Error("实际译文定位已失效。");
        if (typeof edit.content !== "string") throw new Error("该宿主只接受字符串译文。");
        record.text = edit.content;
      } else {
        if (typeof edit.content !== "string") throw new Error("该宿主只接受字符串译文。");
        const locator = target.locator as { file: string; key: string };
        catalogue.records.push({
          text: edit.content,
          context: {
            file: locator.file,
            resourceKey: locator.key,
            sourceLines: [sourceUnit.unit.context.line],
            annotation: "created by host adapter",
          },
        });
      }
      writeFileSync("edit-catalogue.json", JSON.stringify(catalogue, null, 2));
    },
  },
});
`;
  const qaConfigSource = `import { readFile } from "node:fs/promises";
import { defineConfig } from "@l10n/core";
import { createMessagePlaceholderChecker, createRelationshipChecker } from "@l10n/checks";

type Unit = {
  readonly source: string;
  readonly nativeId: string;
  readonly context: { readonly file: string; readonly line: number };
};
type Translation = {
  readonly sourceId: string;
  readonly nativeKey: string;
  readonly text: string;
};

async function readMessageResource() {
  return JSON.parse(await readFile("qa-messages.json", "utf8")) as {
    readonly messages: readonly Translation[];
  };
}

export const qualityChecks = [
  createMessagePlaceholderChecker<Unit, Translation>({
    sourceText: (unit) => unit.source,
    translationText: (translation) => translation.text,
    sourceLocation: (unit, _subject, range) => ({
      ...range,
      key: String(unit.context.line),
    }),
    translationLocation: (translation, _subject, range) => ({
      ...range,
      key: translation.nativeKey,
    }),
    configuration: { grammar: "simple-placeholders-v1" },
  }),
  createRelationshipChecker<Unit, Translation, {
    readonly constraint: string;
  }>({
    id: "same-target-text",
    relationshipKind: "same-target-text",
    configuration: { constraint: "target text is equal" },
    translationLocation: (translation, _subject, range) => ({
      ...range,
      key: translation.nativeKey,
    }),
    evaluate: ({ members }) =>
      new Set(members.map(({ translation }) => translation.text))
        .size > 1
        ? { severity: "error", message: "关系成员应使用相同译文。" }
        : undefined,
  }),
];

export function qualityRequest() {
  return {
    subjects: [{ key: "sha256:save", language: "fr" }],
    evidenceScope: [
      { kind: "translation-unit", key: "sha256:save", language: "fr" },
      { kind: "translation-unit", key: "sha256:submit", language: "fr" },
    ],
    relationships: [
      {
        kind: "same-target-text",
        key: "approved-variation",
        members: [
          { key: "sha256:submit", language: "fr" },
          { key: "sha256:save", language: "fr" },
        ],
      },
      {
        kind: "same-target-text",
        key: "strict-variation",
        members: [
          { key: "sha256:save", language: "fr" },
          { key: "sha256:submit", language: "fr" },
        ],
      },
    ],
    exceptions: [
      {
        id: "approved-variation",
        ruleId: "same-target-text",
        scope: {
          location: {
            language: "fr",
            range: "locales/fr.json",
            key: "submit_button",
          },
        },
        reason: "保留宿主现有按钮译法。",
      },
    ],
    dependencies: {},
  };
}

export default defineConfig<Unit, Translation>({
  source: {
    read: () => ({
      scopes: [{
        range: "src/messages.ts",
        enumeration: "complete",
        records: [
          { value: { source: "Hello {name}", nativeId: "save", context: { file: "src/messages.ts", line: 18 } }, bodyAvailability: "available" },
          { value: { source: "Save", nativeId: "submit", context: { file: "src/messages.ts", line: 19 } }, bodyAvailability: "available" },
        ],
      }],
    }),
  },
  keyOf: (unit) => "sha256:" + unit.nativeId,
  translations: {
    languages: ["fr"],
    async read(_language, sourceUnits) {
      const resource = await readMessageResource();
      return {
        scopes: [{
          range: "locales/fr.json",
          covers: sourceUnits.map(({ key }) => key),
          enumeration: "complete",
          records: resource.messages.map((value) => ({ value, bodyAvailability: "available" })),
        }],
      };
    },
    matches: (unit, translation) => unit.nativeId === translation.sourceId,
  },
});
`;
  const typecheckSource = `import { createMessagePlaceholderChecker } from "@l10n/checks";
import {
  applySemanticEdits,
  advanceProcessingBaseline,
  compareProcessingBaseline,
  evaluateCompletion,
  prepareSemanticEdit,
  readCompletion,
  readFacts,
  readSourceFacts,
} from "@l10n/core";
import { createFileProcessingBaselineStore } from "@l10n/core/node";
import config from "./l10n.config.ts";
import completionConfig from "./completion.config.ts";
import editConfig from "./edits.config.ts";
import qaConfig, { qualityChecks } from "./qa.config.ts";

void readSourceFacts(config);
void readFacts(config);
void readFacts(qaConfig);
void qualityChecks;
void createMessagePlaceholderChecker({
  sourceText: (unit: { source: string }) => unit.source,
  translationText: (translation: { text: string }) => translation.text,
});
void readCompletion(completionConfig);
void readFacts(completionConfig).then((facts) =>
  evaluateCompletion(facts, completionConfig.completion!),
);
void compareProcessingBaseline;
void advanceProcessingBaseline;
void createFileProcessingBaselineStore(".l10n/processing-baseline.json");
void readFacts(editConfig).then(async (facts) => {
  const sourceUnit = facts.source.units[0];
  if (sourceUnit === undefined) return;
  const prepared = await prepareSemanticEdit(facts, {
    sourceKey: sourceUnit.key,
    language: "fr",
    content: "Edited translation",
  }, editConfig);
  if (prepared.status === "prepared")
    return applySemanticEdits([prepared.edit], editConfig);
});
`;
  const tsconfig = {
    compilerOptions: {
      allowImportingTsExtensions: true,
      exactOptionalPropertyTypes: true,
      module: "NodeNext",
      moduleResolution: "NodeNext",
      noEmit: true,
      strict: true,
      target: "ES2023",
      types: ["node"],
    },
    files: [
      "l10n.config.ts",
      "completion.config.ts",
      "edits.config.ts",
      "qa.config.ts",
      "typecheck.ts",
    ],
  };
  const runtimeCheck = `import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, DuplicateTranslationUnitKeyError, readFacts, readSourceFacts } from "@l10n/core";
import "@l10n/checks";
import config, { translationReadCount } from "./l10n.config.ts";

const repositoryRoot = ${JSON.stringify(repositoryRoot)};
const sourceFacts = await readSourceFacts(config);
assert.equal(translationReadCount, 0);
assert.equal(sourceFacts.read.status, "complete");
assert.equal(sourceFacts.totalUnitCount, 4);
assert.equal(sourceFacts.units[0].key, "src/messages.ts:18");
assert.equal(sourceFacts.units[0].unit.context.screenshot, "shots/save.png");

const facts = await readFacts(config);
assert.equal(translationReadCount, 3);
assert.match(facts.version, /^sha256:[a-f0-9]{64}$/u);
assert.equal(facts.source.totalUnitCount, 4);
assert.deepEqual(facts.translations.reads.map(({ language, status }) => [language, status]), [
  ["fr", "incomplete"],
  ["ja", "complete"],
  ["de", "failed"],
]);
assert.deepEqual(facts.associations.map(({ sourceKey, language, status, coverageStatus, translationIndexes }) => [
  sourceKey,
  language,
  status,
  coverageStatus,
  translationIndexes,
]), [
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
]);
assert.equal(facts.translations.records.length, 8);
assert.deepEqual(facts.translations.records[0].translation.context.sourceLines, [18, 19]);
assert.deepEqual(facts.translations.records[3].translation.context.sourceLines, []);
assert.deepEqual(facts.translations.records[6].translation.context.sourceLines, []);

await assert.rejects(readSourceFacts({
  source: { read: () => ({
    scopes: [{
      range: "src/messages.ts",
      enumeration: "complete",
      records: [
        { value: { source: "Save", context: { file: "src/messages.ts" } }, bodyAvailability: "available" },
        { value: { source: "Submit", context: { file: "src/messages.ts" } }, bodyAvailability: "available" },
      ],
    }],
  }) },
  keyOf: (unit) => unit.context.file,
}), DuplicateTranslationUnitKeyError);

for (const packageName of ["@l10n/core", "@l10n/checks"]) {
  const resolved = fileURLToPath(import.meta.resolve(packageName));
  assert.ok(!resolved.startsWith(repositoryRoot + path.sep), resolved);
}
const cliPackage = await realpath(path.join(process.cwd(), "node_modules", "@l10n", "cli"));
assert.ok(!cliPackage.startsWith(repositoryRoot + path.sep), cliPackage);

const executable = path.join(process.cwd(), "node_modules", ".bin", process.platform === "win32" ? "l10n.cmd" : "l10n");
const structured = spawnSync(executable, ["facts", "l10n.config.ts"], { encoding: "utf8", shell: process.platform === "win32" });
assert.equal(structured.status, 0, structured.stderr);
assert.deepEqual(JSON.parse(structured.stdout).data, facts);
const readable = spawnSync(executable, ["facts", "l10n.config.ts", "--output-format", "text"], { encoding: "utf8", shell: process.platform === "win32" });
assert.equal(readable.status, 0, readable.stderr);
for (const content of [facts.version, facts.source.units[0].key, "shots/save.png", "unknown", "conflict", "missing", "unavailable", "German catalogue unavailable"])
  assert.ok(readable.stdout.includes(content));
const duplicate = spawnSync(executable, ["facts", "duplicate.config.ts"], { encoding: "utf8", shell: process.platform === "win32" });
assert.equal(duplicate.status, 1);
assert.equal(JSON.parse(duplicate.stderr).variant, "duplicateIdentity");
assert.equal(JSON.parse(duplicate.stderr).data.key, "src/messages.ts");

const noChecks = spawnSync(executable, ["qa", "l10n.config.ts"], { encoding: "utf8", shell: process.platform === "win32" });
assert.equal(noChecks.status, 0, noChecks.stderr);
assert.equal(JSON.parse(noChecks.stdout).data.status, "not-run");

const qaResource = path.join(process.cwd(), "qa-messages.json");
const originalResource = Buffer.from(JSON.stringify({
  messages: [
    { sourceId: "save", nativeKey: "save_label", text: "Bonjour" },
    { sourceId: "submit", nativeKey: "submit_button", text: "Enregistrer" },
  ],
}));
await writeFile(qaResource, originalResource);
const initialQa = spawnSync(executable, ["qa", "qa.config.ts"], { encoding: "utf8", shell: process.platform === "win32" });
assert.equal(initialQa.status, 0, initialQa.stderr + initialQa.stdout);
const initialResult = JSON.parse(initialQa.stdout).data;
assert.equal(initialResult.status, "complete");
assert.equal(initialResult.subjects[0].key, "sha256:save");
assert.equal(initialResult.subjects[0].language, "fr");
assert.equal(initialResult.diagnostics.length, 3);
assert.equal(initialResult.diagnostics[0].ruleId, "message-placeholders");
assert.equal(initialResult.diagnostics[0].evidence.length, 2);
assert.equal(initialResult.diagnostics[0].object.key, "sha256:save");
assert.equal(initialResult.diagnostics[0].location.key, "save_label");
assert.deepEqual(initialResult.diagnostics.slice(1).map(({ object, location, handling }) => [
  object.key,
  location.key,
  handling,
]), [
  ["approved-variation", "submit_button", {
    status: "excepted",
    exceptionId: "approved-variation",
    reason: "保留宿主现有按钮译法。",
  }],
  ["strict-variation", "save_label", { status: "active" }],
]);
assert.deepEqual(await readFile(qaResource), originalResource);

const readableQa = spawnSync(executable, ["qa", "qa.config.ts", "--output-format", "text"], { encoding: "utf8", shell: process.platform === "win32" });
assert.equal(readableQa.status, 0, readableQa.stderr);
assert.ok(readableQa.stdout.includes("位置键 submit_button"));
assert.ok(readableQa.stdout.includes("例外 approved-variation：保留宿主现有按钮译法。"));

const editedResource = Buffer.from(JSON.stringify({
  messages: [
    { sourceId: "save", nativeKey: "save_label", text: "Bonjour" },
    { sourceId: "submit", nativeKey: "submit_button", text: "Bonjour" },
  ],
}));
await writeFile(qaResource, editedResource);
const editedQa = spawnSync(executable, ["qa", "qa.config.ts"], { encoding: "utf8", shell: process.platform === "win32" });
assert.equal(editedQa.status, 0, editedQa.stderr);
const editedResult = JSON.parse(editedQa.stdout).data;
assert.equal(editedResult.status, "complete");
assert.notEqual(editedResult.version, initialResult.version);
assert.equal(editedResult.diagnostics.length, 1);
assert.equal(editedResult.diagnostics[0].ruleId, "message-placeholders");
assert.equal(editedResult.diagnostics[0].handling.status, "active");
assert.deepEqual(await readFile(qaResource), editedResource);

const baselineHost = path.join(process.cwd(), "baseline-host.mjs");
for (const scenario of ["establish", "modified", "source-change", "other-range", "identity-change", "removed", "all-gone"]) {
  const result = spawnSync(process.execPath, [baselineHost, scenario], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

process.stdout.write("独立打包宿主：事实API、完成API、显式QA、基线Node子入口、外部编辑重算和只读检查通过。\\n");
`;
  const completionCheckSource = `import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateCompletion, readCompletion, readFacts } from "@l10n/core";
import completionConfig from "./completion.config.ts";

const initial = await readCompletion(completionConfig);
assert.equal(initial.completion.status, "incomplete");
assert.equal(initial.completion.scope.sourceUnitCount, 2);
assert.equal(initial.completion.scope.targetLanguages.join(","), "fr,de");
assert.equal(initial.completion.scope.obligationCount, 4);
assert.equal(initial.completion.confirmedIncompleteCount, 4);
assert.equal(initial.completion.completionRate, 0);

const fixedFacts = await readFacts(completionConfig);
const reused = await evaluateCompletion(fixedFacts, completionConfig.completion);
assert.equal(reused.factsVersion, fixedFacts.version);
assert.equal(reused.status, "incomplete");

const resourcePath = fileURLToPath(new URL("./completion-resources/fr.json", import.meta.url));
await writeFile(resourcePath, JSON.stringify([
  { text: "Save", context: { sourceLine: 18 } }
]), "utf8");
const executable = path.join(process.cwd(), "node_modules", ".bin", process.platform === "win32" ? "l10n.cmd" : "l10n");
const updated = spawnSync(executable, ["completion", "completion.config.ts"], { encoding: "utf8", shell: process.platform === "win32" });
assert.equal(updated.status, 0, updated.stderr);
const report = JSON.parse(updated.stdout).data;
assert.notEqual(report.factsVersion, initial.completion.factsVersion);
assert.equal(report.confirmedCompleteCount, 1);
assert.equal(report.confirmedIncompleteCount, 3);
assert.equal(report.completionRate, 0.25);
assert.deepEqual(report.obligations[0].translationIndexes, [0]);

const readable = spawnSync(executable, ["completion", "completion.config.ts", "--output-format", "text"], { encoding: "utf8", shell: process.platform === "win32" });
assert.equal(readable.status, 0, readable.stderr);
assert.ok(readable.stdout.includes("完成率：25.0%"));

`;
  const baselineHostSource = `import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { advanceProcessingBaseline, compareProcessingBaseline, defineConfig, readFacts } from "@l10n/core";
import { createFileProcessingBaselineStore } from "@l10n/core/node";

const scenario = process.argv[2];
const baselinePath = path.join(process.cwd(), "processing-baseline.json");
const store = createFileProcessingBaselineStore(baselinePath);
const sourceByScenario = {
  establish: [{ range: "source-r1", units: [{ id: "A", source: "Save" }, { id: "B", source: "Cancel" }] }],
  modified: [{ range: "source-r1", units: [{ id: "A", source: "Save" }, { id: "B", source: "Cancel" }, { id: "C", source: "Help" }] }],
  "source-change": [{ range: "source-r1", units: [{ id: "A", source: "Save now" }, { id: "B", source: "Cancel" }] }],
  "other-range": [{ range: "source-r2", units: [{ id: "B", source: "Cancel" }] }],
  "identity-change": [{ range: "source-r1", units: [{ id: "A-new", source: "Save" }, { id: "B", source: "Cancel" }] }],
  removed: [{ range: "source-r1", units: [] }],
  "all-gone": [{ range: "source-r1", units: [] }],
};
const targetsByScenario = {
  establish: [{ range: "target-r1", translations: [{ id: "A", text: "Enregistrer" }, { id: "B", text: "Annuler" }] }],
  modified: [{ range: "target-r1", translations: [{ id: "A", text: "Sauvegarder" }, { id: "B", text: "Annuler" }, { id: "C", text: "Aide" }] }],
  "source-change": [{ range: "target-r1", translations: [{ id: "A", text: "Enregistrer" }, { id: "B", text: "Annuler" }] }],
  "other-range": [{ range: "target-r2", translations: [{ id: "B", text: "Annuler" }] }],
  "identity-change": [{ range: "target-r1", translations: [{ id: "A-new", text: "Enregistrer" }, { id: "B", text: "Annuler" }] }],
  removed: [{ range: "target-r1", translations: [{ id: "orphan", text: "Orphan" }] }],
  "all-gone": [{ range: "target-r1", translations: [] }],
};
const sourceScopes = sourceByScenario[scenario];
const targetScopes = targetsByScenario[scenario];
assert.ok(sourceScopes);
assert.ok(targetScopes);
const config = defineConfig({
  source: {
    read: () => ({
      scopes: sourceScopes.map(({ range, units }) => ({
        range,
        enumeration: "complete",
        records: units.map((value) => ({ value, bodyAvailability: "available" })),
      })),
    }),
  },
  keyOf: (unit) => unit.id,
  translations: {
    languages: ["fr"],
    read: (_language, units) => ({
      scopes: targetScopes.map(({ range, translations }) => ({
        range,
        covers: units.map(({ key }) => key),
        enumeration: "complete",
        records: translations.map((value) => ({ value, bodyAvailability: "available" })),
      })),
    }),
    matches: (unit, translation) => unit.id === translation.id,
  },
});
const facts = await readFacts(config);

if (scenario === "establish") {
  const result = await advanceProcessingBaseline(store, facts, [{ sourceKey: "A", language: "fr" }]);
  assert.equal(result.outcome, "saved");
  assert.deepEqual(result.baseline.entries.map(({ sourceKey, processed }) => [sourceKey, processed]), [["A", true], ["B", false]]);
} else {
  const before = await readFile(baselinePath, "utf8");
  const baseline = await store.load();
  const changes = compareProcessingBaseline(facts, baseline).changes;
  const forA = changes.find(({ sourceKey }) => sourceKey === "A");
  assert.equal(await readFile(baselinePath, "utf8"), before);
  if (scenario === "modified") {
    assert.equal(forA.status, "changed");
    assert.equal(changes.find(({ sourceKey }) => sourceKey === "B").processed, false);
    assert.equal(changes.find(({ sourceKey }) => sourceKey === "C").status, "added");
    const advanced = await advanceProcessingBaseline(store, facts, [{ sourceKey: "A", language: "fr" }]);
    assert.equal(advanced.outcome, "saved");
    const afterAdvance = compareProcessingBaseline(facts, advanced.baseline).changes;
    assert.equal(afterAdvance.find(({ sourceKey }) => sourceKey === "C").status, "added");
    assert.equal(afterAdvance.find(({ sourceKey }) => sourceKey === "B").processed, false);
  } else if (scenario === "other-range") {
    assert.equal(forA.status, "unknown");
  } else if (scenario === "source-change") {
    assert.equal(forA.status, "changed");
  } else if (scenario === "identity-change") {
    assert.equal(forA.status, "source-removed");
    assert.equal(changes.find(({ sourceKey }) => sourceKey === "A-new").status, "added");
  } else if (scenario === "removed") {
    assert.equal(forA.status, "source-removed");
    assert.ok(facts.translations.records.some(({ translation }) => translation.id === "orphan"));
    const advanced = await advanceProcessingBaseline(
      store,
      facts,
      [{ sourceKey: "A", language: "fr" }],
      { matches: (unit, translation) => unit.id === translation.id },
    );
    assert.equal(advanced.outcome, "saved");
    assert.equal(advanced.baseline.entries.find(({ sourceKey }) => sourceKey === "A").source.presence, "removed");
    assert.deepEqual(advanced.baseline.entries.find(({ sourceKey }) => sourceKey === "A").source.unit, { id: "A", source: "Save" });
  } else if (scenario === "all-gone") {
    assert.equal(forA.status, "source-removed");
    assert.equal(facts.translations.records.length, 0);
  }
}
`;
  const editApplySource = `import { readFile, writeFile } from "node:fs/promises";
import { applySemanticEdits } from "@l10n/core";
import config from "./edits.config.ts";

const editPath = process.argv[2];
if (editPath === undefined) throw new Error("缺少语义编辑文件路径。");
const edits = JSON.parse(await readFile(editPath, "utf8"));
const result = await applySemanticEdits(edits, config);
await writeFile(editPath + ".result.json", JSON.stringify(result), "utf8");
`;
  const editCheckSource = `import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { applySemanticEdits, prepareSemanticEdit, readFacts } from "@l10n/core";
import config from "./edits.config.ts";

async function prepare(sourceKey, content) {
  const facts = await readFacts(config);
  const result = await prepareSemanticEdit(facts, { sourceKey, language: "fr", content }, config);
  assert.equal(result.status, "prepared", result.reason);
  return result.edit;
}

async function applyInNewProcess(name, edits) {
  const editPath = path.join(process.cwd(), name + ".json");
  await writeFile(editPath, JSON.stringify(edits), "utf8");
  const child = spawnSync(process.execPath, ["edit-apply.mjs", editPath], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  const saved = JSON.parse(await readFile(editPath + ".result.json", "utf8"));
  return saved.results;
}

const sourcesPath = path.join(process.cwd(), "edit-sources.json");
const cataloguePath = path.join(process.cwd(), "edit-catalogue.json");
const initialFacts = await readFacts(config);
assert.equal(initialFacts.associations.find(({ sourceKey }) => sourceKey === "source:18")?.status, "matched");
assert.equal(initialFacts.associations.find(({ sourceKey }) => sourceKey === "source:19")?.status, "matched");
assert.equal(initialFacts.associations.find(({ sourceKey }) => sourceKey === "source:22")?.status, "missing");

const firstSharedEdit = await prepare("source:18", "First shared proposal");
const secondSharedEdit = await prepare("source:19", "Second shared proposal");
assert.notEqual(firstSharedEdit.sourceKey, firstSharedEdit.target.locator.key);
const sources = JSON.parse(await readFile(sourcesPath, "utf8"));
sources[0].context.unrelated = "changed after preparation";
await writeFile(sourcesPath, JSON.stringify(sources, null, 2), "utf8");
const catalogue = JSON.parse(await readFile(cataloguePath, "utf8"));
catalogue.records[0].context.annotation = "external annotation change";
catalogue.unrelated = { preserve: "unrelated resource entry" };
await writeFile(cataloguePath, JSON.stringify(catalogue, null, 2), "utf8");

const sharedResults = await applyInNewProcess("shared-edits", [firstSharedEdit, secondSharedEdit]);
assert.deepEqual(sharedResults.map(({ status }) => status), ["written", "conflict"]);
assert.equal(sharedResults[1].before.translations[0].translation.text, "First shared proposal");
let actualCatalogue = JSON.parse(await readFile(cataloguePath, "utf8"));
assert.equal(actualCatalogue.records[0].text, "First shared proposal");
assert.deepEqual(actualCatalogue.unrelated, { preserve: "unrelated resource entry" });

const staleTargetEdit = await prepare("source:18", "Must not overwrite external edit");
actualCatalogue.records[0].text = "External target edit";
await writeFile(cataloguePath, JSON.stringify(actualCatalogue, null, 2), "utf8");
const staleTargetResults = await applyInNewProcess("stale-target-edit", [staleTargetEdit]);
assert.equal(staleTargetResults[0].status, "conflict");
actualCatalogue = JSON.parse(await readFile(cataloguePath, "utf8"));
assert.equal(actualCatalogue.records[0].text, "External target edit");

const staleSourceEdit = await prepare("source:18", "Must not overwrite after source change");
const changedSourceText = JSON.parse(await readFile(sourcesPath, "utf8"));
changedSourceText[0].source = "Save with changed meaning";
await writeFile(sourcesPath, JSON.stringify(changedSourceText, null, 2), "utf8");
const staleSourceResults = await applyInNewProcess("stale-source-edit", [staleSourceEdit]);
assert.equal(staleSourceResults[0].status, "conflict");
actualCatalogue = JSON.parse(await readFile(cataloguePath, "utf8"));
assert.equal(actualCatalogue.records[0].text, "External target edit");
changedSourceText[0].source = "Save";
await writeFile(sourcesPath, JSON.stringify(changedSourceText, null, 2), "utf8");

const staleContextEdit = await prepare("source:18", "Must not overwrite after screenshot change");
const changedSources = JSON.parse(await readFile(sourcesPath, "utf8"));
changedSources[0].context.screenshot = "shots/save-v2.png";
await writeFile(sourcesPath, JSON.stringify(changedSources, null, 2), "utf8");
const staleContextResults = await applyInNewProcess("stale-context-edit", [staleContextEdit]);
assert.equal(staleContextResults[0].status, "conflict");
assert.match(staleContextResults[0].reason, /依赖/u);
actualCatalogue = JSON.parse(await readFile(cataloguePath, "utf8"));
assert.equal(actualCatalogue.records[0].text, "External target edit");

const multiMatchEdit = await prepare("source:20", "Do not edit an ambiguous target");
actualCatalogue = JSON.parse(await readFile(cataloguePath, "utf8"));
actualCatalogue.records.push({
  text: "Second cancel translation",
  context: {
    file: "locales/fr.json",
    resourceKey: "duplicate-cancel",
    sourceLines: [20],
  },
});
await writeFile(cataloguePath, JSON.stringify(actualCatalogue, null, 2), "utf8");
const multiMatchResults = await applyInNewProcess("multi-match-edit", [multiMatchEdit]);
assert.equal(multiMatchResults[0].status, "conflict");
actualCatalogue = JSON.parse(await readFile(cataloguePath, "utf8"));
assert.equal(actualCatalogue.records.find(({ context }) => context.resourceKey === "readonly-cancel").text, "Cancel original");
actualCatalogue.records = actualCatalogue.records.filter(({ context }) => context.resourceKey !== "duplicate-cancel");
await writeFile(cataloguePath, JSON.stringify(actualCatalogue, null, 2), "utf8");

const readOnlyEdit = await prepare("source:20", "No write to read-only target");
actualCatalogue.records.find(({ context }) => context.resourceKey === "readonly-cancel").context.readOnly = true;
await writeFile(cataloguePath, JSON.stringify(actualCatalogue, null, 2), "utf8");
const readOnlyResults = await applyInNewProcess("readonly-edit", [readOnlyEdit]);
assert.equal(readOnlyResults[0].status, "notWritable");

const failedWriteEdit = await prepare("source:21", "Host storage rejects this edit");
const failedWriteResults = await applyInNewProcess("failed-write-edit", [failedWriteEdit]);
assert.equal(failedWriteResults[0].status, "writeFailed");
assert.equal(failedWriteResults[0].after.translations[0].translation.text, "Help original");

const ignoredWriteEdit = await prepare("source:24", "Host reports success without changing the resource");
const ignoredWriteResults = await applyInNewProcess("ignored-write-edit", [ignoredWriteEdit]);
assert.equal(ignoredWriteResults[0].status, "writeUnconfirmed");
assert.equal(ignoredWriteResults[0].after.translations[0].translation.text, "Tooltip original");

const createEdit = await prepare("source:22", "À propos");
assert.deepEqual(createEdit.target, {
  kind: "create",
  locator: { file: "locales/fr.json", key: "toolbar.about" },
});
actualCatalogue = JSON.parse(await readFile(cataloguePath, "utf8"));
actualCatalogue.records.push({
  text: "Externally created About",
  context: {
    file: "locales/fr.json",
    resourceKey: "toolbar.about",
    sourceLines: [22],
  },
});
await writeFile(cataloguePath, JSON.stringify(actualCatalogue, null, 2), "utf8");
const occupiedCreateResults = await applyInNewProcess("occupied-create-edit", [createEdit]);
assert.equal(occupiedCreateResults[0].status, "conflict");
actualCatalogue = JSON.parse(await readFile(cataloguePath, "utf8"));
assert.equal(actualCatalogue.records.find(({ context }) => context.resourceKey === "toolbar.about").text, "Externally created About");
actualCatalogue.records = actualCatalogue.records.filter(({ context }) => context.resourceKey !== "toolbar.about");
actualCatalogue.enumeration = "partial";
await writeFile(cataloguePath, JSON.stringify(actualCatalogue, null, 2), "utf8");
const unprocessedResults = await applyInNewProcess("unprocessed-edit", [createEdit]);
assert.equal(unprocessedResults[0].status, "unprocessed");
actualCatalogue = JSON.parse(await readFile(cataloguePath, "utf8"));
assert.equal(actualCatalogue.records.some(({ context }) => context.resourceKey === "toolbar.about"), false);
actualCatalogue.enumeration = "complete";
await writeFile(cataloguePath, JSON.stringify(actualCatalogue, null, 2), "utf8");
const createResults = await applyInNewProcess("create-edit", [createEdit]);
assert.equal(createResults[0].status, "written");
assert.equal(createResults[0].after.translations[0].translation.text, "À propos");

const factsAfter = await readFacts(config);
assert.equal(factsAfter.associations.find(({ sourceKey }) => sourceKey === "source:18")?.status, "matched");
assert.equal(factsAfter.associations.find(({ sourceKey }) => sourceKey === "source:19")?.status, "matched");
const noLocationFacts = await readFacts(config);
const noLocation = await prepareSemanticEdit(noLocationFacts, {
  sourceKey: "source:23",
  language: "fr",
  content: "Cannot be located",
}, config);
assert.equal(noLocation.status, "notWritable");

process.stdout.write("独立打包宿主：编辑跨进程、冲突、依赖失效、失败和未处理结果通过。\\n");
`;

  const editSources = [
    {
      source: "Save",
      context: {
        identity: "source:18",
        line: 18,
        targetKey: "toolbar.save",
        screenshot: "shots/save.png",
      },
    },
    {
      source: "Submit",
      context: {
        identity: "source:19",
        line: 19,
        targetKey: "toolbar.submit",
        screenshot: "shots/submit.png",
      },
    },
    {
      source: "Cancel",
      context: {
        identity: "source:20",
        line: 20,
        targetKey: "toolbar.cancel",
        screenshot: "shots/cancel.png",
      },
    },
    {
      source: "Help",
      context: {
        identity: "source:21",
        line: 21,
        targetKey: "toolbar.help",
        screenshot: "shots/help.png",
      },
    },
    {
      source: "About",
      context: {
        identity: "source:22",
        line: 22,
        targetKey: "toolbar.about",
        screenshot: "shots/about.png",
      },
    },
    {
      source: "Other",
      context: {
        identity: "source:23",
        line: 23,
        targetKey: "",
        screenshot: "shots/other.png",
      },
    },
    {
      source: "Tooltip",
      context: {
        identity: "source:24",
        line: 24,
        targetKey: "toolbar.tooltip",
        screenshot: "shots/tooltip.png",
      },
    },
  ];
  const editCatalogue = {
    enumeration: "complete",
    records: [
      {
        text: "Shared original",
        context: {
          file: "locales/fr.json",
          resourceKey: "shared-save-submit",
          sourceLines: [18, 19],
          annotation: "keep this metadata",
        },
      },
      {
        text: "Cancel original",
        context: {
          file: "locales/fr.json",
          resourceKey: "readonly-cancel",
          sourceLines: [20],
        },
      },
      {
        text: "Help original",
        context: {
          file: "locales/fr.json",
          resourceKey: "failed-help",
          sourceLines: [21],
          writeFailure: true,
        },
      },
      {
        text: "Tooltip original",
        context: {
          file: "locales/fr.json",
          resourceKey: "ignored-tooltip",
          sourceLines: [24],
          writeIgnore: true,
        },
      },
    ],
    unrelated: { preserve: "original resource entry" },
  };
  await mkdir(path.join(consumerRoot, "completion-resources"), {
    recursive: true,
  });
  return Promise.all([
    writeFile(
      path.join(consumerRoot, "package.json"),
      JSON.stringify(packageJson, null, 2),
    ),
    writeFile(path.join(consumerRoot, "pnpm-workspace.yaml"), workspaceConfig),
    writeFile(path.join(consumerRoot, "l10n.config.ts"), configSource),
    writeFile(
      path.join(consumerRoot, "duplicate.config.ts"),
      duplicateConfigSource,
    ),
    writeFile(
      path.join(consumerRoot, "completion.config.ts"),
      completionConfigSource,
    ),
    writeFile(path.join(consumerRoot, "edits.config.ts"), editsConfigSource),
    writeFile(path.join(consumerRoot, "qa.config.ts"), qaConfigSource),
    writeFile(
      path.join(consumerRoot, "qa-messages.json"),
      JSON.stringify({ text: "Bonjour" }),
    ),
    writeFile(
      path.join(consumerRoot, "completion-resources", "fr.json"),
      "[]\n",
    ),
    writeFile(
      path.join(consumerRoot, "completion-resources", "de.json"),
      "[]\n",
    ),
    writeFile(
      path.join(consumerRoot, "edit-sources.json"),
      JSON.stringify(editSources, null, 2),
    ),
    writeFile(
      path.join(consumerRoot, "edit-catalogue.json"),
      JSON.stringify(editCatalogue, null, 2),
    ),
    writeFile(path.join(consumerRoot, "typecheck.ts"), typecheckSource),
    writeFile(
      path.join(consumerRoot, "tsconfig.json"),
      JSON.stringify(tsconfig, null, 2),
    ),
    writeFile(path.join(consumerRoot, "consumer-check.mjs"), runtimeCheck),
    writeFile(
      path.join(consumerRoot, "completion-check.mjs"),
      completionCheckSource,
    ),
    writeFile(path.join(consumerRoot, "baseline-host.mjs"), baselineHostSource),
    writeFile(path.join(consumerRoot, "edit-apply.mjs"), editApplySource),
    writeFile(path.join(consumerRoot, "edit-check.mjs"), editCheckSource),
  ]).then(() => undefined);
}

export async function verifyIndependentConsumer(): Promise<void> {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "l10n-independent-consumer-"),
  );
  const artifactRoot = path.join(temporaryRoot, "artifacts");
  const consumerRoot = path.join(temporaryRoot, "consumer");
  await Promise.all([
    mkdir(artifactRoot, { recursive: true }),
    mkdir(consumerRoot, { recursive: true }),
  ]);

  try {
    for (const packageName of packageNames) {
      process.stdout.write(`打包 ${packageName}…\n`);
      runChecked(
        "pnpm",
        ["--filter", packageName, "pack", "--pack-destination", artifactRoot],
        repositoryRoot,
      );
    }

    await writeConsumerFiles(consumerRoot, artifactRoot);
    process.stdout.write("从独立目录安装三个本地 npm 制品…\n");
    runChecked("pnpm", ["install"], consumerRoot);

    const typecheck = path.join(repositoryRoot, "node_modules", ".bin", "tsc");
    process.stdout.write("检查宿主通过已安装声明文件的类型…\n");
    runChecked(typecheck, ["--project", "tsconfig.json"], consumerRoot);

    process.stdout.write("运行独立宿主公开 API 与 CLI 场景…\n");
    const runtime = runChecked(
      process.execPath,
      ["consumer-check.mjs"],
      consumerRoot,
    );
    process.stdout.write(runtime.stdout);

    process.stdout.write("运行无 QA 依赖的完成度和外部编辑场景…\n");
    const completionRuntime = runChecked(
      process.execPath,
      ["completion-check.mjs"],
      consumerRoot,
    );
    process.stdout.write(completionRuntime.stdout);

    process.stdout.write("运行语义编辑跨进程、真实资源和输入冲突场景…\n");
    const editRuntime = runChecked(
      process.execPath,
      ["edit-check.mjs"],
      consumerRoot,
    );
    process.stdout.write(editRuntime.stdout);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    await verifyIndependentConsumer();
  } catch (error) {
    process.stderr.write(
      `独立宿主验收失败：${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
