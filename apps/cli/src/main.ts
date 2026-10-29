import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  analyzeQuality,
  DuplicateTranslationUnitKeyError,
  decideQualityReport,
  formatQualityReport,
  readFacts,
  previewUpdate,
  recordComparisonBaseline,
  upsertQualityExceptionFromReport,
  update,
  type FrameworkConfig,
  type LanguageSelectionOptions,
  type QualityRunResult,
  type TranslationUnitInput,
  type UpdatePlan,
} from "@lioni/core";
import {
  createFileComparisonBaselineStore,
  loadConfig,
} from "@lioni/core/node";
import { toStandardJsonSchema } from "@valibot/to-json-schema";
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

export type CliRuntime = {
  readonly argv: readonly string[];
  readonly write: WriteCliOutput;
  readonly identity: CliCommandIdentity;
};

const languageOption = {
  kind: "repeatableOption",
  longOption: "--language",
  description: "本次执行的目标语言；可重复指定，省略时执行全部已配置语言",
} as const;

const languagesSchema = v.optional(v.array(v.string()));
const scopedConfigSchema = toStandardJsonSchema(
  v.object({ config: v.string(), languages: languagesSchema }),
);

function languageSelection(input: {
  readonly languages?: readonly string[] | undefined;
}): LanguageSelectionOptions {
  return input.languages === undefined ? {} : { languages: input.languages };
}

const enumerationSchema = v.picklist(["complete", "partial", "failed"]);
const readStatusSchema = v.picklist([
  "complete",
  "incomplete",
  "failed",
  "notRead",
]);

