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

function writeConsumerFiles(
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
  };
  const coreTarball = path
    .relative(consumerRoot, path.join(artifactRoot, "l10n-core-0.0.0.tgz"))
    .split(path.sep)
    .join("/");
  const workspaceConfig = `overrides:\n  "@l10n/core@0.0.0": "file:${coreTarball}"\n`;
  const configSource = `import { defineConfig } from "@l10n/core";

export default defineConfig({
  source: {
    readUnits: () => [
      {
        source: "Save",
        context: {
          location: { file: "src/messages.ts", line: 18 },
          screenshot: "shots/save-button.png",
        },
      },
    ],
  },
  keyOf(unit) {
    return unit.context.location.file + ":" + unit.context.location.line + ":" + unit.source;
  },
});
`;
  const duplicateConfigSource = `import { defineConfig } from "@l10n/core";

export default defineConfig({
  source: {
    readUnits: () => [
      { source: "Save", context: { location: "src/messages.ts" } },
      { source: "Submit", context: { location: "src/messages.ts" } },
    ],
  },
  keyOf(unit) {
    return unit.context.location;
  },
});
`;
  const typecheckSource = `import "@l10n/checks";
import { readSourceFacts } from "@l10n/core";
import config from "./l10n.config.ts";

void readSourceFacts(config);
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
      types: [],
    },
    files: ["l10n.config.ts", "typecheck.ts"],
  };
  const runtimeCheck = `import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, DuplicateTranslationUnitKeyError, readSourceFacts } from "@l10n/core";
import "@l10n/checks";
import config from "./l10n.config.ts";

const repositoryRoot = ${JSON.stringify(repositoryRoot)};
const facts = await readSourceFacts(config);
assert.deepEqual(facts.units, [{
  key: "src/messages.ts:18:Save",
  unit: {
    source: "Save",
    context: {
      location: { file: "src/messages.ts", line: 18 },
      screenshot: "shots/save-button.png",
    },
  },
}]);
assert.match(facts.version, /^sha256:[a-f0-9]{64}$/u);

let reads = 0;
defineConfig({ source: { readUnits: () => { reads += 1; return []; } }, keyOf: () => "unused" });
assert.equal(reads, 0);

const makeConfig = (screenshot) => defineConfig({
  source: { readUnits: () => [{ source: "Save", context: { file: "src/messages.ts", screenshot } }] },
  keyOf: (unit) => unit.context.file,
});
const before = await readSourceFacts(makeConfig("shots/before.png"));
const after = await readSourceFacts(makeConfig("shots/after.png"));
assert.equal(before.units[0].key, after.units[0].key);
assert.notEqual(before.version, after.version);

const changedIdentity = await readSourceFacts(defineConfig({
  source: { readUnits: () => [{ source: "Submit", context: { file: "src/other.ts" } }] },
  keyOf: (unit) => unit.context.file + ":" + unit.source,
}));
assert.notEqual(facts.units[0].key, changedIdentity.units[0].key);

await assert.rejects(readSourceFacts({
  source: { readUnits: () => [
    { source: "Save", context: { file: "src/messages.ts" } },
    { source: "Submit", context: { file: "src/messages.ts" } },
  ] },
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
for (const content of [facts.version, facts.units[0].key, "shots/save-button.png"])
  assert.ok(readable.stdout.includes(content));
const duplicate = spawnSync(executable, ["facts", "duplicate.config.ts"], { encoding: "utf8", shell: process.platform === "win32" });
assert.equal(duplicate.status, 1);
assert.equal(JSON.parse(duplicate.stderr).variant, "duplicateIdentity");
assert.equal(JSON.parse(duplicate.stderr).data.key, "src/messages.ts");

process.stdout.write("独立打包宿主：类型、API、CLI 和重复身份检查通过。\\n");
`;

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
    writeFile(path.join(consumerRoot, "typecheck.ts"), typecheckSource),
    writeFile(
      path.join(consumerRoot, "tsconfig.json"),
      JSON.stringify(tsconfig, null, 2),
    ),
    writeFile(path.join(consumerRoot, "consumer-check.mjs"), runtimeCheck),
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
