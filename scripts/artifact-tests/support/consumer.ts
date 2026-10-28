import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { externalInterruptSignal } from "./external-interrupt.ts";
import { runCommand, runSubprocess, type ProcessResult } from "./process.ts";

export type Artifact = {
  readonly name: string;
  readonly filename: string;
};

type ConsumerCommand = (
  command: string,
  args?: readonly string[],
) => Promise<ProcessResult>;

export type Consumer = {
  readonly root: string;
  readonly runCommand: ConsumerCommand;
  /** 返回退出状态，供场景验证 CLI 的预期非零结果。 */
  readonly runProcess: ConsumerCommand;
  readonly runNode: ConsumerCommand;
  readonly typecheck: () => Promise<ProcessResult>;
};

type ConsumerScenarioOptions = {
  readonly name: string;
  readonly packages: readonly string[];
  readonly fixtures: URL;
};

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  assert.ok(value, `请通过 verify:artifacts 运行场景；缺少 ${name}。`);
  return value;
}

/** 在工作区外安装本次打包的制品。场景只声明自己使用的直接依赖。 */
export function testArtifactConsumer(
  options: ConsumerScenarioOptions,
  execute: (consumer: Consumer) => Promise<void>,
): void {
  void test(options.name, { timeout: 10 * 60 * 1000 }, async (context) => {
    const runRoot = requiredEnvironment("LIONI_ARTIFACT_RUN_ROOT");
    const artifacts = JSON.parse(
      await readFile(path.join(runRoot, "artifacts.json"), "utf8"),
    ) as readonly Artifact[];
    const overrides = Object.fromEntries(
      artifacts.map(({ name, filename }) => [name, `file:${filename}`]),
    );
    const dependencies = Object.fromEntries(
      options.packages.map((name) => {
        assert.ok(overrides[name], `本次未打包 ${name}。`);
        return [name, overrides[name]];
      }),
    );
    const root = await mkdtemp(path.join(runRoot, "consumer-"));
    const signal = AbortSignal.any([context.signal, externalInterruptSignal]);
    const processOptions = {
      cwd: root,
      signal,
      shell: process.platform === "win32",
      terminationGraceMs: 500,
    };
    const command: ConsumerCommand = (executable, args = []) =>
      runCommand(executable, args, processOptions);
    const runProcess: ConsumerCommand = (executable, args = []) =>
      runSubprocess(executable, args, processOptions);

    try {
      await cp(options.fixtures, root, { recursive: true });
      await writeFile(
        path.join(root, "package.json"),
        JSON.stringify({
          name: "lioni-artifact-consumer",
          private: true,
          type: "module",
          packageManager: "pnpm@12.9.1",
          dependencies,
          devDependencies: { "@types/node": "24.19.2" },
        }),
      );
      // 传递依赖也必须来自本批制品；把它们全列为直接依赖会掩盖漏报依赖。
      await writeFile(
        path.join(root, "pnpm-workspace.yaml"),
        JSON.stringify({ overrides }),
      );
      await writeFile(
        path.join(root, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            target: "ESNext",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            strict: true,
            exactOptionalPropertyTypes: true,
            noUncheckedIndexedAccess: true,
            noEmit: true,
            skipLibCheck: false,
            erasableSyntaxOnly: true,
            allowImportingTsExtensions: true,
            types: ["node"],
          },
          include: ["**/*.ts"],
        }),
      );
      await command("pnpm", ["install", "--no-frozen-lockfile"]);
      await execute({
        root,
        runCommand: command,
        runProcess,
        runNode: (file, args = []) =>
          command(process.execPath, [path.resolve(root, file), ...args]),
        typecheck: () =>
          command(requiredEnvironment("LIONI_TSC_EXECUTABLE"), [
            "--project",
            "tsconfig.json",
            "--pretty",
            "false",
          ]),
      });
    } catch (error) {
      context.diagnostic(`消费场景现场：${root}`);
      throw error;
    }
  });
}
