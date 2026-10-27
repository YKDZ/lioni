import path from "node:path";

import {
  analyzeQuality,
  CompletionConfigurationError,
  DuplicateTranslationUnitKeyError,
  readFacts,
  readCompletion,
  previewUpdate,
  recordComparisonBaseline,
  update,
  type FrameworkConfig,
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

const completionSchema = toStandardJsonSchema(
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
    `检查候选：${result.candidates.length}；诊断：${result.diagnostics.length}`,
    `原文读取：${readStatusText(result.factCoverage.source.status)}；译文读取：${result.factCoverage.translations.map(({ language, status }) => `${language} ${readStatusText(status)}`).join("、") || "无"}`,
    ...result.factCoverage.associations
      .filter(
        ({ status, candidateSelected }) =>
          status !== "matched" || !candidateSelected,
      )
      .map(
        ({ sourceKey, language, status, coverageStatus, candidateSelected }) =>
          `关联 ${sourceKey} → ${language}：${status}（覆盖${readStatusText(coverageStatus)}；${candidateSelected ? "已选候选" : "未选候选"}）`,
      ),
    ...result.diagnostics.map(
      ({
        checkId,
        executionId,
        severity,
        object,
        location,
        message,
        evidence,
        handling,
      }) => {
        const locationKey =
          location.key === undefined ? "" : `，位置键 ${location.key}`;
        const exception =
          handling.status === "excepted"
            ? `；例外 ${handling.exceptionId}：${handling.reason}`
            : "";
        return `[${severity}] ${checkId} ${object.key}（${location.language ?? "原文"}，${rangeText(location.range)}${locationKey}，执行 ${executionId}）：${message}${exception}；证据 ${evidence.length} 项`;
      },
    ),
    ...result.checks.flatMap(
      ({ checkId, version, executions, issues, status }) => [
        ...executions.map(
          ({
            executionId,
            candidateIndex,
            sourceKey,
            language,
            status: executionStatus,
            inputFingerprint,
            fingerprintSummary,
          }) =>
            `检查依据 ${checkId} ${sourceKey} → ${language}（第 ${candidateIndex + 1} 个，执行 ${executionId}，版本 ${version}，${qualityStatusText(executionStatus)}）：${inputFingerprint ?? "本次未形成指纹"}${fingerprintSummary === undefined ? "" : `；配置 ${fingerprintSummary.configurationFingerprint}；输入 ${fingerprintSummary.inputFingerprint}`}`,
        ),
        ...issues.map(
          ({ message }) =>
            `[${qualityStatusText(status)}] ${checkId}：${message}`,
        ),
      ],
    ),
  ]);
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
      const lines = [
        `${updateActionNames[item.action] ?? "更新"} ${subject}：${item.reason}`,
      ];
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
  ]);
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
            const loaded = await loadConfig(configPath);
            return await loaded.use(async (config) => {
              const result = await recordBaselineForConfig(
                config,
                baselinePath,
              );
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
          dryRun: {
            kind: "flag",
            longOption: "--dry-run",
            description: "只预览更新决定",
          },
        },
        input: toStandardJsonSchema(
          v.object({ config: v.string(), dryRun: v.optional(v.boolean()) }),
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
            const loaded = await loadConfig(configPath);
            return await loaded.use(async (config) => {
              if (input.dryRun === true) {
                const plan = await previewUpdateForConfig(config, baselinePath);
                return outcome.data.previewed(plan);
              }
              const result = await updateForConfig(config, baselinePath);
              return result.status === "completed"
                ? outcome.data.applied(result)
                : outcome.failure.applyFailed(result);
            });
          } catch (error) {
            return outcome.failure.previewFailed({
              message: error instanceof Error ? error.message : String(error),
            });
          }
        },
      }),
      ...define.command("facts")({
        kind: "command",
        parent: "cli",
        name: "facts",
        description: "读取源译事实并计算宿主定义的关联。",
        fields: {
          config: { kind: "positional", description: "宿主配置文件路径" },
        },
        input: toStandardJsonSchema(v.object({ config: v.string() })),
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
            const loaded = await loadConfig(input.config);
            return await loaded.use(async (config) => {
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
        input: toStandardJsonSchema(v.object({ config: v.string() })),
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
          configurationRequired: {
            description: "完成统计配置不完整",
            exitCode: 1,
            schema: toStandardJsonSchema(
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
            schema: toStandardJsonSchema(v.object({ message: v.string() })),
            text: ({ message }) => text.line(`读取完成事实失败：${message}`),
          },
        },
        async handler({ input, outcome }) {
          try {
            const loaded = await loadConfig(input.config);
            return await loaded.use(async (config) => {
              const facts = await readCompletion(config);
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
        input: toStandardJsonSchema(v.object({ config: v.string() })),
        success: {
          kind: "data",
          variants: {
            checked: {
              description: "质量检查结果",
              exitCode: 0,
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
            const loaded = await loadConfig(input.config);
            return await loaded.use(async (config) => {
              const result = await analyzeQuality(config);
              return outcome.data.checked(result);
            });
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
) {
  const store = createFileComparisonBaselineStore<
    TUnit,
    TTranslation,
    TBody,
    TUnavailable
  >(baselinePath);
  return previewUpdate(config, store);
}

function updateForConfig<
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
  return update(config, store);
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
