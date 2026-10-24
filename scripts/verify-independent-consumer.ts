import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  verifyCompositionConsumer,
  writeCompositionConsumerFiles,
} from "./verify-independent-composition.ts";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const packageNames = ["@lioni/core", "@lioni/checks", "@lioni/cli"] as const;

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
    const shortName = packageName.slice("@lioni/".length);
    const tarball = path.join(artifactRoot, `lioni-${shortName}-0.0.0.tgz`);
    const relativeTarball = path
      .relative(consumerRoot, tarball)
      .split(path.sep)
      .join("/");
    return [packageName, `file:${relativeTarball}`];
  });
  const dependencies = Object.fromEntries(packageFiles);
  const packageJson = {
    name: "lioni-independent-consumer",
    private: true,
    packageManager: "pnpm@12.9.1",
    type: "module",
    dependencies,
    devDependencies: {
      "@types/node": "24.19.2",
    },
  };
  const coreTarball = path
    .relative(consumerRoot, path.join(artifactRoot, "lioni-core-0.0.0.tgz"))
    .split(path.sep)
    .join("/");
  const workspaceConfig = `overrides:\n  "@lioni/core@0.0.0": "file:${coreTarball}"\n`;
  const schemaHelpersSource = `import type { StandardSchemaV1 } from "@lioni/core";

export function standardSchema<T>(
  isValue: (value: unknown) => value is T,
): StandardSchemaV1<T, T> {
  return {
    "~standard": {
      version: 1,
      vendor: "lioni-independent-consumer",
      validate(value) {
        return isValue(value)
          ? { value }
          : { issues: [{ message: "Independent consumer schema mismatch." }] };
      },
    },
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isNumberArray(value: unknown): value is readonly number[] {
  return Array.isArray(value) && value.every((item) => typeof item === "number");
}
`;
  const configSource = `import {
  defineConfig,
  defineQualityCheck,
  type JsonValue,
  type StandardSchemaV1,
} from "@lioni/core";
import { isNumberArray, isRecord, standardSchema } from "./schemas.ts";

type Unit = {
  readonly source: string;
  readonly context: { readonly file: string; readonly line: number; readonly screenshot: string };
};
type Translation = {
  readonly text: string;
  readonly context: { readonly sourceLines: readonly number[] };
};
type UnavailableTranslation = {
  readonly context: { readonly sourceLines: readonly number[] };
};

const sourceSchema = standardSchema<Unit>((value): value is Unit =>
  isRecord(value) &&
  typeof value.source === "string" &&
  isRecord(value.context) &&
  typeof value.context.file === "string" &&
  typeof value.context.line === "number" &&
  typeof value.context.screenshot === "string",
);
const translationSchema = standardSchema<Translation>(
  (value): value is Translation =>
    isRecord(value) &&
    typeof value.text === "string" &&
    isRecord(value.context) &&
    isNumberArray(value.context.sourceLines),
);
const unavailableTranslationSchema = standardSchema<UnavailableTranslation>(
  (value): value is UnavailableTranslation =>
    isRecord(value) &&
    isRecord(value.context) &&
    isNumberArray(value.context.sourceLines),
);
const contentSchema = standardSchema<string>(
  (value): value is string => typeof value === "string",
);

const qaConfigurationSchema: StandardSchemaV1<JsonValue, JsonValue> = {
  "~standard": {
    version: 1,
    vendor: "independent-consumer",
    validate(value) {
      return { value: value as JsonValue };
    },
  },
};

export let translationReadCount = 0;

const config = defineConfig({
  source: {
    schema: sourceSchema,
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
    schema: translationSchema,
    unavailableSchema: unavailableTranslationSchema,
    contentSchema,
    contentOf(translation) {
      return translation.text;
    },
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
            { value: { context: { sourceLines: [20] } }, bodyAvailability: "unavailable" },
            { value: { text: "孤立", context: { sourceLines: [] } }, bodyAvailability: "available" },
            { value: { text: "ヘルプ", context: { sourceLines: [21] } }, bodyAvailability: "available" }
          ]
        }]
      };
    },
    matches(unit, translation) {
      return translation.context.sourceLines.includes(unit.context.line);
    },
  },
});

export default config;
`;
  const duplicateConfigSource = `import { defineConfig } from "@lioni/core";
import { isRecord, standardSchema } from "./schemas.ts";

type Unit = { readonly source: string; readonly context: { readonly file: string } };
const sourceSchema = standardSchema<Unit>((value): value is Unit =>
  isRecord(value) &&
  typeof value.source === "string" &&
  isRecord(value.context) &&
  typeof value.context.file === "string",
);

export default defineConfig({
  source: {
    schema: sourceSchema,
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
import { defineConfig } from "@lioni/core";
import { isRecord, standardSchema } from "./schemas.ts";

type Translation = {
  text: string;
  context: { sourceLine: number };
};
type Unit = {
  source: string;
  context: { file: string; line: number };
};
const sourceSchema = standardSchema<Unit>((value): value is Unit =>
  isRecord(value) &&
  typeof value.source === "string" &&
  isRecord(value.context) &&
  typeof value.context.file === "string" &&
  typeof value.context.line === "number",
);
const translationSchema = standardSchema<Translation>(
  (value): value is Translation =>
    isRecord(value) &&
    typeof value.text === "string" &&
    isRecord(value.context) &&
    typeof value.context.sourceLine === "number",
);
const contentSchema = standardSchema<string>(
  (value): value is string => typeof value === "string",
);

const sourceRecords = [
  { source: "Save", context: { file: "src/messages.ts", line: 18 } },
  { source: "Submit", context: { file: "src/messages.ts", line: 19 } },
];

export default defineConfig({
  source: {
    schema: sourceSchema,
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
    schema: translationSchema,
    contentSchema,
    contentOf: (translation) => translation.text,
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
  const planConfigSource = `import { readFile, writeFile } from "node:fs/promises";
import { defineConfig } from "@lioni/core";
import { isRecord, standardSchema } from "./schemas.ts";

type Unit = {
  readonly id: string;
  readonly source: string;
  readonly context: { readonly file: string; readonly line: number; readonly screenshot: string };
};
type Translation = { readonly id: string; text: string };
const sourceSchema = standardSchema<Unit>((value): value is Unit =>
  isRecord(value) &&
  typeof value.id === "string" &&
  typeof value.source === "string" &&
  isRecord(value.context) &&
  typeof value.context.file === "string" &&
  typeof value.context.line === "number" &&
  typeof value.context.screenshot === "string",
);
const translationSchema = standardSchema<Translation>(
  (value): value is Translation =>
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.text === "string",
);
const contentSchema = standardSchema<string>(
  (value): value is string => typeof value === "string",
);

export default defineConfig({
  source: {
    schema: sourceSchema,
    async read() {
      const units = JSON.parse(await readFile(new URL("./update-plan-resources/source.json", import.meta.url), "utf8")) as Unit[];
      return {
        scopes: [{
          range: "update-plan-resources/source.json",
          enumeration: "complete",
          records: units.map((value) => ({ value, bodyAvailability: "available" })),
        }],
      };
    },
  },
  keyOf: (unit) => unit.id,
  translations: {
    languages: ["fr"],
    schema: translationSchema,
    contentSchema,
    contentOf: (translation) => translation.text,
    async read(_language, sourceUnits) {
      const translations = JSON.parse(await readFile(new URL("./update-plan-resources/fr.json", import.meta.url), "utf8")) as Translation[];
      return {
        scopes: [{
          range: "update-plan-resources/fr.json",
          covers: sourceUnits.map(({ key }) => key),
          enumeration: "complete",
          records: translations.map((value) => ({ value, bodyAvailability: "available" })),
        }],
      };
    },
    matches: (unit, translation) => unit.id === translation.id,
  },
  updatePolicy: ({ sourceKey, language, change, sourceUnit }) =>
    change === "changed"
      ? {
          action: "candidate",
          candidate: {
            sourceKey,
            language,
            content: sourceUnit?.source ?? "",
          },
          reason: "读取计划时生成的候选。",
        }
      : { action: "none", reason: "该项未由此计划处理。" },
  translationWriteback: {
    locateExistingTarget: ({ translation }) => ({
      status: "located",
      locator: { id: translation.translation.id },
    }),
    locateNewTarget: () => ({
      status: "notWritable",
      reason: "此消费场景只更新现有译文。",
    }),
    dependencies: ({ sourceUnit }) => ({
      screenshot: sourceUnit.unit.context.screenshot,
    }),
    async write({ edit, target }) {
      if (typeof edit.content !== "string") throw new TypeError("候选译文必须是字符串。");
      const locator = target.locator;
      if (typeof locator !== "object" || locator === null || !("id" in locator) || typeof locator.id !== "string") {
        throw new TypeError("译文定位缺少实际记录身份。");
      }
      const path = new URL("./update-plan-resources/fr.json", import.meta.url);
      const translations = JSON.parse(await readFile(path, "utf8")) as Translation[];
      const translation = translations.find(({ id }) => id === locator.id);
      if (translation === undefined) throw new Error("实际译文记录已不存在。");
      translation.text = edit.content;
      await writeFile(path, JSON.stringify(translations), "utf8");
    },
  },
});
`;
  const deletionConfigSource = `import { readFile, writeFile } from "node:fs/promises";
