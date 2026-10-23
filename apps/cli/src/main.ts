import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  DuplicateTranslationUnitKeyError,
  readSourceFacts,
  type FrameworkConfig,
  type TranslationUnitInput,
} from "@l10n/core";
import {
  CliWriteError,
  defineCli,
  executeCli,
  helpCapability,
  outputCapability,
  parseCliInvocation,
  text,
  versionCapability,
  type WriteCliOutput,
} from "@ykdz/cli-contract";
import { isNodeBrokenPipe } from "@ykdz/cli-contract/node";
import * as v from "valibot";

import type { CliCommandIdentity } from "./cli-command-identity.ts";
import { standardSchema } from "./standard-schema.ts";

export type CliRuntime = {
  readonly argv: readonly string[];
  readonly write: WriteCliOutput;
  readonly identity: CliCommandIdentity;
};

const sourceFactsSchema = standardSchema(
  v.object({
    version: v.string(),
    units: v.array(
      v.object({
        key: v.string(),
        unit: v.unknown(),
      }),
    ),
  }),
);

function createCliContract(identity: CliCommandIdentity) {
  const define = defineCli<undefined>();
  return define({
    root: "cli",
    help: helpCapability({
      shortAlias: "-h",
      headings: {
        usage: "用法",
        commands: "命令",
        arguments: "参数",
        options: "选项",
      },
      wording: {
        commandPlaceholder: "命令",
        choices: "候选：{choices}",
        default: "默认：{value}",
      },
    }),
    version: versionCapability({
      value: text.line(`${identity.commandName} ${identity.version}`),
      shortAlias: "-V",
    }),
    output: outputCapability({ defaultFormat: "structured", text: true }),
    usageFailureExitCode: 2,
    commands: {
      cli: {
        kind: "rootGroup",
        name: identity.commandName,
        description: "读取宿主提供的原文事实。",
      },
      ...define.command("facts")({
        kind: "command",
        parent: "cli",
        name: "facts",
        description: "读取原文单元并计算宿主定义的身份。",
        fields: {
          config: { kind: "positional", description: "宿主配置文件路径" },
        },
        input: standardSchema(v.object({ config: v.string() })),
        success: {
          kind: "data",
          variants: {
            read: {
              description: "原文事实",
              exitCode: 0,
              schema: sourceFactsSchema,
              text: ({ version, units }) =>
                text.lines([
                  `原文事实（${units.length} 个单元）`,
                  `事实版本：${version}`,
                  ...units.flatMap(({ key, unit }) => [
                    `- ${key}`,
                    `  ${JSON.stringify(unit) ?? "null"}`,
                  ]),
                ]),
            },
          },
        },
        failures: {
          duplicateIdentity: {
            description: "原文身份重复",
            exitCode: 1,
            schema: standardSchema(
              v.object({
                key: v.string(),
                firstIndex: v.number(),
                duplicateIndex: v.number(),
              }),
            ),
            text: ({ key, firstIndex, duplicateIndex }) =>
              text.line(
                `原文身份重复：${key}（第 ${firstIndex + 1} 与第 ${duplicateIndex + 1} 个单元）。`,
              ),
          },
          readFailed: {
            description: "读取原文事实失败",
            exitCode: 1,
            schema: standardSchema(v.object({ message: v.string() })),
            text: ({ message }) => text.line(`读取原文事实失败：${message}`),
          },
        },
        async handler({ input, outcome }) {
          try {
            const configUrl = pathToFileURL(
              resolve(process.cwd(), input.config),
            );
            const configModule = (await import(configUrl.href)) as {
              readonly default?: unknown;
            };
            if (configModule.default === undefined)
              throw new TypeError(
                "宿主配置必须默认导出 defineConfig(...) 的结果。",
              );
            const config =
              configModule.default as FrameworkConfig<TranslationUnitInput>;
            const facts = await readSourceFacts(config);
            return outcome.data.read({
              version: facts.version,
              units: [...facts.units],
            });
          } catch (error) {
            if (error instanceof DuplicateTranslationUnitKeyError)
              return outcome.failure.duplicateIdentity({
                key: error.key,
                firstIndex: error.firstIndex,
                duplicateIndex: error.duplicateIndex,
              });
            return outcome.failure.readFailed({
              message: error instanceof Error ? error.message : String(error),
            });
          }
        },
      }),
    },
  });
}

export async function runCli(runtime: CliRuntime): Promise<number> {
  try {
    const contract = createCliContract(runtime.identity);
    const result = await executeCli(contract, {
      invocation: parseCliInvocation(contract, runtime.argv.slice(2)),
      dependencies: undefined,
      write: runtime.write,
    });
    return result.exitCode;
  } catch (error) {
    if (
      error instanceof CliWriteError &&
      error.destination === "stdout" &&
      isNodeBrokenPipe(error)
    )
      return 0;
    try {
      await runtime.write({
        destination: "stderr",
        chunk: "命令执行失败；请检查运行环境或报告此问题。\n",
      });
    } catch {
      // 诊断通道故障不能改变原定退出类别。
    }
    return 70;
  }
}
