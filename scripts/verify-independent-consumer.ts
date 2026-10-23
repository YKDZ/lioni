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
  const qaConfigSource = `import { readFile } from "node:fs/promises";
import { defineConfig } from "@l10n/core";
import { createMessagePlaceholderChecker } from "@l10n/checks";

type Unit = { readonly source: string; readonly key: string };
type Translation = { readonly text: string; readonly key: string };

async function readMessageResource() {
  return JSON.parse(await readFile("qa-messages.json", "utf8")) as { text: string };
}

export const qualityChecks = [
  createMessagePlaceholderChecker<Unit, Translation>({
    sourceText: (unit) => unit.source,
    translationText: (translation) => translation.text,
    configuration: { grammar: "simple-placeholders-v1" },
  }),
];

export default defineConfig<Unit, Translation>({
  source: {
    read: () => ({
      scopes: [{
        range: "src/messages.ts",
        enumeration: "complete",
        records: [{ value: { source: "Hello {name}", key: "save" }, bodyAvailability: "available" }],
      }],
    }),
  },
  keyOf: (unit) => unit.key,
  translations: {
    languages: ["fr"],
    async read(_language, sourceUnits) {
      const resource = await readMessageResource();
      return {
        scopes: [{
          range: "locales/fr.json",
          covers: sourceUnits.map(({ key }) => key),
          enumeration: "complete",
          records: [{ value: { text: resource.text, key: "save" }, bodyAvailability: "available" }],
        }],
      };
    },
    matches: (unit, translation) => unit.key === translation.key,
  },
});
`;
  const typecheckSource = `import { createMessagePlaceholderChecker } from "@l10n/checks";
import { evaluateCompletion, readCompletion, readFacts, readSourceFacts } from "@l10n/core";
import config from "./l10n.config.ts";
import completionConfig from "./completion.config.ts";
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
const originalResource = Buffer.from(JSON.stringify({ text: "Bonjour" }));
await writeFile(qaResource, originalResource);
const initialQa = spawnSync(executable, ["qa", "qa.config.ts"], { encoding: "utf8", shell: process.platform === "win32" });
assert.equal(initialQa.status, 0, initialQa.stderr);
const initialResult = JSON.parse(initialQa.stdout).data;
assert.equal(initialResult.status, "complete");
assert.equal(initialResult.subjects[0].key, "save");
assert.equal(initialResult.subjects[0].language, "fr");
assert.equal(initialResult.diagnostics.length, 1);
assert.equal(initialResult.diagnostics[0].ruleId, "message-placeholders");
assert.equal(initialResult.diagnostics[0].evidence.length, 2);
assert.deepEqual(await readFile(qaResource), originalResource);

const editedResource = Buffer.from(JSON.stringify({ text: "Bonjour {name}" }));
await writeFile(qaResource, editedResource);
const editedQa = spawnSync(executable, ["qa", "qa.config.ts"], { encoding: "utf8", shell: process.platform === "win32" });
assert.equal(editedQa.status, 0, editedQa.stderr);
const editedResult = JSON.parse(editedQa.stdout).data;
assert.equal(editedResult.status, "complete");
assert.notEqual(editedResult.version, initialResult.version);
assert.deepEqual(editedResult.diagnostics, []);
assert.deepEqual(await readFile(qaResource), editedResource);

process.stdout.write("独立打包宿主：事实 API、完成 API、显式 QA、外部编辑重算和只读检查通过。\\n");
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

process.stdout.write("独立打包宿主：完成 API 重用与直接编辑后的新进程重算通过。\\n");
`;

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
