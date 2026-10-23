import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  DuplicateTranslationUnitKeyError,
  readFacts,
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

const enumerationSchema = v.picklist(["complete", "partial", "failed"]);
const readStatusSchema = v.picklist([
  "complete",
  "incomplete",
  "failed",
  "notRead",
]);

const factsSchema = standardSchema(
  v.object({
    version: v.string(),
    source: v.object({
      version: v.string(),
      read: v.object({
        status: readStatusSchema,
        scopes: v.array(
          v.object({
            range: v.unknown(),
            enumeration: enumerationSchema,
            recordCount: v.number(),
            error: v.optional(v.string()),
          }),
        ),
        error: v.optional(v.string()),
      }),
      totalUnitCount: v.nullable(v.number()),
      units: v.array(
        v.object({
          key: v.string(),
          unit: v.unknown(),
          bodyAvailability: v.picklist(["available", "unavailable"]),
          scopeIndex: v.number(),
        }),
      ),
    }),
    translations: v.object({
      reads: v.array(
        v.object({
          language: v.string(),
          status: readStatusSchema,
          scopes: v.array(
            v.object({
              range: v.unknown(),
              covers: v.array(v.string()),
              enumeration: enumerationSchema,
              translationIndexes: v.array(v.number()),
              error: v.optional(v.string()),
            }),
          ),
          error: v.optional(v.string()),
        }),
      ),
      records: v.array(
        v.object({
          index: v.number(),
          language: v.string(),
          scopeIndex: v.number(),
          range: v.unknown(),
          translation: v.unknown(),
          bodyAvailability: v.picklist(["available", "unavailable"]),
        }),
      ),
    }),
    associations: v.array(
      v.object({
        sourceKey: v.string(),
        language: v.string(),
        status: v.picklist([
          "matched",
          "missing",
          "unavailable",
          "unknown",
          "conflict",
        ]),
        coverageStatus: readStatusSchema,
        scopeIndexes: v.array(v.number()),
        translationIndexes: v.array(v.number()),
      }),
    ),
  }),
);

function readStatusText(status: string): string {
  return (
    {
      complete: "完整",
      incomplete: "不完整",
      failed: "失败",
      notRead: "未读取",
    }[status] ?? status
  );
}

function enumerationText(enumeration: string): string {
  return (
    {
      complete: "完整枚举",
      partial: "部分枚举",
      failed: "读取失败",
    }[enumeration] ?? enumeration
  );
}

function rangeText(range: unknown): string {
  return JSON.stringify(range) ?? "null";
}

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
        description: "读取宿主提供的源译事实。",
      },
      ...define.command("facts")({
        kind: "command",
        parent: "cli",
        name: "facts",
        description: "读取源译事实并计算宿主定义的关联。",
        fields: {
          config: { kind: "positional", description: "宿主配置文件路径" },
        },
        input: standardSchema(v.object({ config: v.string() })),
        success: {
          kind: "data",
          variants: {
            read: {
              description: "源译事实",
              exitCode: 0,
              schema: factsSchema,
              text: (facts) =>
                text.lines([
                  `源译事实（已知 ${facts.source.units.length} 个原文）`,
                  `事实版本：${facts.version}`,
                  `原文读取：${readStatusText(facts.source.read.status)}；总数：${facts.source.totalUnitCount ?? "未知"}`,
                  ...facts.source.read.scopes.map(
                    ({ range, enumeration, recordCount, error }) =>
                      `原文范围 ${rangeText(range)}：${enumerationText(enumeration)}，发现 ${recordCount} 条${error === undefined ? "" : `；${error}`}`,
                  ),
                  ...facts.source.units.flatMap(
                    ({ key, unit, bodyAvailability }) => [
                      `- ${key}（正文${bodyAvailability === "available" ? "可用" : "不可用"}）`,
                      `  ${JSON.stringify(unit) ?? "null"}`,
                    ],
                  ),
                  ...(facts.translations.reads.length === 0
                    ? ["目标语言：未配置"]
                    : facts.translations.reads.flatMap(
                        ({ language, status, scopes, error }) => [
                          `目标语言 ${language} 读取：${readStatusText(status)}${error === undefined ? "" : `；${error}`}`,
                          ...scopes.map(
                            ({
                              range,
                              covers,
                              enumeration,
                              translationIndexes,
                              error: scopeError,
                            }) =>
                              `  范围 ${rangeText(range)}：${enumerationText(enumeration)}；覆盖 ${covers.join(", ") || "无"}；译文 ${translationIndexes.join(", ") || "无"}${scopeError === undefined ? "" : `；${scopeError}`}`,
                          ),
                        ],
                      )),
                  ...facts.translations.records.map(
                    ({ index, language, translation, bodyAvailability }) =>
                      `译文 #${index}（${language}，正文${bodyAvailability === "available" ? "可用" : "不可用"}）：${JSON.stringify(translation) ?? "null"}`,
                  ),
                  ...facts.associations.map(
                    ({
                      sourceKey,
                      language,
                      status,
                      coverageStatus,
                      scopeIndexes,
                      translationIndexes,
                    }) =>
                      `关联 ${sourceKey} → ${language}：${status}（覆盖${readStatusText(coverageStatus)}，范围 ${scopeIndexes.join(", ") || "无"}，译文 ${translationIndexes.join(", ") || "无"}）`,
                  ),
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
            const facts = await readFacts(config);
            return outcome.data.read({
              ...facts,
              source: {
                ...facts.source,
                read: {
                  ...facts.source.read,
                  scopes: facts.source.read.scopes.map((scope) => ({
                    ...scope,
                  })),
                },
                units: facts.source.units.map((unit) => ({ ...unit })),
              },
              translations: {
                reads: facts.translations.reads.map((read) => ({
                  ...read,
                  scopes: read.scopes.map((scope) => ({
                    ...scope,
                    covers: [...scope.covers],
                    translationIndexes: [...scope.translationIndexes],
                  })),
                })),
                records: facts.translations.records.map((record) => ({
                  ...record,
                })),
              },
              associations: facts.associations.map((association) => ({
                ...association,
                scopeIndexes: [...association.scopeIndexes],
                translationIndexes: [...association.translationIndexes],
              })),
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