const factsSchema = toStandardJsonSchema(
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
        v.variant("bodyAvailability", [
          v.strictObject({
            index: v.number(),
            language: v.string(),
            scopeIndex: v.number(),
            range: v.unknown(),
            identity: v.strictObject({
              language: v.string(),
              namespace: v.string(),
              key: v.string(),
            }),
            translation: v.unknown(),
            content: v.unknown(),
            bodyAvailability: v.literal("available"),
          }),
          v.strictObject({
            index: v.number(),
            language: v.string(),
            scopeIndex: v.number(),
            range: v.unknown(),
            identity: v.strictObject({
              language: v.string(),
              namespace: v.string(),
              key: v.string(),
            }),
            translation: v.unknown(),
            bodyAvailability: v.literal("unavailable"),
          }),
        ]),
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

const baselineRecordSchema = toStandardJsonSchema(
  v.object({
    outcome: v.picklist(["saved", "unchanged"]),
    path: v.string(),
    sourceScopeCount: v.number(),
    sourceUnitCount: v.number(),
    translationScopeCount: v.number(),
    translationRecordCount: v.number(),
  }),
);
const updatePlanSchema = toStandardJsonSchema(
  v.record(v.string(), v.unknown()),
);
const updateResultSchema = toStandardJsonSchema(
  v.object({
    plan: v.record(v.string(), v.unknown()),
    status: v.picklist(["completed", "failed"]),
    results: v.array(v.record(v.string(), v.unknown())),
    batchError: v.optional(v.object({ name: v.string(), message: v.string() })),
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

function qualityText(value: unknown): ReturnType<typeof text.lines> {
  const lines = formatQualityReport(value as QualityRunResult).split("\n");
  return text.lines([lines[0] ?? "", ...lines.slice(1)]);
}

function comparisonStatusText(status: string): string {
  return (
    {
      historyMissing: "没有历史参照",
      historyInsufficient: "历史依据不足",
      currentInsufficient: "当前依据不足",
      bothInsufficient: "两侧依据不足",
      added: "新增",
      removed: "移除",
      modified: "已变化",
      unchanged: "未变化",
    }[status] ?? "状态未知"
  );
}

const updateActionNames: Readonly<Record<string, string>> = {
  write: "补入待译占位",
  delete: "删除译文",
  retain: "保留",
  review: "待复核",
  blocked: "暂不可执行",
};

function updatePlanText(value: unknown): ReturnType<typeof text.lines> {
  const plan = value as UpdatePlan;
  const decidedSourceKeys = new Set(
    plan.items.flatMap((item) =>
      item.changes.source === undefined ? [] : [item.changes.source.key],
    ),
  );
  const decidedTranslationKeys = new Set(
    plan.items.flatMap((item) =>
      item.changes.translations.map(({ identity }) =>
        updateIdentityKey(identity),
      ),
    ),
  );
  const unassignedSources = plan.comparisons.sourceChanges.filter(
    ({ key, status }) => status !== "unchanged" && !decidedSourceKeys.has(key),
  );
  const unassignedTranslations = plan.comparisons.translationChanges.filter(
    ({ identity, status }) =>
      status !== "unchanged" &&
      !decidedTranslationKeys.has(updateIdentityKey(identity)),
  );
  const unassignedCount =
    unassignedSources.length + unassignedTranslations.length;

  if (plan.items.length === 0 && unassignedCount === 0)
    return text.lines(["没有变化，也没有需要处理的更新决定。"]);

  return text.lines([
    `更新预览：${plan.items.length} 项决定，${unassignedCount} 项变化未形成决定。`,
    ...plan.items.flatMap((item) => {
      const subject =
        item.sourceKey === undefined
          ? `${item.target?.namespace ?? "目标"}:${item.target?.key ?? "多条"}（${item.language}）`
          : `${item.sourceKey} → ${item.language}`;
      const actionName =
        item.action === "write" && item.changes.source?.status === "modified"
          ? "重置待译占位"
          : (updateActionNames[item.action] ?? "更新");
      const lines = [`${actionName} ${subject}：${item.reason}`];
      if (item.changes.source !== undefined) {
        const { previous, current, status } = item.changes.source;
        lines.push(
          `  原文（${comparisonStatusText(status)}）：${displayJson(previous?.unit.source)} → ${displayJson(current?.unit.source)}`,
        );
      }
      for (const change of item.changes.translations) {
        const previous =
          change.previous?.bodyAvailability === "available"
            ? change.previous.content
            : change.previous === undefined
              ? undefined
              : "正文不可用";
        const current =
          change.current?.bodyAvailability === "available"
            ? change.current.content
            : change.current === undefined
              ? undefined
              : "正文不可用";
        lines.push(
          `  译文 ${change.identity.key}（${comparisonStatusText(change.status)}）：${displayJson(previous)} → ${displayJson(current)}`,
        );
      }
      if (item.targets !== undefined)
        lines.push(
          `  匹配目标：${item.targets.map(({ namespace, key }) => `${namespace}:${key}`).join("、")}`,
        );
      if (item.after !== undefined)
        lines.push(`  待写正文：${displayJson(item.after.content)}`);
      return lines;
    }),
    ...(unassignedCount === 0
      ? []
      : [
          "未形成更新决定的变化：",
          ...unassignedSources.flatMap((change) => [
            `  原文 ${change.key}（${comparisonStatusText(change.status)}）：${displayJson(change.previous?.unit.source)} → ${displayJson(change.current?.unit.source)}`,
            `    原因：${unassignedChangeReason("原文", change.status)}`,
          ]),
          ...unassignedTranslations.flatMap((change) => {
            const previous =
              change.previous?.bodyAvailability === "available"
                ? change.previous.content
                : change.previous === undefined
                  ? undefined
                  : "正文不可用";
            const current =
              change.current?.bodyAvailability === "available"
                ? change.current.content
                : change.current === undefined
                  ? undefined
                  : "正文不可用";
            return [
              `  译文 ${change.identity.key}（${comparisonStatusText(change.status)}）：${displayJson(previous)} → ${displayJson(current)}`,
              `    原因：${unassignedChangeReason("译文", change.status)}`,
            ];
          }),
        ]),
  ]);
}

function unassignedChangeReason(
  subject: "原文" | "译文",
  status: UpdatePlan["comparisons"]["sourceChanges"][number]["status"],
): string {
  if (status === "removed")
    return `${subject}已从完整范围移除，当前没有对应记录可供处理。`;
  if (status === "added") return `${subject}为本次新增，但没有对应的更新决定。`;
  if (status === "modified") return `${subject}已变化，但没有对应的更新决定。`;
  return `${subject}的变化没有关联到更新决定。`;
}

function updateIdentityKey(identity: {
  readonly language: string;
  readonly namespace: string;
  readonly key: string;
}): string {
  return JSON.stringify([identity.language, identity.namespace, identity.key]);
}

function updateResultText(value: unknown): ReturnType<typeof text.lines> {
  const result = value as {
    readonly plan: UpdatePlan;
    readonly status: "completed" | "failed";
    readonly results: readonly {
      readonly index: number;
      readonly action: string;
      readonly status: string;
      readonly reason?: string;
    }[];
    readonly batchError?: { readonly name: string; readonly message: string };
  };
  const statusNames: Readonly<Record<string, string>> = {
    written: "已写入",
    writeUnconfirmed: "写入结果未确认",
    conflict: "目标已变化，未写入",
    notWritable: "当前无法写入",
    writeFailed: "写入失败",
    retained: "已保留",
    review: "待复核",
    blocked: "暂不可执行",
  };
  return text.lines([
    `更新执行${result.status === "completed" ? "完成" : "未完整完成"}：${result.results.length} 项决定。`,
    ...result.results.map(({ index, action, status, reason }) => {
      const item = result.plan.items[index];
      const subject =
        item === undefined
          ? `第 ${index + 1} 项`
          : item.sourceKey === undefined
            ? `${item.target?.namespace ?? "目标"}:${item.target?.key ?? "多条"}（${item.language}）`
            : `${item.sourceKey} → ${item.language}`;
      return `${updateActionNames[action] ?? "更新"} ${subject}：${statusNames[status] ?? "未完成"}${reason === undefined ? "" : `；${reason}`}`;
    }),
    ...(result.batchError === undefined
      ? []
      : [
          `批量写回抛出异常（逐项实际结果见上）：${result.batchError.name}: ${result.batchError.message}`,
        ]),
  ]);
}

function cliUpdateResult<TResult extends { readonly batchError?: unknown }>(
  result: TResult,
): Omit<TResult, "batchError"> & {
  readonly batchError?: { readonly name: string; readonly message: string };
} {
  if (!Object.hasOwn(result, "batchError"))
    return result as Omit<TResult, "batchError"> & {
      readonly batchError?: { readonly name: string; readonly message: string };
    };
  const error = result.batchError;
  return {
    ...result,
    batchError: {
      name: error instanceof Error ? error.name : "ThrownValue",
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

function displayJson(value: unknown): string {
  return value === undefined ? "无" : (JSON.stringify(value) ?? "无");
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
      ...define.command("baseline")({
        kind: "command",
        parent: "cli",
        name: "baseline",
        description: "记录当前完整源译事实作为比较基线。",
        fields: {
          config: { kind: "positional", description: "宿主配置文件路径" },
        },
        input: toStandardJsonSchema(v.object({ config: v.string() })),
        success: {
          kind: "data",
          variants: {
            recorded: {
              description: "比较基线记录结果",
              exitCode: 0,
              schema: baselineRecordSchema,
              text: (result) =>
                text.lines([
                  result.outcome === "saved"
                    ? `比较基线已保存：${result.path}`
                    : `比较基线没有变化：${result.path}`,
                  `原文范围 ${result.sourceScopeCount} 个、原文单元 ${result.sourceUnitCount} 个；译文范围 ${result.translationScopeCount} 个、实际译文 ${result.translationRecordCount} 条。`,
                ]),
            },
          },
        },
        failures: {
          recordFailed: {
            description: "记录比较基线失败",
            exitCode: 1,
            schema: toStandardJsonSchema(
              v.object({ path: v.string(), message: v.string() }),
            ),
            text: ({ path: baselinePath, message }) =>
              text.line(
                `记录比较基线失败（未保存 ${baselinePath}）：${message}`,
              ),
          },
        },
        async handler({ input, outcome }) {
          const configPath = path.resolve(process.cwd(), input.config);
          const baselinePath = path.join(
            path.dirname(configPath),
            "lioni.baseline.json",
          );
          try {
            const config = await loadConfig(configPath);
            const result = await recordBaselineForConfig(config, baselinePath);
            const snapshot = result.baseline.snapshot;
            return outcome.data.recorded({
              outcome: result.outcome,
              path: baselinePath,
              sourceScopeCount: snapshot.source.read.scopes.length,
              sourceUnitCount: snapshot.source.units.length,
              translationScopeCount: snapshot.translations.reads.reduce(
                (count, read) => count + read.scopes.length,
                0,
              ),
              translationRecordCount: snapshot.translations.records.length,
            });
          } catch (error) {
            return outcome.failure.recordFailed({
              path: baselinePath,
              message: error instanceof Error ? error.message : String(error),
            });
          }
        },
      }),
      ...define.command("update")({
        kind: "command",
        parent: "cli",
        name: "update",
        description: "预览更新决定，或按决定写入译文资源。",
        fields: {
          config: { kind: "positional", description: "宿主配置文件路径" },
          languages: languageOption,
          dryRun: {
            kind: "flag",
            longOption: "--dry-run",
            description: "只预览更新决定",
          },
        },
        input: toStandardJsonSchema(
          v.object({
            config: v.string(),
            languages: languagesSchema,
            dryRun: v.optional(v.boolean()),
          }),
        ),
        success: {
          kind: "data",
          variants: {
            previewed: {
              description: "更新预览",
              exitCode: 0,
              schema: updatePlanSchema,
              text: updatePlanText,
            },
            applied: {
              description: "更新执行结果",
              exitCode: 0,
              schema: updateResultSchema,
              text: updateResultText,
            },
          },
        },
        failures: {
          previewFailed: {
            description: "更新预览失败",
            exitCode: 1,
            schema: toStandardJsonSchema(v.object({ message: v.string() })),
            text: ({ message }) => text.line(`更新预览失败：${message}`),
          },
          applyFailed: {
            description: "更新未完整执行",
            exitCode: 1,
            schema: updateResultSchema,
            text: updateResultText,
          },
        },
        async handler({ input, outcome }) {
          const configPath = path.resolve(process.cwd(), input.config);
          const baselinePath = path.join(
            path.dirname(configPath),
            "lioni.baseline.json",
          );
          try {
            const config = await loadConfig(configPath);
            if (input.dryRun === true) {
              const plan = await previewUpdateForConfig(
                config,
                baselinePath,
                languageSelection(input),
              );
              return outcome.data.previewed(plan);
            }
            const result = await updateForConfig(
              config,
              baselinePath,
              languageSelection(input),
            );
            const cliResult = cliUpdateResult(result);
            return result.status === "completed"
              ? outcome.data.applied(cliResult)
              : outcome.failure.applyFailed(cliResult);
          } catch (error) {
            return outcome.failure.previewFailed({
              message: error instanceof Error ? error.message : String(error),
            });
          }
        },
      }),
      ...define.command("inspect")({
        kind: "command",
        parent: "cli",
        name: "inspect",
        description: "查看原文、译文及对应关系，了解缺失、冲突和读取情况。",
        fields: {
          config: { kind: "positional", description: "宿主配置文件路径" },
          languages: languageOption,
        },
        input: scopedConfigSchema,
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
            schema: toStandardJsonSchema(
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
            schema: toStandardJsonSchema(v.object({ message: v.string() })),
            text: ({ message }) => text.line(`读取原文事实失败：${message}`),
          },
        },
        async handler({ input, outcome }) {
          try {
            const config = await loadConfig(input.config);
            const facts = await readFacts(config, languageSelection(input));
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
      exceptions: {
        kind: "commandGroup",
        parent: "cli",
        name: "exceptions",
        description: "从 QA 报告维护例外记录。",
      },
      ...define.command("exceptionsUpsert")({
        kind: "command",
        parent: "exceptions",
        name: "upsert",
        description: "从已有 QA 报告创建或更新一条例外。",
        fields: {
          config: { kind: "positional", description: "宿主配置文件路径" },
          report: {
            kind: "positional",
            description: "SDK 或 CLI QA 报告 JSON 文件路径",
          },
          checkId: {
            kind: "valueOption",
            longOption: "--check-id",
            description: "报告中的检查项身份",
          },
          executionId: {
            kind: "valueOption",
            longOption: "--execution-id",
            description: "报告中的候选执行身份",
          },
          id: {
            kind: "valueOption",
            longOption: "--id",
            description: "例外身份",
          },
          reason: {
            kind: "valueOption",
            longOption: "--reason",
            description: "例外理由",
          },
        },
        input: toStandardJsonSchema(
          v.object({
            config: v.string(),
            report: v.string(),
            checkId: v.string(),
            executionId: v.string(),
            id: v.string(),
            reason: v.string(),
          }),
        ),
        success: {
          kind: "data",
          variants: {
            upserted: {
              description: "例外已写入配置选定的存储",
              exitCode: 0,
              schema: toStandardJsonSchema(
                v.object({
                  id: v.string(),
                  checkId: v.string(),
                  sourceKey: v.string(),
                  language: v.string(),
                  executionId: v.number(),
                }),
              ),
              text: ({ id, checkId, sourceKey, language, executionId }) =>
                text.line(
                  `例外 ${id} 已更新：${checkId} ${sourceKey} → ${language}（执行 ${executionId}）。`,
                ),
            },
          },
        },
        failures: {
          upsertFailed: {
            description: "从 QA 报告创建或更新例外失败",
            exitCode: 1,
            schema: toStandardJsonSchema(
              v.object({ path: v.string(), message: v.string() }),
            ),
            text: ({ path: reportPath, message }) =>
              text.line(`根据报告 ${reportPath} 更新 QA 例外失败：${message}`),
          },
        },
        async handler({ input, outcome }) {
          const reportPath = path.resolve(process.cwd(), input.report);
          try {
            const report = JSON.parse(
              await readFile(reportPath, "utf8"),
            ) as unknown;
            const configPath = path.resolve(process.cwd(), input.config);
            const config = await loadConfig(configPath);
            const executionId = Number(input.executionId);
            const store = config.quality?.exceptionStore;
            if (store === undefined)
              throw new TypeError("配置未提供 QA 例外存储。");
            const exception = await upsertQualityExceptionFromReport({
              report,
              checkId: input.checkId,
              executionId,
              id: input.id,
              reason: input.reason,
              store,
            });
            return outcome.data.upserted({
              id: exception.id,
              checkId: exception.checkId,
              sourceKey: exception.sourceKey,
              language: exception.language,
              executionId,
            });
          } catch (error) {
            return outcome.failure.upsertFailed({
              path: reportPath,
              message: error instanceof Error ? error.message : String(error),
            });
          }
        },
      }),
      ...define.command("qa")({
        kind: "command",
        parent: "cli",
        name: "qa",
        description:
          "默认输出简洁中文质量报告；使用 --output-format structured 查看完整结构化结果。",
        fields: {
          config: { kind: "positional", description: "宿主配置文件路径" },
          languages: languageOption,
        },
        input: scopedConfigSchema,
        success: {
          kind: "data",
          variants: {
            checked: {
              description: "质量检查结果",
              exitCode: 0,
              schema: toStandardJsonSchema(v.record(v.string(), v.unknown())),
              text: qualityText,
            },
            notPassed: {
              description: "质量检查未通过",
              exitCode: 1,
              schema: toStandardJsonSchema(v.record(v.string(), v.unknown())),
              text: qualityText,
            },
          },
        },
        failures: {
          checkFailed: {
            description: "读取事实或执行质量检查失败",
            exitCode: 1,
            schema: toStandardJsonSchema(v.object({ message: v.string() })),
            text: ({ message }) => text.line(`质量检查失败：${message}`),
          },
        },
        async handler({ input, outcome }) {
          try {
            const config = await loadConfig(input.config);
            const result = await analyzeQuality(
              config,
              languageSelection(input),
            );
            return decideQualityReport(result).passed
              ? outcome.data.checked(result)
              : outcome.data.notPassed(result);
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

function recordBaselineForConfig<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  config: FrameworkConfig<TUnit, TTranslation, TBody, TUnavailable>,
  baselinePath: string,
) {
  const store = createFileComparisonBaselineStore<
    TUnit,
    TTranslation,
    TBody,
    TUnavailable
  >(baselinePath);
  return recordComparisonBaseline(config, store);
}

function previewUpdateForConfig<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  config: FrameworkConfig<TUnit, TTranslation, TBody, TUnavailable>,
  baselinePath: string,
  options: LanguageSelectionOptions,
) {
  const store = createFileComparisonBaselineStore<
    TUnit,
    TTranslation,
    TBody,
    TUnavailable
  >(baselinePath);
  return previewUpdate(config, store, options);
}

function updateForConfig<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  config: FrameworkConfig<TUnit, TTranslation, TBody, TUnavailable>,
  baselinePath: string,
  options: LanguageSelectionOptions,
) {
  const store = createFileComparisonBaselineStore<
    TUnit,
    TTranslation,
    TBody,
    TUnavailable
  >(baselinePath);
  return update(config, store, options);
}

export async function runCli(runtime: CliRuntime): Promise<number> {
  try {
    const contract = createCliContract(runtime.identity);
    const result = await executeCli(contract, {
      invocation: parseCliInvocation(
        contract,
        defaultQualityOutput(runtime.argv.slice(2)),
      ),
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

function defaultQualityOutput(args: readonly string[]): readonly string[] {
  if (
    args[0] !== "qa" ||
    args.includes("--output-format") ||
    args.some((argument) => argument.startsWith("--output-format="))
  )
    return args;
  return [...args, "--output-format", "text"];
}