import { defineConfig } from "@lioni/core";
import { isRecord, standardSchema } from "./schemas.ts";

type Unit = { id: string; source: string; context: { file: string } };
type Translation = { id: string; text: string; context: { file: string; key: string; readonly?: boolean } };
type Resource = { enumeration: "complete" | "partial" | "failed"; records: Translation[] };
const sourceSchema = standardSchema<Unit>((value): value is Unit =>
  isRecord(value) &&
  typeof value.id === "string" &&
  typeof value.source === "string" &&
  isRecord(value.context) &&
  typeof value.context.file === "string",
);
const translationSchema = standardSchema<Translation>(
  (value): value is Translation =>
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.text === "string" &&
    isRecord(value.context) &&
    typeof value.context.file === "string" &&
    typeof value.context.key === "string" &&
    (value.context.readonly === undefined ||
      typeof value.context.readonly === "boolean"),
);
const contentSchema = standardSchema<string>(
  (value): value is string => typeof value === "string",
);
const sourcePath = new URL("./deletion-resources/source.json", import.meta.url);
const targetPath = new URL("./deletion-resources/fr.json", import.meta.url);
const otherTargetPath = new URL("./deletion-resources/other.json", import.meta.url);
const dependencyPath = new URL("./deletion-resources/dependencies.json", import.meta.url);

export default defineConfig({
  source: {
    schema: sourceSchema,
    async read() {
      const units = JSON.parse(await readFile(sourcePath, "utf8")) as Unit[];
      return {
        scopes: [{
          range: "deletion-resources/source.json",
          enumeration: "complete",
          records: units.map((value) => ({ value, bodyAvailability: "available" as const })),
        }],
      };
    },
  },
  keyOf: (unit) => unit.id,
  translations: {
    languages: ["fr"],
    schema: translationSchema,
    contentSchema,
    contentOf: (translation) => translation.text,
    async read(_language, sourceUnits) {
      const [resource, otherResource] = await Promise.all([
        readFile(targetPath, "utf8").then((value) => JSON.parse(value) as Resource),
        readFile(otherTargetPath, "utf8").then((value) => JSON.parse(value) as Resource),
      ]);
      const covers = sourceUnits.map(({ key }) => key);
      return {
        scopes: [
          {
            range: "deletion-resources/fr.json",
            covers,
            enumeration: resource.enumeration,
            records: resource.records.map((value) => ({ value, bodyAvailability: "available" as const })),
          },
          {
            range: "deletion-resources/other.json",
            covers,
            enumeration: otherResource.enumeration,
            records: otherResource.records.map((value) => ({ value, bodyAvailability: "available" as const })),
          },
        ],
      };
    },
    matches: (unit, translation) => unit.id === translation.id,
  },
  updatePolicy: ({ change }) => change === "source-removed"
    ? { action: "delete", reason: "清理已移除原文的目标译文。" }
    : { action: "none" },
  translationWriteback: {
    locateExistingTarget: ({ translation }) => translation.translation.context.readonly
      ? { status: "notWritable", reason: "其他资源中的目标为只读。" }
      : {
          status: "located",
          locator: {
            file: translation.translation.context.file,
            key: translation.translation.context.key,
          },
        },
    locateNewTarget: () => ({ status: "notWritable", reason: "删除场景不创建目标。" }),
    async dependencies() {
      return JSON.parse(await readFile(dependencyPath, "utf8")) as { revision: number };
    },
    async write({ edit, target }) {
      if (edit.operation !== "delete" || target.kind !== "existing")
        throw new TypeError("该宿主场景只执行删除语义编辑。");
      const locator = target.locator;
      if (typeof locator !== "object" || locator === null || !("key" in locator) || typeof locator.key !== "string")
        throw new TypeError("删除目标缺少宿主资源键。");
      const resource = JSON.parse(await readFile(targetPath, "utf8")) as Resource;
      const index = resource.records.findIndex(({ context }) => context.key === locator.key);
      if (index < 0) throw new Error("宿主明确的删除目标已不存在。");
      if (process.argv[2] === "apply" && process.argv[3] === "physical-target-remains") {
        const record = resource.records[index];
        if (record === undefined) throw new Error("宿主删除目标读取失败。");
        record.id = "detached-message";
        await writeFile(targetPath, JSON.stringify(resource) + "\\n", "utf8");
        return;
      }
      resource.records.splice(index, 1);
      await writeFile(targetPath, JSON.stringify(resource) + "\\n", "utf8");
    },
  },
});
`;
  const deletionHostSource = `import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { advanceProcessingBaseline, applyUpdatePlan, createUpdatePlan, readFacts } from "@lioni/core";
import { createFileProcessingBaselineStore, createFileUpdatePlanStore } from "@lioni/core/node";
import config from "./deletion.config.ts";

const scenario = process.argv[2];
const sourcePath = fileURLToPath(new URL("./deletion-resources/source.json", import.meta.url));
const targetPath = fileURLToPath(new URL("./deletion-resources/fr.json", import.meta.url));
const otherTargetPath = fileURLToPath(new URL("./deletion-resources/other.json", import.meta.url));
const dependencyPath = fileURLToPath(new URL("./deletion-resources/dependencies.json", import.meta.url));
const baselinePath = ".lioni/deletion-baseline.json";
const planPath = ".lioni/deletion-plan.json";
const baselineStore = createFileProcessingBaselineStore(baselinePath);
const planStore = createFileUpdatePlanStore(planPath);

if (scenario === "initialize") {
  const result = await advanceProcessingBaseline(baselineStore, await readFacts(config), [
    { sourceKey: "retired-message", language: "fr" },
  ], { matches: config.translations.matches });
  assert.equal(result.outcome, "saved");
  assert.equal(result.selections[0]?.outcome, "advanced");
} else if (scenario === "save-plan") {
  const before = await Promise.all([readFile(sourcePath), readFile(targetPath), readFile(otherTargetPath), readFile(baselinePath)]);
  const facts = await readFacts(config);
  const plan = await createUpdatePlan(facts, await baselineStore.load(), config);
  const item = plan.items.find(({ sourceKey }) => sourceKey === "retired-message");
  assert.equal(item?.change, "source-removed");
  assert.equal(item?.expectedInput?.source.presence, "removed");
  assert.equal(item?.decision.action, "delete");
  assert.equal(item?.status, "delete");
  assert.equal(item?.edit?.operation, "delete");
  assert.equal(Object.hasOwn(item?.edit ?? {}, "content"), false);
  assert.equal("value" in (item?.expectedInput?.source ?? {}), false);
  assert.equal(item?.edit?.expected.source.presence, "removed");
  await planStore.save(plan);
  assert.deepEqual(await Promise.all([readFile(sourcePath), readFile(targetPath), readFile(otherTargetPath), readFile(baselinePath)]), before);
} else if (scenario === "read-plan") {
  const plan = await planStore.load();
  assert.ok(plan);
  const item = plan.items.find(({ sourceKey }) => sourceKey === "retired-message");
  assert.equal(item?.status, "delete");
  assert.equal(item?.edit?.operation, "delete");
  assert.equal(Object.hasOwn(item?.edit ?? {}, "content"), false);
} else if (scenario === "apply") {
  const plan = await planStore.load();
  assert.ok(plan);
  const baselineBefore = await readFile(baselinePath, "utf8");
  const result = await applyUpdatePlan(plan, config, baselineStore);
  const item = result.contentResults.find(({ sourceKey }) => sourceKey === "retired-message");
  const baselineResult = result.baselineResults.find(({ sourceKey }) => sourceKey === "retired-message");
  if (process.argv[3] === "stale-dependency") {
    assert.equal(item?.status, "conflict");
    assert.equal(baselineResult?.status, "notAttempted");
    assert.equal(await readFile(baselinePath, "utf8"), baselineBefore);
    const target = JSON.parse(await readFile(targetPath, "utf8"));
    assert.equal(target.records[0]?.text, "Enregistrer");
  } else if (process.argv[3] === "physical-target-remains") {
    assert.equal(item?.status, "writeUnconfirmed");
    assert.equal(baselineResult?.status, "notAttempted");
    assert.equal(await readFile(baselinePath, "utf8"), baselineBefore);
    const target = JSON.parse(await readFile(targetPath, "utf8"));
    assert.equal(target.records.length, 2);
    assert.equal(
      target.records.find(({ context }) => context.key === "archive.save")?.id,
      "detached-message",
    );
  } else {
    assert.equal(item?.status, "written");
    assert.equal(baselineResult?.status, "advanced");
    assert.deepEqual(
      JSON.parse(await readFile(targetPath, "utf8")).records.map(({ id }) => id),
      ["unrelated-message"],
    );
    assert.equal(
      JSON.parse(await readFile(otherTargetPath, "utf8")).records[0]?.context.readonly,
      true,
    );
  }
} else if (scenario === "verify") {
  const baseline = await baselineStore.load();
  const entry = baseline?.entries.find(({ sourceKey }) => sourceKey === "retired-message");
  assert.equal(entry?.source.presence, "removed");
  assert.equal(entry?.association.status, "missing");
  assert.equal(entry?.processed, true);
  assert.deepEqual(
    JSON.parse(await readFile(targetPath, "utf8")).records.map(({ id }) => id),
    ["unrelated-message"],
  );
  assert.deepEqual(
    JSON.parse(await readFile(otherTargetPath, "utf8")).records.map(({ id }) => id),
    ["unmatched-other"],
  );
  const facts = await readFacts(config);
  assert.equal(facts.source.units.some(({ key }) => key === "retired-message"), false);
  assert.equal(facts.translations.records.length, 2);
}

