import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  CompletionConfigurationError,
  DuplicateTranslationUnitKeyError,
  readFacts,
  readCompletion,
  runQualityChecks,
  type FrameworkConfig,
  type FrameworkFacts,
  type QualityCheckDefinition,
  type QualityCheckRequest,
  type QualityRunResult,
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

const completionSchema = standardSchema(
  v.object({
    factsVersion: v.string(),
    criterion: v.string(),
    status: v.picklist(["complete", "incomplete", "unknown"]),
    scope: v.object({
      sourceReadStatus: readStatusSchema,
      sourceUnitCount: v.nullable(v.number()),
      knownSourceUnitCount: v.number(),
      targetLanguages: v.array(v.string()),
      obligationCount: v.nullable(v.number()),
      knownObligationCount: v.number(),
      unknownTotalReason: v.optional(v.string()),
    }),
    confirmedCompleteCount: v.number(),
    confirmedIncompleteCount: v.number(),
    unknownCount: v.number(),
    completionRate: v.nullable(v.number()),
    obligations: v.array(
      v.object({
        sourceKey: v.string(),
        language: v.string(),
        status: v.picklist(["complete", "incomplete", "unknown"]),
        associationStatus: v.picklist([
          "matched",
          "missing",
          "unavailable",
          "unknown",
          "conflict",
        ]),
        coverageStatus: readStatusSchema,
        sourceBodyAvailability: v.picklist(["available", "unavailable"]),
        translationIndexes: v.array(v.number()),
        reason: v.optional(v.string()),
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

function completionStatusText(status: string): string {
  return (
    { complete: "完成", incomplete: "未完成", unknown: "未知" }[status] ??
    status
  );
}

type CliConfigModule = {
  readonly default?: unknown;
};

async function loadConfigModule(configPath: string): Promise<CliConfigModule> {
  const configUrl = pathToFileURL(resolve(process.cwd(), configPath));
  return (await import(configUrl.href)) as CliConfigModule;
}

function frameworkConfig(
  configModule: CliConfigModule,
): FrameworkConfig<TranslationUnitInput> {
  if (configModule.default === undefined)
    throw new TypeError("宿主配置必须默认导出 defineConfig(...) 的结果。");
  return configModule.default as FrameworkConfig<TranslationUnitInput>;
}

async function loadConfig(
  configPath: string,
): Promise<FrameworkConfig<TranslationUnitInput>> {
  return frameworkConfig(await loadConfigModule(configPath));
}

function qualityStatusText(status: string): string {
  return (
    {
      "not-run": "未执行",
      "not-applicable": "不适用",
      incomplete: "不完整",
      failed: "失败",
      complete: "完整",
    }[status] ?? status
  );
}

function qualityText(value: unknown): ReturnType<typeof text.lines> {
  const result = value as QualityRunResult;
  return text.lines([
    `质量检查：${qualityStatusText(result.status)}`,
    `事实版本：${result.version}`,
    `检查对象：${result.subjects.length}；诊断：${result.diagnostics.length}`,
    ...result.diagnostics.map(
      ({ ruleId, severity, object, location, message, evidence, handling }) => {
        const locationKey =
          location.key === undefined ? "" : `，位置键 ${location.key}`;
        const exception =
          handling.status === "excepted"
            ? `；例外 ${handling.exceptionId}：${handling.reason}`
            : "";
        return `[${severity}] ${ruleId} ${object.key}（${location.language ?? "原文"}，${rangeText(location.range)}${locationKey}）：${message}${exception}；证据 ${evidence.length} 项`;
      },
    ),
    ...result.checks.flatMap(({ id, status, issues }) =>
      issues.map(
        ({ message }) => `[${qualityStatusText(status)}] ${id}：${message}`,
      ),
    ),
  ]);
}

function defaultQualityRequest<
  TUnit extends TranslationUnitInput,
  TTranslation,
>(facts: FrameworkFacts<TUnit, TTranslation>): QualityCheckRequest {
  const subjects = facts.associations.map(({ sourceKey, language }) => ({
    key: sourceKey,
    language,
  }));
  return {
    subjects,
    evidenceScope: subjects.map(({ key, language }) => ({
      kind: "translation-unit",
      key,
      language,
    })),
    dependencies: {},
  };
}

function configuredQualityChecks(
  config: FrameworkConfig<TranslationUnitInput>,
): readonly QualityCheckDefinition<TranslationUnitInput, unknown>[] {
  const checks = config.qualityChecks;
  if (checks === undefined) return [];
  if (!Array.isArray(checks))
    throw new TypeError("defineConfig 的 qualityChecks 必须是检查器数组。");
  return checks;
}

async function createConfiguredQualityRequest(
  config: FrameworkConfig<TranslationUnitInput>,
  facts: FrameworkFacts<TranslationUnitInput, unknown>,
): Promise<QualityCheckRequest> {
  const request = config.createQualityRequest;
  if (request === undefined) return defaultQualityRequest(facts);
  if (typeof request !== "function")
    throw new TypeError("defineConfig 的 createQualityRequest 必须是函数。");
  return await request(facts);
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
            const config = await loadConfig(input.config);
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
      ...define.command("completion")({
        kind: "command",
        parent: "cli",
        name: "completion",
        description: "按宿主判据计算本地化义务与完成统计。",
        fields: {
          config: { kind: "positional", description: "宿主配置文件路径" },
        },
        input: standardSchema(v.object({ config: v.string() })),
        success: {
          kind: "data",
          variants: {
            read: {
              description: "义务与完成统计",
              exitCode: 0,
              schema: completionSchema,
              text: (completion) =>
                text.lines([
                  `完成统计：${completionStatusText(completion.status)}`,
                  `事实版本：${completion.factsVersion}`,
                  `判据：${completion.criterion}`,
                  `统计范围：${completion.scope.knownSourceUnitCount} 个已知原文，${completion.scope.targetLanguages.join(", ") || "无目标语言"}`,
                  `原文总数：${completion.scope.sourceUnitCount ?? "未知"}（${readStatusText(completion.scope.sourceReadStatus)}）`,
                  `义务：${completion.scope.knownObligationCount}/${completion.scope.obligationCount ?? "未知"}`,
                  `完成 ${completion.confirmedCompleteCount}；未完成 ${completion.confirmedIncompleteCount}；未知 ${completion.unknownCount}`,
                  `完成率：${completion.completionRate === null ? "未知" : `${(completion.completionRate * 100).toFixed(1)}%`}`,
                  ...(completion.scope.unknownTotalReason === undefined
                    ? []
                    : [`总数未知原因：${completion.scope.unknownTotalReason}`]),
                  ...completion.obligations.map(
                    ({
                      sourceKey,
                      language,
                      status,
                      associationStatus,
                      coverageStatus,
                      sourceBodyAvailability,
                      translationIndexes,
                      reason,
                    }) =>
                      `- ${sourceKey} → ${language}：${completionStatusText(status)}（原文正文${sourceBodyAvailability === "available" ? "可用" : "不可用"}，关联 ${associationStatus}，覆盖${readStatusText(coverageStatus)}，译文 ${translationIndexes.join(", ") || "无"}${reason === undefined ? "" : `；${reason}`}）`,
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
          configurationRequired: {
            description: "完成统计配置不完整",
            exitCode: 1,
            schema: standardSchema(
              v.object({
                reason: v.picklist(["missingPolicy", "missingTranslations"]),
                message: v.string(),
              }),
            ),
            text: ({ message }) => text.line(`无法计算完成统计：${message}`),
          },
          readFailed: {
            description: "读取完成事实失败",
            exitCode: 1,
            schema: standardSchema(v.object({ message: v.string() })),
            text: ({ message }) => text.line(`读取完成事实失败：${message}`),
          },
        },
        async handler({ input, outcome }) {
          try {
            const facts = await readCompletion(await loadConfig(input.config));
            return outcome.data.read({
              ...facts.completion,
              scope: {
                ...facts.completion.scope,
                targetLanguages: [...facts.completion.scope.targetLanguages],
              },
              obligations: facts.completion.obligations.map((obligation) => ({
                ...obligation,
                translationIndexes: [...obligation.translationIndexes],
              })),
            });
          } catch (error) {
            if (error instanceof DuplicateTranslationUnitKeyError)
              return outcome.failure.duplicateIdentity({
                key: error.key,
                firstIndex: error.firstIndex,
                duplicateIndex: error.duplicateIndex,
              });
            if (error instanceof CompletionConfigurationError)
              return outcome.failure.configurationRequired({
                reason: error.reason,
                message: error.message,
              });
            return outcome.failure.readFailed({
              message: error instanceof Error ? error.message : String(error),
            });
          }
        },
      }),
      ...define.command("qa")({
        kind: "command",
        parent: "cli",
        name: "qa",
        description: "使用宿主显式选择的检查器检查当前事实。",
        fields: {
          config: { kind: "positional", description: "宿主配置文件路径" },
        },
        input: standardSchema(v.object({ config: v.string() })),
        success: {
          kind: "data",
          variants: {
            checked: {
              description: "质量检查结果",
              exitCode: 0,
              schema: standardSchema(v.record(v.string(), v.unknown())),
              text: qualityText,
            },
          },
        },
        failures: {
          checkFailed: {
            description: "读取事实或执行质量检查失败",
            exitCode: 1,
            schema: standardSchema(v.object({ message: v.string() })),
            text: ({ message }) => text.line(`质量检查失败：${message}`),
          },
        },
        async handler({ input, outcome }) {
          try {
            const configModule = await loadConfigModule(input.config);
            const config = frameworkConfig(configModule);
            const facts = await readFacts(config);
            const checks = configuredQualityChecks(config);
            const request = await createConfiguredQualityRequest(config, facts);
            const result = await runQualityChecks(facts, request, checks);
            return outcome.data.checked(result);
          } catch (error) {
            return outcome.failure.checkFailed({
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