console.log(JSON.stringify({ scenario, pid: process.pid }));
`;
  const editsConfigSource = `import { readFileSync, writeFileSync } from "node:fs";
import { defineConfig, defineQualityCheck } from "@lioni/core";
import { isNumberArray, isRecord, standardSchema } from "./schemas.ts";

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
const sourceSchema = standardSchema<Unit>((value): value is Unit =>
  isRecord(value) &&
  typeof value.source === "string" &&
  isRecord(value.context) &&
  typeof value.context.identity === "string" &&
  typeof value.context.line === "number" &&
  typeof value.context.targetKey === "string" &&
  typeof value.context.screenshot === "string" &&
  (value.context.unrelated === undefined ||
    typeof value.context.unrelated === "string"),
);
const translationSchema = standardSchema<Translation>(
  (value): value is Translation =>
    isRecord(value) &&
    typeof value.text === "string" &&
    isRecord(value.context) &&
    typeof value.context.file === "string" &&
    typeof value.context.resourceKey === "string" &&
    isNumberArray(value.context.sourceLines) &&
    (value.context.annotation === undefined ||
      typeof value.context.annotation === "string") &&
    (value.context.readOnly === undefined ||
      typeof value.context.readOnly === "boolean") &&
    (value.context.writeFailure === undefined ||
      typeof value.context.writeFailure === "boolean") &&
    (value.context.writeIgnore === undefined ||
      typeof value.context.writeIgnore === "boolean"),
);
const contentSchema = standardSchema<string>(
  (value): value is string => typeof value === "string",
);
const qaConfigurationSchema = standardSchema<{ readonly review?: string }>(
  (value): value is { readonly review?: string } =>
    isRecord(value) &&
    (value.review === undefined || typeof value.review === "string"),
);

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

export default defineConfig({
  source: {
    schema: sourceSchema,
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
    schema: translationSchema,
    contentSchema,
    contentOf: (translation) => translation.text,
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
  qualityChecks: [
    defineQualityCheck<Unit, Translation, typeof qaConfigurationSchema>({
      id: "host-review",
      configurationSchema: qaConfigurationSchema,
      configuration: { review: "manual" },
      check: ({ candidate }) => ({
        status: "complete",
        diagnostics: [{
          severity: "warning",
          object: {
            kind: "translation-unit",
            key: candidate.sourceKey,
            language: candidate.language,
          },
          location: {
            language: candidate.language,
            range: "edit-catalogue.json",
            key: candidate.sourceKey,
          },
          message: "待复核",
          evidence: [],
        }],
        issues: [],
        coverage: {
          selected: 1,
          evaluated: 1,
          notApplicable: 0,
          incomplete: 0,
          failed: 0,
        },
      }),
    }),
    defineQualityCheck<Unit, Translation, typeof qaConfigurationSchema>({
      id: "unconfigured-check",
      configurationSchema: qaConfigurationSchema,
      configuration: {},
      check: () => ({
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
      }),
    }),
  ],
  translationWriteback: {
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
import { defineConfig, type FrameworkFacts } from "@lioni/core";
import { createNumberChecker } from "@lioni/checks";
import { isRecord, standardSchema } from "./schemas.ts";

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
const sourceSchema = standardSchema<Unit>((value): value is Unit =>
  isRecord(value) &&
  typeof value.source === "string" &&
  typeof value.nativeId === "string" &&
  isRecord(value.context) &&
  typeof value.context.file === "string" &&
  typeof value.context.line === "number",
);
const translationSchema = standardSchema<Translation>(
  (value): value is Translation =>
    isRecord(value) &&
    typeof value.sourceId === "string" &&
    typeof value.nativeKey === "string" &&
    typeof value.text === "string",
);
const contentSchema = standardSchema<string>(
  (value): value is string => typeof value === "string",
);

async function readMessageResource() {
  return JSON.parse(await readFile("qa-messages.json", "utf8")) as {
    readonly messages: readonly Translation[];
  };
}

const qualityChecks = [
  createNumberChecker<Unit, Translation>({
    sourceText: (unit) => unit.source,
    translationText: (content) => content,
    sourceLocation: (unit, _subject, range) => ({
      ...range,
      key: String(unit.context.line),
    }),
    translationLocation: (translation, subject, range) => ({
      ...range,
      key: translation?.nativeKey ?? subject.key,
    }),
  }),
];

function createQualityRequest(
  facts: FrameworkFacts<Unit, Translation, string>,
) {
  const association = facts.associations.find(
    ({ sourceKey, language, status }) =>
      sourceKey === "sha256:save" && language === "fr" && status === "matched",
  );
  const record = association === undefined
    ? undefined
    : facts.translations.records[association.translationIndexes[0] as number];
  return {
    candidates: record?.bodyAvailability !== "available"
      ? []
      : [{ sourceKey: "sha256:save", language: "fr", content: record.content }],
    exceptions: [{
      id: "approved-number-difference",
      ruleId: "number-correspondence",
      scope: { object: { kind: "translation-unit", key: "sha256:save", language: "fr" } },
      reason: "数字差异已由维护者确认。",
    }],
    dependencies: {},
  };
}

export default defineConfig({
  source: {
    schema: sourceSchema,
    read: () => ({
      scopes: [{
        range: "src/messages.ts",
        enumeration: "complete",
        records: [
          { value: { source: "Hello 12 and 3.14", nativeId: "save", context: { file: "src/messages.ts", line: 18 } }, bodyAvailability: "available" },
          { value: { source: "Save", nativeId: "submit", context: { file: "src/messages.ts", line: 19 } }, bodyAvailability: "available" },
        ],
      }],
    }),
  },
  keyOf: (unit) => "sha256:" + unit.nativeId,
  translations: {
    languages: ["fr"],
    schema: translationSchema,
    contentSchema,
    contentOf: (translation) => translation.text,
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
  qualityChecks,
  createQualityRequest,
});
`;
  const typecheckSource = `import { createNumberChecker } from "@lioni/checks";
import {
  applySemanticEdits,
  advanceProcessingBaseline,
  analyzeQuality,
  applyUpdatePlan,
  compareProcessingBaseline,
  createUpdatePlan,
  evaluateCompletion,
  prepareSemanticEdit,
  prepareQualityConditionedSemanticEdit,
  readCompletion,
  readFacts,
  readSourceFacts,
  resolveSemanticEditInput,
} from "@lioni/core";
import {
  createFileProcessingBaselineStore,
  createFileUpdatePlanStore,
} from "@lioni/core/node";
import config from "./lioni.config.ts";
import completionConfig from "./completion.config.ts";
import editConfig from "./edits.config.ts";
import planConfig from "./plan.config.ts";
import deletionConfig from "./deletion.config.ts";
import qaConfig from "./qa.config.ts";

void readSourceFacts(config);
void readFacts(config);
void readFacts(qaConfig);
void qaConfig.qualityChecks;
void qaConfig.createQualityRequest;
void createNumberChecker({
  sourceText: (unit: { source: string }) => unit.source,
  translationText: (content) => content,
});
void readCompletion(completionConfig);
void readFacts(completionConfig).then((facts) =>
  evaluateCompletion(facts, completionConfig.completion!),
);
void compareProcessingBaseline;
void advanceProcessingBaseline;
void readFacts(deletionConfig);
void createFileProcessingBaselineStore(".lioni/processing-baseline.json");
void readFacts(planConfig).then(async (facts) => {
  const baselineStore = createFileProcessingBaselineStore(".lioni/plan-baseline.json");
  const plan = await createUpdatePlan(facts, await baselineStore.load(), planConfig);
  return applyUpdatePlan(plan, planConfig, baselineStore);
});
void createFileUpdatePlanStore(".lioni/update-plan.json");
void readFacts(editConfig).then(async (facts) => {
  const sourceUnit = facts.source.units[0];
  if (sourceUnit === undefined) return;
  const candidate = {
    sourceKey: sourceUnit.key,
    language: "fr",
    content: "Edited translation",
  };
  const resolved = await resolveSemanticEditInput(
    facts,
    { sourceKey: candidate.sourceKey, language: candidate.language },
    editConfig,
  );
  if (resolved.status !== "resolved") return;
  const prepared = await prepareSemanticEdit(resolved.input, candidate, editConfig);
  if (prepared.status === "prepared")
    return applySemanticEdits([prepared.edit], editConfig);
});
void analyzeQuality(editConfig, {
  candidates: [{ sourceKey: "source:18", language: "fr", content: "Candidate" }],
}).then((quality) =>
  prepareQualityConditionedSemanticEdit(editConfig, {
    candidate: quality.candidates[0]!,
    quality,
    condition: (result) => result.diagnostics.length === 0,
  }),
);
`;
  const resumeConfigSource = `import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@lioni/core";
import { isRecord, standardSchema } from "./schemas.ts";

type Unit = { id: string; source: string };
type Translation = { sourceId: string; text: string; path: string };
const sourceSchema = standardSchema<Unit>((value): value is Unit =>
  isRecord(value) &&
  typeof value.id === "string" &&
  typeof value.source === "string",
);
const translationSchema = standardSchema<Translation>(
  (value): value is Translation =>
    isRecord(value) &&
    typeof value.sourceId === "string" &&
    typeof value.text === "string" &&
    typeof value.path === "string",
);
const contentSchema = standardSchema<string>(
  (value): value is string => typeof value === "string",
);

const sourcePath = fileURLToPath(new URL("./resume-resources/source.json", import.meta.url));
const targetPath = (id: string) => fileURLToPath(new URL("./resume-resources/fr/" + id + ".json", import.meta.url));

export default defineConfig({
  source: {
    schema: sourceSchema,
    async read() {
      const records = JSON.parse(await readFile(sourcePath, "utf8")) as Unit[];
      return {
        scopes: [{
          range: "resume-resources/source.json",
          enumeration: "complete",
          records: records.map((value) => ({ value, bodyAvailability: "available" })),
        }],
      };
    },
  },
  keyOf: (unit) => unit.id,
  translations: {
    languages: ["fr"],
    schema: translationSchema,
    contentSchema,
    contentOf: (translation) => translation.text,
    async read(_language, sourceUnits) {
      const records = await Promise.all(sourceUnits.map(async ({ unit }) => {
        const path = targetPath(unit.id);
        const value = JSON.parse(await readFile(path, "utf8")) as Omit<Translation, "path">;
        return { value: { ...value, path }, bodyAvailability: "available" as const };
      }));
      return {
        scopes: [{
          range: "resume-resources/fr",
          covers: sourceUnits.map(({ key }) => key),
          enumeration: "complete",
          records,
        }],
      };
    },
    matches: (unit, translation) => unit.id === translation.sourceId,
  },
  updatePolicy: ({ sourceKey, language, change }) => change === "changed"
    ? process.argv[2] === "replan-retain" && sourceKey === "C"
      ? { action: "retain", reason: "保留当前译文并处理本次变化。" }
      : { action: "candidate", candidate: { sourceKey, language, content: "更新译文 " + sourceKey } }
    : { action: "none" },
  translationWriteback: {
    locateExistingTarget: ({ translation }) => ({
      status: "located",
      locator: { path: translation.translation.path },
    }),
    locateNewTarget: () => ({ status: "notWritable", reason: "此场景只修改已有译文。" }),
    async write({ edit, currentTranslation }) {
      if (currentTranslation === undefined || typeof edit.content !== "string")
        throw new TypeError("恢复场景需要字符串候选和现有译文。");
      const value = JSON.parse(await readFile(currentTranslation.translation.path, "utf8")) as Record<string, unknown>;
      value.text = edit.content;
      await writeFile(currentTranslation.translation.path, JSON.stringify(value) + "\\n", "utf8");
    },
  },
});
`;
  const resumeHostSource = `import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import {
  advanceProcessingBaseline,
  applyUpdatePlan,
  compareProcessingBaseline,
  createUpdatePlan,
  readFacts,
} from "@lioni/core";
import {
  createFileProcessingBaselineStore,
  createFileUpdatePlanStore,
} from "@lioni/core/node";
import config from "./resume.config.ts";

const ids = ["A", "B", "C"];
const baselineSelections = ids.map((sourceKey) => ({ sourceKey, language: "fr" }));
const baselinePath = ".lioni/resume-baseline.json";
const baselineStore = createFileProcessingBaselineStore(baselinePath);
const planStore = createFileUpdatePlanStore(".lioni/resume-plan.json");
const readTarget = async (id) => JSON.parse(await readFile("resume-resources/fr/" + id + ".json", "utf8"));
const entry = (baseline, id) => baseline?.entries.find(({ sourceKey }) => sourceKey === id);
const findResult = (results, id) => results.find(({ sourceKey }) => sourceKey === id);
const scenario = process.argv[2];

if (scenario === "initialize") {
  const facts = await readFacts(config);
  const result = await advanceProcessingBaseline(baselineStore, facts, baselineSelections, {
    matches: config.translations.matches,
  });
  assert.equal(result.outcome, "saved");
  assert.ok(result.baseline);
  assert.ok(result.baseline.entries.every(({ processed }) => processed));
} else if (scenario === "save-plan") {
  const facts = await readFacts(config);
  const baseline = await baselineStore.load();
  const plan = await createUpdatePlan(facts, baseline, config);
  for (const id of ids) {
    const item = plan.items.find(({ sourceKey }) => sourceKey === id);
    assert.equal(item?.change, "changed");
    assert.equal(item?.status, "candidate");
    assert.equal(item?.decision.action, "candidate");
    assert.equal(item?.edit?.content, "更新译文 " + id);
  }
  await planStore.save(plan);
} else if (scenario === "partial") {
  const plan = await planStore.load();
  assert.ok(plan);
  const result = await applyUpdatePlan(plan, config, baselineStore);
  assert.equal(findResult(result.contentResults, "A")?.status, "written");
  const failedWrite = findResult(result.contentResults, "B");
  assert.equal(failedWrite?.status, "writeFailed");
  assert.match(failedWrite?.reason ?? "", /EACCES|permission denied/iu);
  assert.equal(findResult(result.contentResults, "C")?.status, "written");
  assert.equal(findResult(result.baselineResults, "A")?.status, "advanced");
  assert.equal(findResult(result.baselineResults, "B")?.status, "notAttempted");
  assert.equal(findResult(result.baselineResults, "C")?.status, "advanced");
  const baseline = await baselineStore.load();
  assert.equal(entry(baseline, "A")?.source.unit.source, "原文 A 新版");
  assert.equal(entry(baseline, "B")?.source.unit.source, "原文 B 旧版");
  assert.equal(entry(baseline, "C")?.source.unit.source, "原文 C 新版");
  assert.equal(entry(baseline, "A")?.association.translations[0]?.translation.text, "更新译文 A");
  assert.equal(entry(baseline, "B")?.association.translations[0]?.translation.text, "译文 B");
  assert.equal(entry(baseline, "C")?.association.translations[0]?.translation.text, "更新译文 C");
  assert.equal((await readTarget("A")).text, "更新译文 A");
  assert.equal((await readTarget("B")).text, "译文 B");
  assert.equal((await readTarget("C")).text, "更新译文 C");
} else if (scenario === "resume-write") {
  const plan = await planStore.load();
  assert.ok(plan);
  const result = await applyUpdatePlan(plan, config, baselineStore);
  assert.equal(findResult(result.contentResults, "A")?.status, "conflict");
  assert.equal(findResult(result.contentResults, "B")?.status, "written");
  assert.equal(findResult(result.contentResults, "C")?.status, "conflict");
  assert.equal(findResult(result.baselineResults, "B")?.status, "advanced");
  assert.equal((await readTarget("B")).text, "更新译文 B");
  assert.equal(entry(await baselineStore.load(), "B")?.association.translations[0]?.translation.text, "更新译文 B");
} else if (scenario === "baseline-failure") {
  const source = JSON.parse(await readFile("resume-resources/source.json", "utf8"));
  source.find(({ id }) => id === "C").source = "原文 C 再更新";
  await writeFile("resume-resources/source.json", JSON.stringify(source), "utf8");
  const facts = await readFacts(config);
  const plan = await createUpdatePlan(facts, await baselineStore.load(), config);
  assert.equal(findResult(plan.items, "C")?.status, "candidate");
  assert.equal(findResult(plan.items, "A")?.status, "notProcessed");
  const baselineBefore = await readFile(baselinePath, "utf8");
  const result = await applyUpdatePlan(plan, config, baselineStore);
  assert.equal(findResult(result.contentResults, "C")?.status, "written");
  const failedSave = findResult(result.baselineResults, "C");
  assert.equal(failedSave?.status, "failed");
  assert.match(failedSave?.reason ?? "", /EACCES|permission denied/iu);
  assert.equal((await readTarget("C")).text, "更新译文 C");
  assert.equal(await readFile(baselinePath, "utf8"), baselineBefore);
  assert.equal(entry(await baselineStore.load(), "C")?.source.unit.source, "原文 C 新版");
  assert.equal(entry(await baselineStore.load(), "C")?.association.translations[0]?.translation.text, "更新译文 C");
} else if (scenario === "stale-old-plan") {
  const plan = await planStore.load();
  assert.ok(plan);
  const baselineBefore = await readFile(baselinePath, "utf8");
  const result = await applyUpdatePlan(plan, config, baselineStore);
  assert.equal(findResult(result.contentResults, "C")?.status, "conflict");
  assert.equal(findResult(result.baselineResults, "C")?.status, "notAttempted");
  assert.equal(await readFile(baselinePath, "utf8"), baselineBefore);
  assert.equal((await readTarget("C")).text, "更新译文 C");
} else if (scenario === "replan-retain") {
  const facts = await readFacts(config);
  const baseline = await baselineStore.load();
  const refreshedPlan = await createUpdatePlan(facts, baseline, config);
  const refreshedC = refreshedPlan.items.find(({ sourceKey }) => sourceKey === "C");
  assert.equal(refreshedC?.change, "changed");
  assert.equal(refreshedC?.expectedInput?.association.translations[0]?.translation.text, "更新译文 C");
  assert.equal(refreshedC?.decision.action, "retain");
  assert.equal(refreshedC?.status, "retain");
  await planStore.save(refreshedPlan);
  const result = await applyUpdatePlan(refreshedPlan, config, baselineStore);
  assert.equal(findResult(result.contentResults, "C")?.status, "retained");
  assert.equal(findResult(result.baselineResults, "C")?.status, "advanced");
  assert.equal((await readTarget("C")).text, "更新译文 C");
} else if (scenario === "verify") {
  const facts = await readFacts(config);
  const baseline = await baselineStore.load();
  assert.ok(baseline);
  for (const id of ids) {
    assert.equal(entry(baseline, id)?.processed, true);
    assert.equal(
      entry(baseline, id)?.source.unit.source,
      id === "C" ? "原文 C 再更新" : "原文 " + id + " 新版",
    );
    assert.equal(entry(baseline, id)?.association.translations[0]?.translation.text, "更新译文 " + id);
  }
  assert.ok(compareProcessingBaseline(facts, baseline, {
    matches: config.translations.matches,
  }).changes.every(({ status }) => status === "unchanged"));
}
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
      "lioni.config.ts",
      "completion.config.ts",
      "edits.config.ts",
      "plan.config.ts",
      "deletion.config.ts",
      "qa.config.ts",
      "composition.config.ts",
      "resume.config.ts",
      "typecheck.ts",
    ],
  };
  const runtimeCheck = `import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeQuality, defineConfig, DuplicateTranslationUnitKeyError, readFacts, readSourceFacts } from "@lioni/core";
import "@lioni/checks";
import config, { translationReadCount } from "./lioni.config.ts";
import qaConfig from "./qa.config.ts";

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
  source: {
    schema: {
      "~standard": {
        version: 1,
        vendor: "independent-consumer-duplicate-case",
        validate(value) {
          if (
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
            typeof value.context.file === "string"
          )
            return { value };
          return { issues: [{ message: "Expected source text and file context." }] };
        },
      },
    },
    read: () => ({
    scopes: [{
      range: "src/messages.ts",
      enumeration: "complete",
      records: [
        { value: { source: "Save", context: { file: "src/messages.ts" } }, bodyAvailability: "available" },
        { value: { source: "Submit", context: { file: "src/messages.ts" } }, bodyAvailability: "available" },
      ],
    }],
  }),
  },
  keyOf: (unit) => unit.context.file,
}), DuplicateTranslationUnitKeyError);

for (const packageName of ["@lioni/core", "@lioni/checks"]) {
  const resolved = fileURLToPath(import.meta.resolve(packageName));
  assert.ok(!resolved.startsWith(repositoryRoot + path.sep), resolved);
}
const cliPackage = await realpath(path.join(process.cwd(), "node_modules", "@lioni", "cli"));
assert.ok(!cliPackage.startsWith(repositoryRoot + path.sep), cliPackage);

const executable = path.join(process.cwd(), "node_modules", ".bin", process.platform === "win32" ? "lioni.cmd" : "lioni");
const structured = spawnSync(executable, ["facts", "lioni.config.ts"], { encoding: "utf8", shell: process.platform === "win32" });
assert.equal(structured.status, 0, structured.stderr);
assert.deepEqual(JSON.parse(structured.stdout).data, facts);
const readable = spawnSync(executable, ["facts", "lioni.config.ts", "--output-format", "text"], { encoding: "utf8", shell: process.platform === "win32" });
assert.equal(readable.status, 0, readable.stderr);
for (const content of [facts.version, facts.source.units[0].key, "shots/save.png", "unknown", "conflict", "missing", "unavailable", "German catalogue unavailable"])
  assert.ok(readable.stdout.includes(content));
const duplicate = spawnSync(executable, ["facts", "duplicate.config.ts"], { encoding: "utf8", shell: process.platform === "win32" });
assert.equal(duplicate.status, 1);
assert.equal(JSON.parse(duplicate.stderr).variant, "duplicateIdentity");
assert.equal(JSON.parse(duplicate.stderr).data.key, "src/messages.ts");

const noChecks = spawnSync(executable, ["qa", "lioni.config.ts"], { encoding: "utf8", shell: process.platform === "win32" });
assert.equal(noChecks.status, 0, noChecks.stderr);
assert.equal(JSON.parse(noChecks.stdout).data.status, "not-run");

const qaResource = path.join(process.cwd(), "qa-messages.json");
const originalResource = Buffer.from(JSON.stringify({
  messages: [
    { sourceId: "save", nativeKey: "save_label", text: "Bonjour" },
    { sourceId: "submit", nativeKey: "submit_button", text: "Enregistrer" },
  ],
}));
await writeFile(qaResource, JSON.stringify({ messages: [] }));
const skippedQa = spawnSync(executable, ["qa", "qa.config.ts"], { encoding: "utf8", shell: process.platform === "win32" });
assert.equal(skippedQa.status, 0, skippedQa.stderr + skippedQa.stdout);
const skippedResult = JSON.parse(skippedQa.stdout).data;
assert.equal(skippedResult.status, "not-run");
assert.deepEqual(skippedResult.candidates, []);
assert.deepEqual(
  skippedResult.factCoverage.associations.map(({ status, candidateSelected }) => [status, candidateSelected]),
  [["missing", false], ["missing", false]],
);
const readableSkippedQa = spawnSync(executable, ["qa", "qa.config.ts", "--output-format", "text"], { encoding: "utf8", shell: process.platform === "win32" });
assert.equal(readableSkippedQa.status, 0, readableSkippedQa.stderr);
assert.ok(readableSkippedQa.stdout.includes("质量检查：未执行"));
assert.ok(readableSkippedQa.stdout.includes("关联 sha256:save → fr：missing"));
await writeFile(qaResource, originalResource);
const initialQa = spawnSync(executable, ["qa", "qa.config.ts"], { encoding: "utf8", shell: process.platform === "win32" });
assert.equal(initialQa.status, 0, initialQa.stderr + initialQa.stdout);
const initialResult = JSON.parse(initialQa.stdout).data;
assert.equal(initialResult.status, "complete");
assert.deepEqual(initialResult.candidates, [
  { sourceKey: "sha256:save", language: "fr", content: "Bonjour" },
]);
assert.deepEqual(
  initialResult.factCoverage.associations.map(({ sourceKey, status, candidateSelected }) => [
    sourceKey,
    status,
    candidateSelected,
  ]),
  [
    ["sha256:save", "matched", true],
    ["sha256:submit", "matched", false],
  ],
);
assert.equal(initialResult.diagnostics.length, 1);
assert.equal(initialResult.diagnostics[0].ruleId, "number-correspondence");
assert.equal(initialResult.diagnostics[0].evidence.length, 2);
assert.equal(initialResult.diagnostics[0].object.key, "sha256:save");
assert.equal(initialResult.diagnostics[0].location.key, "save_label");
assert.deepEqual(initialResult.diagnostics[0].handling, {
  status: "excepted",
  exceptionId: "approved-number-difference",
  reason: "数字差异已由维护者确认。",
});
assert.deepEqual(await readFile(qaResource), originalResource);

const readableQa = spawnSync(executable, ["qa", "qa.config.ts", "--output-format", "text"], { encoding: "utf8", shell: process.platform === "win32" });
assert.equal(readableQa.status, 0, readableQa.stderr);
assert.ok(readableQa.stdout.includes("位置键 save_label"));
assert.ok(readableQa.stdout.includes("例外 approved-number-difference：数字差异已由维护者确认。"));

const reorderedNumbers = await analyzeQuality(qaConfig, {
  candidates: [{ sourceKey: "sha256:save", language: "fr", content: "3.14 puis 12" }],
});
assert.equal(reorderedNumbers.status, "complete");
assert.deepEqual(reorderedNumbers.diagnostics, []);
const repeatedNumber = await analyzeQuality(qaConfig, {
  candidates: [{ sourceKey: "sha256:save", language: "fr", content: "3.14, 12, 12" }],
});
assert.equal(repeatedNumber.diagnostics[0]?.message, "译文多出数字：12。");

const editedResource = Buffer.from(JSON.stringify({
  messages: [
    { sourceId: "save", nativeKey: "save_label", text: "Bonjour 3.14 et 12" },
    { sourceId: "submit", nativeKey: "submit_button", text: "Bonjour" },
  ],
}));
await writeFile(qaResource, editedResource);
const editedQa = spawnSync(executable, ["qa", "qa.config.ts"], { encoding: "utf8", shell: process.platform === "win32" });
assert.equal(editedQa.status, 0, editedQa.stderr);
const editedResult = JSON.parse(editedQa.stdout).data;
assert.equal(editedResult.status, "complete");
assert.notEqual(editedResult.version, initialResult.version);
assert.deepEqual(editedResult.diagnostics, []);
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
const reused = await evaluateCompletion(fixedFacts, completionConfig.completion);
assert.equal(reused.factsVersion, fixedFacts.version);
assert.equal(reused.status, "incomplete");

const resourcePath = fileURLToPath(new URL("./completion-resources/fr.json", import.meta.url));
await writeFile(resourcePath, JSON.stringify([
  { text: "Save", context: { sourceLine: 18 } }
]), "utf8");
const executable = path.join(process.cwd(), "node_modules", ".bin", process.platform === "win32" ? "lioni.cmd" : "lioni");
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
import { advanceProcessingBaseline, compareProcessingBaseline, defineConfig, readFacts } from "@lioni/core";
import { createFileProcessingBaselineStore } from "@lioni/core/node";
import { isRecord, standardSchema } from "./schemas.ts";

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
const sourceSchema = standardSchema((value) =>
  isRecord(value) &&
  typeof value.id === "string" &&
  typeof value.source === "string",
);
const translationSchema = standardSchema((value) =>
  isRecord(value) &&
  typeof value.id === "string" &&
  typeof value.text === "string",
);
const contentSchema = standardSchema((value) => typeof value === "string");
const config = defineConfig({
  source: {
    schema: sourceSchema,
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
    schema: translationSchema,
    contentSchema,
    contentOf: (translation) => translation.text,
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
  const updatePlanHostSource = `import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { advanceProcessingBaseline, applyUpdatePlan, compareProcessingBaseline, createUpdatePlan, readFacts } from "@lioni/core";
import {
  createFileProcessingBaselineStore,
  createFileUpdatePlanStore,
} from "@lioni/core/node";
import config from "./plan.config.ts";

const scenario = process.argv[2];
const baselinePath = "update-plan-baseline.json";
const planPath = "update-plan.json";
const sourcePath = fileURLToPath(new URL("./update-plan-resources/source.json", import.meta.url));
const targetPath = fileURLToPath(new URL("./update-plan-resources/fr.json", import.meta.url));
const baselineStore = createFileProcessingBaselineStore(baselinePath);
const planStore = createFileUpdatePlanStore(planPath);

if (scenario === "establish") {
  const facts = await readFacts(config);
  const result = await advanceProcessingBaseline(baselineStore, facts, [
    { sourceKey: "save-button", language: "fr" },
  ]);
  assert.equal(result.outcome, "saved");
  assert.deepEqual(result.baseline?.entries.map(({ sourceKey, processed }) => [sourceKey, processed]), [
    ["save-button", true],
    ["cancel-button", false],
  ]);
} else if (scenario === "save") {
  const baselineBefore = await readFile(baselinePath);
  const sourceBefore = await readFile(sourcePath);
  const targetBefore = await readFile(targetPath);
  const facts = await readFacts(config);
  const baseline = await baselineStore.load();
  const plan = await createUpdatePlan(facts, baseline, config);
  const item = plan.items.find(({ sourceKey }) => sourceKey === "save-button");
  assert.equal(item?.change, "changed");
  assert.equal(item?.decision.action, "candidate");
  assert.equal(item?.status, "candidate");
  assert.equal(item?.previous?.source.unit.context.screenshot, "shots/save.png");
  assert.equal(item?.current?.source.unit.context.screenshot, "shots/save-updated.png");
  assert.equal(item?.expectedInput?.source.value, "Save");
  assert.equal(item?.expectedInput?.association.translations[0]?.translation.text, "Enregistrer");
  assert.equal(item?.edit?.content, "Save");
  await planStore.save(plan);
  assert.deepEqual(await readFile(sourcePath), sourceBefore);
  assert.deepEqual(await readFile(targetPath), targetBefore);
  assert.deepEqual(await readFile(baselinePath), baselineBefore);
} else if (scenario === "read") {
  const plan = await planStore.load();
  assert.ok(plan);
  const item = plan.items.find(({ sourceKey }) => sourceKey === "save-button");
  assert.equal(item?.decision.action, "candidate");
  assert.equal(item?.status, "candidate");
  assert.equal(item?.previous?.source.unit.context.screenshot, "shots/save.png");
  assert.equal(item?.current?.source.unit.context.screenshot, "shots/save-updated.png");
  assert.equal(item?.expectedInput?.source.value, "Save");
  assert.equal(item?.expectedInput?.association.translations[0]?.translation.text, "Enregistrer");
  assert.equal(item?.edit?.content, "Save");
  const liveSource = JSON.parse(await readFile(sourcePath, "utf8"));
  const liveTarget = JSON.parse(await readFile(targetPath, "utf8"));
  assert.equal(liveSource[0].context.screenshot, "shots/after-plan.png");
  assert.equal(liveTarget[0].text, "Sauvegarder");
} else if (scenario === "stale-apply") {
  const baselineBefore = await readFile(baselinePath, "utf8");
  const targetBefore = await readFile(targetPath, "utf8");
  const plan = await planStore.load();
  assert.ok(plan);
  const result = await applyUpdatePlan(plan, config, baselineStore);
  assert.equal(result.contentResults.find(({ sourceKey }) => sourceKey === "save-button")?.status, "conflict");
  assert.equal(result.baselineResults.find(({ sourceKey }) => sourceKey === "save-button")?.status, "notAttempted");
  assert.deepEqual(await readFile(targetPath, "utf8"), targetBefore);
  assert.deepEqual(await readFile(baselinePath, "utf8"), baselineBefore);
} else if (scenario === "refresh") {
  const facts = await readFacts(config);
  const baseline = await baselineStore.load();
  const plan = await createUpdatePlan(facts, baseline, config);
  const item = plan.items.find(({ sourceKey }) => sourceKey === "save-button");
  assert.equal(item?.expectedInput?.source.value, "Save");
  assert.equal(item?.status, "candidate");
  assert.equal(item?.edit?.content, "Save");
  await planStore.save(plan);
} else if (scenario === "apply") {
  const plan = await planStore.load();
  assert.ok(plan);
  const result = await applyUpdatePlan(plan, config, baselineStore);
  assert.equal(result.contentResults.find(({ sourceKey }) => sourceKey === "save-button")?.status, "written");
  assert.equal(result.baselineResults.find(({ sourceKey }) => sourceKey === "save-button")?.status, "advanced");
} else if (scenario === "verify") {
  const facts = await readFacts(config);
  const baseline = await baselineStore.load();
  assert.ok(baseline);
  const a = baseline.entries.find(({ sourceKey }) => sourceKey === "save-button");
  const b = baseline.entries.find(({ sourceKey }) => sourceKey === "cancel-button");
  assert.equal(a?.source.unit.source, "Save");
  assert.equal(a?.association.translations[0]?.translation.text, "Save");
  assert.equal(a?.processed, true);
  assert.equal(b?.source.unit.source, "Cancel");
  assert.equal(b?.association.translations[0]?.translation.text, "Annuler");
  assert.equal(b?.processed, false);
  const changes = compareProcessingBaseline(facts, baseline, {
    matches: (unit, translation) => unit.id === translation.id,
  }).changes;
  assert.equal(changes.find(({ sourceKey }) => sourceKey === "save-button")?.status, "unchanged");
  assert.equal(changes.find(({ sourceKey }) => sourceKey === "cancel-button")?.status, "unchanged");
}
`;
  const editApplySource = `import { readFile, writeFile } from "node:fs/promises";
import { applySemanticEdits } from "@lioni/core";
import config from "./edits.config.ts";

const editPath = process.argv[2];
if (editPath === undefined) throw new Error("缺少语义编辑文件路径。");
const edits = JSON.parse(await readFile(editPath, "utf8"));
const result = await applySemanticEdits(edits, config);
await writeFile(editPath + ".result.json", JSON.stringify(result), "utf8");
`;
  const editCheckSource = `import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  analyzeQuality,
  applySemanticEdits,
  prepareQualityConditionedSemanticEdit,
  prepareSemanticEdit,
  readFacts,
  resolveSemanticEditInput,
} from "@lioni/core";
import config from "./edits.config.ts";

async function prepare(sourceKey, content) {
  const facts = await readFacts(config);
  const resolved = await resolveSemanticEditInput(
    facts,
    { sourceKey, language: "fr" },
    config,
  );
  if (resolved.status !== "resolved") return resolved;
  const result = await prepareSemanticEdit(resolved.input, {
    sourceKey,
    language: "fr",
    content,
  }, config);
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

async function baselineState() {
  const directory = path.join(process.cwd(), ".lioni");
  const files = await readdir(directory, { withFileTypes: true });
  return Object.fromEntries(await Promise.all(
    files.filter((entry) => entry.isFile()).map(async ({ name }) => [
      name,
      await readFile(path.join(directory, name), "utf8"),
    ]),
  ));
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
const noLocation = await resolveSemanticEditInput(noLocationFacts, {
  sourceKey: "source:23",
  language: "fr",
}, config);
assert.equal(noLocation.status, "notWritable");

const candidate = {
  sourceKey: "source:18",
  language: "fr",
  content: "Default write with QA findings",
};
const quality = await analyzeQuality(config, { candidates: [candidate] });
assert.equal(quality.diagnostics.length, 1);
const beforeReject = await readFile(cataloguePath, "utf8");
const baselineBeforeReject = await baselineState();
const rejected = await prepareQualityConditionedSemanticEdit(config, {
  candidate,
  condition: (currentQuality) => currentQuality.diagnostics.length === 0,
});
assert.equal(rejected.status, "rejected");
assert.equal("preparation" in rejected, false);
assert.equal(await readFile(cataloguePath, "utf8"), beforeReject);
assert.deepEqual(await baselineState(), baselineBeforeReject);

const cachedAllowed = await prepareQualityConditionedSemanticEdit(config, {
  candidate,
  quality,
  condition: () => true,
});
assert.equal(cachedAllowed.status, "passed");
assert.equal(cachedAllowed.preparation.status, "prepared");
if (cachedAllowed.preparation.status !== "prepared") throw new Error("缓存候选未准备。");
assert.equal(cachedAllowed.preparation.edit.content, candidate.content);
assert.equal(await readFile(cataloguePath, "utf8"), beforeReject);
assert.deepEqual(await baselineState(), baselineBeforeReject);

let conditionCalled = false;
const mismatch = await prepareQualityConditionedSemanticEdit(config, {
  candidate: { ...candidate, content: "Changed after checking" },
  quality,
  condition: () => {
    conditionCalled = true;
    return true;
  },
});
assert.equal(mismatch.status, "input-mismatch");
assert.equal(conditionCalled, false);
assert.equal(await readFile(cataloguePath, "utf8"), beforeReject);
assert.deepEqual(await baselineState(), baselineBeforeReject);

let releaseQualityCondition = () => {};
const qualityConditionGate = new Promise((resolve) => {
  releaseQualityCondition = resolve;
});
let enterQualityCondition = () => {};
const qualityConditionEntered = new Promise((resolve) => {
  enterQualityCondition = resolve;
});
let checkedContent;
const raceCandidate = { ...candidate, content: "Checked package text" };
const pendingCondition = prepareQualityConditionedSemanticEdit(config, {
  candidate: raceCandidate,
  condition: async (currentQuality) => {
    checkedContent = currentQuality.candidates[0]?.content;
    enterQualityCondition();
    await qualityConditionGate;
    return true;
  },
});
await qualityConditionEntered;
raceCandidate.content = "Unchecked package text";
releaseQualityCondition();
const raceResult = await pendingCondition;
assert.equal(checkedContent, "Checked package text");
assert.equal(raceResult.status, "passed");
assert.equal(raceResult.preparation.status, "prepared");
if (raceResult.preparation.status !== "prepared") throw new Error("异步候选未准备。");
assert.equal(raceResult.preparation.edit.content, "Checked package text");
assert.equal(await readFile(cataloguePath, "utf8"), beforeReject);
assert.deepEqual(await baselineState(), baselineBeforeReject);

const allowed = await prepareQualityConditionedSemanticEdit(config, { candidate });
assert.equal(allowed.status, "not-required");
assert.equal(allowed.preparation.status, "prepared");
if (allowed.preparation.status !== "prepared") throw new Error("候选未准备。");
const writeResult = await applySemanticEdits([allowed.preparation.edit], config);
assert.equal(writeResult.results[0]?.status, "written");
assert.deepEqual(await baselineState(), baselineBeforeReject);
const afterDefaultWrite = JSON.parse(await readFile(cataloguePath, "utf8"));
assert.equal(
  afterDefaultWrite.records.find(({ context }) => context.resourceKey === "shared-save-submit").text,
  candidate.content,
);

process.stdout.write("独立打包宿主：编辑跨进程、冲突、依赖失效、失败和未处理结果通过。\\n");
process.stdout.write("独立打包宿主：诊断候选默认写入，显式拒绝、缓存复用/错配及异步候选变化均受核对。\\n");
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
  await mkdir(path.join(consumerRoot, "update-plan-resources"), {
    recursive: true,
  });
  await mkdir(path.join(consumerRoot, "deletion-resources"), {
    recursive: true,
  });
  return Promise.all([
    writeFile(
      path.join(consumerRoot, "package.json"),
      JSON.stringify(packageJson, null, 2),
    ),
    writeFile(path.join(consumerRoot, "pnpm-workspace.yaml"), workspaceConfig),
    writeFile(path.join(consumerRoot, "schemas.ts"), schemaHelpersSource),
    writeFile(path.join(consumerRoot, "lioni.config.ts"), configSource),
    writeFile(
      path.join(consumerRoot, "duplicate.config.ts"),
      duplicateConfigSource,
    ),
    writeFile(
      path.join(consumerRoot, "completion.config.ts"),
      completionConfigSource,
    ),
    writeFile(path.join(consumerRoot, "plan.config.ts"), planConfigSource),
    writeFile(
      path.join(consumerRoot, "deletion.config.ts"),
      deletionConfigSource,
    ),
    writeFile(path.join(consumerRoot, "deletion-host.mjs"), deletionHostSource),
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
      path.join(consumerRoot, "update-plan-resources", "source.json"),
      JSON.stringify([
        {
          id: "save-button",
          source: "Save",
          context: {
            file: "src/messages.ts",
            line: 18,
            screenshot: "shots/save.png",
          },
        },
        {
          id: "cancel-button",
          source: "Cancel",
          context: {
            file: "src/messages.ts",
            line: 19,
            screenshot: "shots/cancel.png",
          },
        },
      ]),
    ),
    writeFile(
      path.join(consumerRoot, "update-plan-resources", "fr.json"),
      JSON.stringify([
        { id: "save-button", text: "Enregistrer" },
        { id: "cancel-button", text: "Annuler" },
      ]),
    ),
    writeFile(
      path.join(consumerRoot, "deletion-resources", "source.json"),
      JSON.stringify([
        {
          id: "retired-message",
          source: "Archived message",
          context: { file: "src/archived.ts" },
        },
      ]),
    ),
    writeFile(
      path.join(consumerRoot, "deletion-resources", "fr.json"),
      JSON.stringify({
        enumeration: "complete",
        records: [
          {
            id: "retired-message",
            text: "Enregistrer",
            context: {
              file: "deletion-resources/fr.json",
              key: "archive.save",
            },
          },
          {
            id: "unrelated-message",
            text: "Annuler",
            context: {
              file: "deletion-resources/fr.json",
              key: "footer.cancel",
            },
          },
        ],
      }),
    ),
    writeFile(
      path.join(consumerRoot, "deletion-resources", "other.json"),
      JSON.stringify({
        enumeration: "complete",
        records: [
          {
            id: "unmatched-other",
            text: "Lecture seule",
            context: {
              file: "deletion-resources/other.json",
              key: "other.readonly",
              readonly: true,
            },
          },
        ],
      }),
    ),
    writeFile(
      path.join(consumerRoot, "deletion-resources", "dependencies.json"),
      JSON.stringify({ revision: 1 }),
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
    writeFile(path.join(consumerRoot, "resume.config.ts"), resumeConfigSource),
    writeFile(path.join(consumerRoot, "resume-host.mjs"), resumeHostSource),
    writeFile(
      path.join(consumerRoot, "completion-check.mjs"),
      completionCheckSource,
    ),
    writeFile(path.join(consumerRoot, "baseline-host.mjs"), baselineHostSource),
    writeFile(
      path.join(consumerRoot, "update-plan-host.mjs"),
      updatePlanHostSource,
    ),
    writeFile(path.join(consumerRoot, "edit-apply.mjs"), editApplySource),
    writeFile(path.join(consumerRoot, "edit-check.mjs"), editCheckSource),
  ]).then(() => undefined);
}

export async function verifyIndependentConsumer(): Promise<void> {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "lioni-independent-consumer-"),
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

    for (const packageName of packageNames) {
      const shortName = packageName.slice("@lioni/".length);
      const tarball = path.join(artifactRoot, `lioni-${shortName}-0.0.0.tgz`);
      const digest = createHash("sha256")
        .update(await readFile(tarball))
        .digest("hex");
      process.stdout.write(
        `制品 SHA-256 ${path.basename(tarball)} ${digest}\n`,
      );
    }

    await writeConsumerFiles(consumerRoot, artifactRoot);
    await writeCompositionConsumerFiles(consumerRoot);
    process.stdout.write("从独立目录安装三个本地 npm 制品…\n");
    runChecked("pnpm", ["install", "--lockfile-only"], consumerRoot);
    runChecked("pnpm", ["install", "--frozen-lockfile"], consumerRoot);

    const typecheck = path.join(repositoryRoot, "node_modules", ".bin", "tsc");
    process.stdout.write("检查宿主通过已安装声明文件的类型…\n");
    runChecked(typecheck, ["--project", "tsconfig.json"], consumerRoot);

    process.stdout.write("运行异构输入组合与默认配置 QA 场景…\n");
    await verifyCompositionConsumer(consumerRoot);

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

    process.stdout.write("运行更新计划保存、跨进程读取和只读输入场景…\n");
    runChecked(
      process.execPath,
      ["update-plan-host.mjs", "establish"],
      consumerRoot,
    );
    const planSourcePath = path.join(
      consumerRoot,
      "update-plan-resources",
      "source.json",
    );
    const planSources = JSON.parse(
      await readFile(planSourcePath, "utf8"),
    ) as Array<{
      context: { screenshot: string };
    }>;
    const saveSource = planSources[0];
    if (saveSource === undefined) throw new Error("缺少计划场景原文。");
    saveSource.context.screenshot = "shots/save-updated.png";
    await writeFile(planSourcePath, JSON.stringify(planSources), "utf8");
    runChecked(
      process.execPath,
      ["update-plan-host.mjs", "save"],
      consumerRoot,
    );

    saveSource.context.screenshot = "shots/after-plan.png";
    await writeFile(planSourcePath, JSON.stringify(planSources), "utf8");
    const planTargetPath = path.join(
      consumerRoot,
      "update-plan-resources",
      "fr.json",
    );
    const planTargets = JSON.parse(
      await readFile(planTargetPath, "utf8"),
    ) as Array<{ text: string }>;
    const saveTarget = planTargets[0];
    if (saveTarget === undefined) throw new Error("缺少计划场景译文。");
    saveTarget.text = "Sauvegarder";
    await writeFile(planTargetPath, JSON.stringify(planTargets), "utf8");
    const planRead = runChecked(
      process.execPath,
      ["update-plan-host.mjs", "read"],
      consumerRoot,
    );
    process.stdout.write(planRead.stdout);
    runChecked(
      process.execPath,
      ["update-plan-host.mjs", "stale-apply"],
      consumerRoot,
    );
    runChecked(
      process.execPath,
      ["update-plan-host.mjs", "refresh"],
      consumerRoot,
    );
    runChecked(
      process.execPath,
      ["update-plan-host.mjs", "apply"],
      consumerRoot,
    );
    const planApplyVerify = runChecked(
      process.execPath,
      ["update-plan-host.mjs", "verify"],
      consumerRoot,
    );
    process.stdout.write(planApplyVerify.stdout);
    process.stdout.write(
      "独立打包宿主：保存计划的新进程应用、资源写入和分项基线推进通过。\n",
    );

    process.stdout.write("验证真实文件故障后的新进程恢复…\n");
    const resumeResources = path.join(consumerRoot, "resume-resources");
    const resumeSourcePath = path.join(resumeResources, "source.json");
    const resumeTranslations = path.join(resumeResources, "fr");
    const resumeBaselineDirectory = path.join(consumerRoot, ".lioni");
    await Promise.all([
      mkdir(resumeTranslations, { recursive: true }),
      mkdir(resumeBaselineDirectory, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(
        resumeSourcePath,
        JSON.stringify([
          { id: "A", source: "原文 A 旧版" },
          { id: "B", source: "原文 B 旧版" },
          { id: "C", source: "原文 C 旧版" },
        ]),
      ),
      writeFile(
        path.join(resumeTranslations, "A.json"),
        JSON.stringify({ sourceId: "A", text: "译文 A" }),
      ),
      writeFile(
        path.join(resumeTranslations, "B.json"),
        JSON.stringify({ sourceId: "B", text: "译文 B" }),
      ),
      writeFile(
        path.join(resumeTranslations, "C.json"),
        JSON.stringify({ sourceId: "C", text: "译文 C" }),
      ),
    ]);
    runChecked(
      process.execPath,
      ["resume-host.mjs", "initialize"],
      consumerRoot,
    );

    await writeFile(
      resumeSourcePath,
      JSON.stringify([
        { id: "A", source: "原文 A 新版" },
        { id: "B", source: "原文 B 新版" },
        { id: "C", source: "原文 C 新版" },
      ]),
    );
    runChecked(
      process.execPath,
      ["resume-host.mjs", "save-plan"],
      consumerRoot,
    );

    const failedTargetPath = path.join(resumeTranslations, "B.json");
    await chmod(failedTargetPath, 0o444);
    try {
      runChecked(
        process.execPath,
        ["resume-host.mjs", "partial"],
        consumerRoot,
      );
    } finally {
      await chmod(failedTargetPath, 0o644);
    }
    process.stdout.write(
      "新进程A/C成功写入并推进；B收到真实EACCES，内容与旧基线保持不变。\n",
    );

    runChecked(
      process.execPath,
      ["resume-host.mjs", "resume-write"],
      consumerRoot,
    );
    await chmod(resumeBaselineDirectory, 0o555);
    try {
      runChecked(
        process.execPath,
        ["resume-host.mjs", "baseline-failure"],
        consumerRoot,
      );
    } finally {
      await chmod(resumeBaselineDirectory, 0o755);
    }
    process.stdout.write(
      "新进程B继续成功；C内容写入成功而处理基线保存收到真实EACCES，旧基线字节保持不变。\n",
    );

    runChecked(
      process.execPath,
      ["resume-host.mjs", "stale-old-plan"],
      consumerRoot,
    );
    runChecked(
      process.execPath,
      ["resume-host.mjs", "replan-retain"],
      consumerRoot,
    );
    const resumeVerify = runChecked(
      process.execPath,
      ["resume-host.mjs", "verify"],
      consumerRoot,
    );
    process.stdout.write(resumeVerify.stdout);
    process.stdout.write(
      "独立打包宿主：旧计划拒绝过期目标；正式重规划并保留实际C内容后，A/B/C均按新进程读取结果更新处理基线。\n",
    );

    process.stdout.write("验证已打包制品删除译文的跨进程资源链…\n");
    await mkdir(path.join(consumerRoot, ".lioni"), { recursive: true });
    const deletionSourcePath = path.join(
      consumerRoot,
      "deletion-resources",
      "source.json",
    );
    const deletionTargetPath = path.join(
      consumerRoot,
      "deletion-resources",
      "fr.json",
    );
    const deletionTargetOriginal = await readFile(deletionTargetPath);
    const deletionDependencyPath = path.join(
      consumerRoot,
      "deletion-resources",
      "dependencies.json",
    );
    process.stdout.write(
      runChecked(
        process.execPath,
        ["deletion-host.mjs", "initialize"],
        consumerRoot,
      ).stdout,
    );
    await writeFile(deletionSourcePath, "[]\n", "utf8");
    process.stdout.write(
      runChecked(
        process.execPath,
        ["deletion-host.mjs", "save-plan"],
        consumerRoot,
      ).stdout,
    );
    process.stdout.write(
      runChecked(
        process.execPath,
        ["deletion-host.mjs", "read-plan"],
        consumerRoot,
      ).stdout,
    );
    await writeFile(
      deletionDependencyPath,
      JSON.stringify({ revision: 2 }),
      "utf8",
    );
    process.stdout.write(
      runChecked(
        process.execPath,
        ["deletion-host.mjs", "apply", "stale-dependency"],
        consumerRoot,
      ).stdout,
    );
    await writeFile(
      deletionDependencyPath,
      JSON.stringify({ revision: 1 }),
      "utf8",
    );
    process.stdout.write(
      runChecked(
        process.execPath,
        ["deletion-host.mjs", "apply", "physical-target-remains"],
        consumerRoot,
      ).stdout,
    );
    await writeFile(deletionTargetPath, deletionTargetOriginal);
    process.stdout.write(
      runChecked(process.execPath, ["deletion-host.mjs", "apply"], consumerRoot)
        .stdout,
    );
    process.stdout.write(
      runChecked(
        process.execPath,
        ["deletion-host.mjs", "verify"],
        consumerRoot,
      ).stdout,
    );
    process.stdout.write(
      "独立打包宿主：多 scope 中删除准确目标，不受其他 scope 只读无关记录阻断；仍占据保存 locator 的关系变更不推进基线；正常删除保留同 scope 无关记录，新进程回读后推进该范围基线。\n",
    );

    process.stdout.write("运行语义编辑跨进程、真实资源和输入冲突场景…\n");
    const editRuntime = runChecked(
      process.execPath,
      ["edit-check.mjs"],
      consumerRoot,
    );
    process.stdout.write(editRuntime.stdout);
  } finally {
    if (process.env.LIONI_KEEP_CONSUMER === "1") {
      process.stdout.write(`保留独立制品与资源现场：${temporaryRoot}\n`);
    } else {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
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
