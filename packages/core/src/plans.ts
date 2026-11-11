import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { validateComparisonBaseline } from "./baselines.ts";
import {
  compareSnapshots,
  validateComparisonInput,
  validateComparisonResult,
  type SourceChange,
  type TranslationChange,
} from "./comparison.ts";
import type {
  ActualTranslationFact,
  Awaitable,
  ComparisonSnapshot,
  ComparisonStatus,
  ComparisonResult,
  ComparisonBaselineStore,
  FrameworkConfig,
  FrameworkFacts,
  SourceUnitFact,
  TranslationAssociationFact,
  TranslationIdentity,
  TranslationUnitInput,
  StandardSchemaV1,
} from "./index.ts";
import { readFacts, validateFrameworkConfig } from "./index.ts";
import {
  resolveLanguageSelection,
  type LanguageSelectionOptions,
} from "./language-scope.ts";
import { isRecord } from "./object-guards.ts";
import type {
  JsonValue,
  TranslationWriteRequest,
  TranslationWriteSourceExpectation,
  TranslationWriteTargetExpectation,
} from "./semantic-edits.ts";
import {
  assertJsonValue,
  snapshotJsonValue,
  validateWithStandardSchema,
} from "./standard-schema.ts";
import { associateSnapshot } from "./translation-associations.ts";

const UPDATE_PLAN_FORMAT = "lioni.update-plan/v2" as const;

export type UpdatePlanAction =
  | "write"
  | "delete"
  | "retain"
  | "review"
  | "blocked";

export type UpdateSourceExpectation<TUnit extends TranslationUnitInput> =
  TranslationWriteSourceExpectation<TUnit>;

export type UpdateTargetExpectation<TBody> =
  TranslationWriteTargetExpectation<TBody>;

/** 供写入器直接消费的候选；不包含文件定位、准备阶段或策略门禁。 */
export type UpdatePlanWriteRequest<
  TUnit extends TranslationUnitInput,
  TBody,
> = TranslationWriteRequest<TBody, TUnit>;

export type UpdatePlanSourceChange<TUnit extends TranslationUnitInput> = {
  readonly key: string;
  readonly status: ComparisonStatus;
  readonly previous?: SourceUnitFact<TUnit>;
  readonly current?: SourceUnitFact<TUnit>;
};

export type UpdatePlanTranslationChange<TTranslation, TBody, TUnavailable> = {
  readonly identity: TranslationIdentity;
  readonly status: ComparisonStatus;
  readonly previous?: ActualTranslationFact<TTranslation, TBody, TUnavailable>;
  readonly current?: ActualTranslationFact<TTranslation, TBody, TUnavailable>;
};

type UpdatePlanItemBase<
  TUnit extends TranslationUnitInput = TranslationUnitInput,
  TTranslation = unknown,
  TBody = JsonValue,
  TUnavailable = never,
> = {
  /** 原文身份只在该决定确实针对某个原文时出现。 */
  readonly sourceKey?: string;
  readonly language: string;
  /** 已有译文按语言与消息键定位；缺译决定只引用原文身份。 */
  readonly target?: TranslationIdentity;
  readonly changes: {
    readonly source?: SourceChange<TUnit> | UpdatePlanSourceChange<TUnit>;
    readonly translations: readonly UpdatePlanTranslationChange<
      TTranslation,
      TBody,
      TUnavailable
    >[];
  };
  readonly reason: string;
};

export type UpdatePlanItem<
  TUnit extends TranslationUnitInput = TranslationUnitInput,
  TTranslation = unknown,
  TBody = JsonValue,
  TUnavailable = never,
> = UpdatePlanItemBase<TUnit, TTranslation, TBody, TUnavailable> &
  (
    | {
        readonly action: "write";
        readonly after: { readonly content: TBody };
        readonly request: Extract<
          UpdatePlanWriteRequest<TUnit, TBody>,
          { readonly operation: "write" }
        >;
      }
    | {
        readonly action: "delete";
        readonly request: Extract<
          UpdatePlanWriteRequest<TUnit, TBody>,
          { readonly operation: "delete" }
        >;
        readonly after?: never;
      }
    | {
        readonly action: "retain" | "review" | "blocked";
        readonly request?: never;
        readonly after?: never;
      }
  );

export type UpdatePlanComparisons<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
> = {
  readonly sourceChanges: readonly UpdatePlanSourceChange<TUnit>[];
  readonly translationChanges: readonly UpdatePlanTranslationChange<
    TTranslation,
    TBody,
    TUnavailable
  >[];
  readonly reads: {
    readonly previous?: ComparisonResult<
      TUnit,
      TTranslation,
      TBody,
      TUnavailable
    >["reads"]["previous"];
    readonly current: ComparisonResult<
      TUnit,
      TTranslation,
      TBody,
      TUnavailable
    >["reads"]["current"];
  };
};

/** 计划内只保留计算结果，不含适配器、函数、undefined 或宿主对象原型。 */
export type UpdatePlan<
  TUnit extends TranslationUnitInput = TranslationUnitInput,
  TTranslation = unknown,
  TBody = JsonValue,
  TUnavailable = never,
> = {
  readonly format: typeof UPDATE_PLAN_FORMAT;
  readonly previous?: ComparisonSnapshot<
    TUnit,
    TTranslation,
    TBody,
    TUnavailable
  >;
  readonly current: ComparisonSnapshot<
    TUnit,
    TTranslation,
    TBody,
    TUnavailable
  >;
  readonly comparisons: UpdatePlanComparisons<
    TUnit,
    TTranslation,
    TBody,
    TUnavailable
  >;
  readonly associations: UpdatePlanAssociations;
  readonly items: readonly UpdatePlanItem<
    TUnit,
    TTranslation,
    TBody,
    TUnavailable
  >[];
};

export type UpdatePlanData = UpdatePlan;

export type UpdatePlanAssociations = {
  readonly previous: readonly TranslationAssociationFact[];
  readonly current: readonly TranslationAssociationFact[];
};

export type UpdatePlanInput<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
> = {
  readonly previous?: ComparisonSnapshot<
    TUnit,
    TTranslation,
    TBody,
    TUnavailable
  >;
  readonly current: FrameworkFacts<TUnit, TTranslation, TBody, TUnavailable>;
  readonly comparisons: ComparisonResult<
    TUnit,
    TTranslation,
    TBody,
    TUnavailable
  >;
  readonly associations: UpdatePlanAssociations;
  /** 默认直接复制原文正文；自定义函数仅接收正文，不接收目标语言或读取包装。 */
  readonly createPlaceholderContent?: (source: TUnit["source"]) => TBody;
  readonly contentSchema?: StandardSchemaV1<TBody, TBody>;
};

/** 一次消费本次业务相关的事实、关联与比较集合，返回完整决定集合。 */
export type UpdatePolicy<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody = JsonValue,
  TUnavailable = never,
> = (
  input: UpdatePlanInput<TUnit, TTranslation, TBody, TUnavailable>,
) => Awaitable<
  readonly UpdatePlanItem<TUnit, TTranslation, TBody, TUnavailable>[]
>;

export type UpdatePlanStore = {
  load(): Promise<UpdatePlanData | undefined>;
  save(plan: UpdatePlanData): Promise<void>;
};

/**
 * 纯业务规划入口。比较结果、两侧快照与关联均为显式输入；策略只调用一次，
 * 计划可 JSON 序列化后交给另一阶段消费。
 */
export async function createUpdatePlan<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  options: UpdatePlanInput<TUnit, TTranslation, TBody, TUnavailable> & {
    readonly updatePolicy?: UpdatePolicy<
      TUnit,
      TTranslation,
      TBody,
      TUnavailable
    >;
  },
): Promise<UpdatePlan<TUnit, TTranslation, TBody, TUnavailable>> {
  const current = snapshotOf(options.current);
  const compareInput = {
    previous: options.previous,
    current,
  } as const;
  validateComparisonInput<TUnit, TTranslation, TBody, TUnavailable>(
    compareInput,
  );
  validateComparisonResult<TUnit, TTranslation, TBody, TUnavailable>(
    compareInput,
    options.comparisons,
  );
  assertUpdatePlanAssociations(options.associations);
  if (
    options.createPlaceholderContent !== undefined &&
    typeof options.createPlaceholderContent !== "function"
  )
    throw new TypeError(
      "createPlaceholderContent 必须是同步的原文正文到目标正文函数。",
    );
  if (
    options.updatePolicy !== undefined &&
    typeof options.updatePolicy !== "function"
  )
    throw new TypeError("updatePolicy 必须是集合更新策略函数。");

  const policy: UpdatePolicy<TUnit, TTranslation, TBody, TUnavailable> =
    options.updatePolicy ??
    defaultUpdatePolicy<TUnit, TTranslation, TBody, TUnavailable>;
  const items = await policy(options);
  // 先验证完整业务决定；后续省略只作用于框架已定义的可恢复 undefined。
  assertUpdatePlanItems(items);
  const rawPlan = {
    format: UPDATE_PLAN_FORMAT,
    ...(options.previous === undefined ? {} : { previous: options.previous }),
    current,
    comparisons: options.comparisons,
    associations: options.associations,
    items,
  };
  const plan = snapshotJsonValue(rawPlan, "更新计划", {
    omitUndefinedObjectProperties: true,
  }) as UpdatePlan<TUnit, TTranslation, TBody, TUnavailable>;
  validateUpdatePlan(plan);
  return plan;
}

/** 默认策略保留现有译文；仅为完整读取的缺译补占位，并删除有历史依据的未改目标。 */
export async function defaultUpdatePolicy<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  input: UpdatePlanInput<TUnit, TTranslation, TBody, TUnavailable>,
): Promise<
  readonly UpdatePlanItem<TUnit, TTranslation, TBody, TUnavailable>[]
> {
  const items: UpdatePlanItem<TUnit, TTranslation, TBody, TUnavailable>[] = [];
  const current = input.current;
  const sourceChanges = new Map(
    input.comparisons.sourceChanges.map((change) => [change.key, change]),
  );
  const translationChanges = new Map(
    input.comparisons.translationChanges.map((change) => [
      identityKey(change.identity),
      change,
    ]),
  );
  for (const sourceUnit of current.source.units) {
    for (const languageRead of current.translations.reads) {
      const association = input.associations.current.find(
        (entry) =>
          entry.sourceKey === sourceUnit.key &&
          entry.language === languageRead.language,
      );
      const associated =
        association === undefined
          ? []
          : association.translationIndexes.flatMap((index) => {
              const record = current.translations.records[index];
              return record === undefined ? [] : [record];
            });
      const changes = sourceDecisionChanges(
        sourceChanges.get(sourceUnit.key),
        associated.map((record) =>
          translationChanges.get(identityKey(record.identity)),
        ),
      );
      const base = {
        sourceKey: sourceUnit.key,
        language: languageRead.language,
        changes,
      };

      if (association === undefined) {
        items.push({
          ...base,
          action: "review",
          reason: "本次没有对应的源译关联依据，请复核目标范围。",
        });
        continue;
      }

      if (association.status === "matched") {
        const target = associated[0];
        if (target === undefined) {
          items.push({
            ...base,
            action: "review",
            reason: "关联结果缺少对应译文事实，请复核当前读取。",
          });
          continue;
        }
        if (changes.source?.status === "modified") {
          if (target.bodyAvailability !== "available") {
            items.push({
              ...base,
              action: "blocked",
              target: target.identity,
              reason: "目标译文正文不可用，无法安全重置为待译占位。",
            });
            continue;
          }
          if (sourceUnit.bodyAvailability !== "available") {
            items.push({
              ...base,
              action: "blocked",
              target: target.identity,
              reason: "当前原文正文不可用，无法生成待译占位。",
            });
            continue;
          }
          const sourceRange =
            current.source.read.scopes[sourceUnit.scopeIndex]?.range;
          if (sourceRange === undefined) {
            items.push({
              ...base,
              action: "blocked",
              target: target.identity,
              reason: "原文读取事实缺少可验证的范围，无法保留写入依据。",
            });
            continue;
          }

          let content: TBody;
          try {
            content = await placeholderContent(input, sourceUnit.unit.source);
          } catch {
            items.push({
              ...base,
              action: "blocked",
              target: target.identity,
              reason: "生成待译占位失败或未通过目标正文校验，未写入。",
            });
            continue;
          }

          const request: UpdatePlanWriteRequest<TUnit, TBody> = {
            operation: "write",
            target: { identity: target.identity },
            content,
            expectedSource: {
              presence: "present",
              key: sourceUnit.key,
              unit: sourceUnit.unit,
              content: sourceUnit.unit.source as JsonValue,
              range: sourceRange as JsonValue,
            },
            expectedTarget: {
              status: "present",
              identity: target.identity,
              content: target.content,
              range: target.range as JsonValue,
              record: target.translation as JsonValue,
            },
          };
          items.push({
            ...base,
            action: "write",
            target: target.identity,
            after: { content },
            request,
            reason: "原文已变化；使用当前原文生成待译占位并重置现有译文。",
          });
          continue;
        }
        items.push({
          ...base,
          action: "retain",
          target: target.identity,
          reason: "保留已存在的译文。",
        });
        continue;
      }

      if (association.status === "missing") {
        if (sourceUnit.bodyAvailability !== "available") {
          items.push({
            ...base,
            action: "blocked",
            reason: "原文正文不可用，无法生成待译占位。",
          });
          continue;
        }
        let content: TBody;
        try {
          content = await placeholderContent(input, sourceUnit.unit.source);
        } catch {
          items.push({
            ...base,
            action: "blocked",
            reason: "生成待译占位失败或未通过目标正文校验，未写入。",
          });
          continue;
        }
        const range = current.source.read.scopes[sourceUnit.scopeIndex]?.range;
        if (range === undefined) {
          items.push({
            ...base,
            action: "blocked",
            reason: "原文读取事实缺少可验证的范围，无法保留写入依据。",
          });
          continue;
        }
        const request: UpdatePlanWriteRequest<TUnit, TBody> = {
          operation: "write",
          target: {
            sourceKey: sourceUnit.key,
            language: languageRead.language,
          },
          content,
          expectedSource: {
            presence: "present",
            key: sourceUnit.key,
            unit: sourceUnit.unit,
            content: sourceUnit.unit.source as JsonValue,
            range: range as JsonValue,
          },
          expectedTarget: { status: "missing" },
        };
        items.push({
          ...base,
          action: "write",
          after: { content },
          request,
          reason:
            "目标范围已完整读取且没有对应译文；使用当前原文生成待译占位。",
        });
        continue;
      }

      items.push({
        ...base,
        action: association.status === "unavailable" ? "blocked" : "review",
        ...(associated.length === 1 ? { target: associated[0]!.identity } : {}),
        reason:
          association.status === "unavailable"
            ? "译文正文不可用；保留目标并阻止自动修改。"
            : "目标读取依据不完整；不判断为缺译或已处理。",
      });
    }
  }

  const associatedTargets = new Set(
    input.associations.current.flatMap(
      ({ translationIndexes }) => translationIndexes,
    ),
  );

  for (const translation of current.translations.records) {
    if (associatedTargets.has(translation.index)) continue;
    const change = translationChanges.get(identityKey(translation.identity));
    const previousRecord = input.previous?.translations.records.find(
      ({ identity }) => sameIdentity(identity, translation.identity),
    );
    const previousAssociation =
      previousRecord === undefined
        ? undefined
        : input.associations.previous.find((association) =>
            association.translationIndexes.includes(previousRecord.index),
          );
    const sourceChange =
      previousAssociation === undefined
        ? undefined
        : sourceChanges.get(previousAssociation.sourceKey);
    const source =
      sourceChange?.previous?.key === previousAssociation?.sourceKey
        ? sourceChange?.previous
        : undefined;
    const changes = sourceDecisionChanges(
      source === undefined ? undefined : sourceChange,
      change === undefined ? [] : [change],
    );
    const base = {
      language: translation.language,
      target: translation.identity,
      changes,
    };
    const removedSource =
      source !== undefined && previousAssociation?.status === "matched"
        ? { source, sourceChange }
        : undefined;

    if (removedSource?.sourceChange?.status === "removed") {
      const read = current.translations.reads.find(
        ({ language }) => language === translation.language,
      );
      const scope = read?.scopes[translation.scopeIndex];
      if (
        read?.status !== "complete" ||
        scope?.enumeration !== "complete" ||
        translation.bodyAvailability !== "available"
      ) {
        items.push({
          ...base,
          action: "review",
          reason:
            "原文移除已确认，但当前目标的正文或完整读取依据不足；保留并复核。",
        });
        continue;
      }

      if (change?.status === "unchanged") {
        const previousRange =
          input.previous?.source.read.scopes[removedSource.source.scopeIndex]
            ?.range;
        const sourceRange =
          previousRange === undefined
            ? undefined
            : sourceRangeForRemoved(previousRange, current);
        if (sourceRange === undefined) {
          items.push({
            ...base,
            action: "review",
            reason: "未能确认原文移除对应的完整当前范围；保留目标并复核。",
          });
          continue;
        }
        items.push({
          ...base,
          action: "delete",
          request: {
            operation: "delete",
            target: { identity: translation.identity },
            expectedSource: {
              presence: "absent",
              key: removedSource.source.key,
              range: sourceRange as JsonValue,
            },
            expectedTarget: {
              status: "present",
              identity: translation.identity,
              content: translation.content,
              range: translation.range as JsonValue,
              record: translation.translation as JsonValue,
            },
          },
          reason:
            "该译文明确关联的历史原文已从完整范围移除，目标正文未变化；可删除。",
        });
        continue;
      }

      items.push({
        ...base,
        action: "retain",
        reason:
          translation.bodyAvailability === "available" &&
          change?.status === "modified"
            ? "历史原文已移除，但目标正文此后发生变化；保留人工修改。"
            : "历史原文已移除，但缺少确认目标未变化的历史依据；保留目标。",
      });
      continue;
    }

    if (previousAssociation === undefined) {
      items.push({
        ...base,
        action: "retain",
        reason: "没有充分的历史原文关联依据；保留目标独有项。",
      });
      continue;
    }

    items.push({
      ...base,
      action: "review",
      reason: "历史原文尚未被充分确认移除；保留目标并复核当前证据。",
    });
  }

  return items;
}

async function placeholderContent<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  input: UpdatePlanInput<TUnit, TTranslation, TBody, TUnavailable>,
  source: TUnit["source"],
): Promise<TBody> {
  const candidate =
    input.createPlaceholderContent === undefined
      ? (source as TBody)
      : input.createPlaceholderContent(source);
  const content =
    input.contentSchema === undefined
      ? candidate
      : await validateWithStandardSchema(
          input.contentSchema,
          candidate,
          "更新占位正文",
          { preserveValue: true, requireJson: true },
        );
  assertJsonValue(content, "更新占位正文");
  return content;
}

/**
 * 读取当前事实、选用配置比较器并生成业务计划；不写资源或推进基线。
 * 显式选择语言时，历史事实、比较器和策略均限定在该范围，策略不得扩大范围。
 */
export async function previewUpdate<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  config: FrameworkConfig<TUnit, TTranslation, TBody, TUnavailable>,
  store?: ComparisonBaselineStore<TUnit, TTranslation, TBody, TUnavailable>,
  options: LanguageSelectionOptions = {},
): Promise<UpdatePlan<TUnit, TTranslation, TBody, TUnavailable>> {
  validateFrameworkConfig(config);
  const languages = resolveLanguageSelection(
    config.translations?.languages ?? [],
    options,
  );
  if (
    config.updatePolicy !== undefined &&
    typeof config.updatePolicy !== "function"
  )
    throw new TypeError(
      "defineConfig 的 updatePolicy 必须是集合更新策略函数。",
    );
  if (
    config.createPlaceholderContent !== undefined &&
    typeof config.createPlaceholderContent !== "function"
  )
    throw new TypeError(
      "defineConfig 的 createPlaceholderContent 必须是同步填充函数。",
    );

  const baseline = await store?.load();
  if (baseline !== undefined) validateComparisonBaseline(baseline);
  const current = await readFacts(config, options);
  // 比较器和策略也只接收本次范围；未选语言的历史不能成为本次决定依据。
  const previous =
    baseline === undefined
      ? undefined
      : options.languages === undefined
        ? baseline.snapshot
        : selectSnapshotLanguages<TUnit, TTranslation, TBody, TUnavailable>(
            baseline.snapshot,
            languages,
          );
  const comparisons = await compareSnapshots<
    TUnit,
    TTranslation,
    TBody,
    TUnavailable
  >({ previous, current: snapshotOf(current) }, config.compare);
  const associations: UpdatePlanAssociations = {
    previous:
      previous === undefined
        ? []
        : associateSnapshot<TUnit, TTranslation, TBody, TUnavailable>(previous),
    current: current.associations,
  };
  const plan = await createUpdatePlan<TUnit, TTranslation, TBody, TUnavailable>(
    {
      ...(previous === undefined ? {} : { previous }),
      current,
      comparisons,
      associations,
      ...(config.createPlaceholderContent === undefined
        ? {}
        : { createPlaceholderContent: config.createPlaceholderContent }),
      ...(config.translations === undefined
        ? {}
        : { contentSchema: config.translations.contentSchema }),
      ...(config.updatePolicy === undefined
        ? {}
        : { updatePolicy: config.updatePolicy }),
    },
  );
  if (options.languages !== undefined)
    assertUpdatePlanLanguages(plan, languages);
  return plan;
}

function selectSnapshotLanguages<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  snapshot: ComparisonSnapshot<TUnit, TTranslation, TBody, TUnavailable>,
  languages: readonly string[],
): ComparisonSnapshot<TUnit, TTranslation, TBody, TUnavailable> {
  const indexes = new Map<number, number>();
  const records = snapshot.translations.records
    .filter(({ language }) => languages.includes(language))
    .map((record, index) => {
      indexes.set(record.index, index);
      return { ...record, index };
    });
  const reads = snapshot.translations.reads
    .filter(({ language }) => languages.includes(language))
    .map((read) => ({
      ...read,
      scopes: read.scopes.map((scope) => ({
        ...scope,
        translationIndexes: scope.translationIndexes.map((index) => {
          const selectedIndex = indexes.get(index);
          if (selectedIndex === undefined)
            throw new TypeError("比较基线的译文范围引用了其他语言的记录。");
          return selectedIndex;
        }),
      })),
    }));
  const selected = {
    source: snapshot.source,
    translations: { reads, records },
  };
  return {
    version: `sha256:${createHash("sha256").update(JSON.stringify(selected)).digest("hex")}`,
    ...selected,
  };
}

/** 显式选择语言时，策略和保存的计划都不能扩大执行范围。 */
export function assertUpdatePlanLanguages<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  plan: UpdatePlan<TUnit, TTranslation, TBody, TUnavailable>,
  languages: readonly string[],
): void {
  for (const item of plan.items) {
    const referenced = [
      item.language,
      ...(item.target === undefined ? [] : [item.target.language]),
      ...item.changes.translations.flatMap((change) => [
        change.identity.language,
        ...(change.previous === undefined
          ? []
          : [change.previous.language, change.previous.identity.language]),
        ...(change.current === undefined
          ? []
          : [change.current.language, change.current.identity.language]),
      ]),
    ];
    if (item.request !== undefined) {
      const request = item.request;
      referenced.push(
        "identity" in request.target
          ? request.target.identity.language
          : request.target.language,
      );
      if (request.expectedTarget.status === "present")
        referenced.push(request.expectedTarget.identity.language);
    }
    for (const language of referenced) {
      if (!languages.includes(language))
        throw new TypeError(
          `更新计划引用了本次未选择的目标语言 ${JSON.stringify(language)}。`,
        );
    }
  }
}

/** 验证保存后的 JSON 计划；不会重新比较、关联或调用策略。 */
export function validateUpdatePlan(
  value: unknown,
): asserts value is UpdatePlanData {
  assertJsonValue(value, "更新计划");
  if (
    !isRecord(value) ||
    value.format !== UPDATE_PLAN_FORMAT ||
    !isPlanAssociations(value.associations) ||
    !Array.isArray(value.items) ||
    value.items.some((item) => !isPlanItem(item))
  )
    invalidPlan("格式无效或包含不完整的业务决定。");

  const comparisonInput = {
    previous: value.previous as
      | ComparisonSnapshot<TranslationUnitInput, unknown, JsonValue, unknown>
      | undefined,
    current: value.current as ComparisonSnapshot<
      TranslationUnitInput,
      unknown,
      JsonValue,
      unknown
    >,
  };
  validateComparisonInput<TranslationUnitInput, unknown, JsonValue, unknown>(
    comparisonInput,
  );
  validateComparisonResult<TranslationUnitInput, unknown, JsonValue, unknown>(
    comparisonInput,
    value.comparisons,
  );
  const associations = value.associations as UpdatePlanAssociations;
  assertAssociationKeys(associations.previous, comparisonInput.previous);
  assertAssociationKeys(associations.current, comparisonInput.current);
}

/** 保存计划中的关联必须仍指向同一消息键，不接受自定义交叉配对。 */
function assertAssociationKeys(
  associations: readonly TranslationAssociationFact[],
  snapshot:
    | ComparisonSnapshot<TranslationUnitInput, unknown, JsonValue, unknown>
    | undefined,
): void {
  const sourceKeys = new Set(snapshot?.source.units.map(({ key }) => key));
  for (const association of associations) {
    if (!sourceKeys.has(association.sourceKey))
      invalidPlan("源译关联引用了不存在的原文键。");
    for (const index of association.translationIndexes) {
      const record = snapshot?.translations.records[index];
      if (
        record?.identity.language !== association.language ||
        record.identity.key !== association.sourceKey
      )
        invalidPlan("原文与译文必须按语言和消息键唯一对应。");
    }
  }
}

function snapshotOf<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  facts: FrameworkFacts<TUnit, TTranslation, TBody, TUnavailable>,
): ComparisonSnapshot<TUnit, TTranslation, TBody, TUnavailable> {
  return {
    version: facts.version,
    source: facts.source,
    translations: facts.translations,
  };
}

function sourceDecisionChanges<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  source: SourceChange<TUnit> | undefined,
  translations: readonly (
    | TranslationChange<TTranslation, TBody, TUnavailable>
    | undefined
  )[],
): {
  readonly source?: UpdatePlanSourceChange<TUnit>;
  readonly translations: readonly UpdatePlanTranslationChange<
    TTranslation,
    TBody,
    TUnavailable
  >[];
} {
  return {
    ...(source === undefined
      ? {}
      : {
          source: {
            key: source.key,
            status: source.status,
            ...(source.previous === undefined
              ? {}
              : { previous: source.previous }),
            ...(source.current === undefined
              ? {}
              : { current: source.current }),
          },
        }),
    translations: translations.flatMap((change) =>
      change === undefined
        ? []
        : [
            {
              identity: change.identity,
              status: change.status,
              ...(change.previous === undefined
                ? {}
                : { previous: change.previous }),
              ...(change.current === undefined
                ? {}
                : { current: change.current }),
            },
          ],
    ),
  };
}

function sourceRangeForRemoved<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  previousRange: unknown,
  current: FrameworkFacts<TUnit, TTranslation, TBody, TUnavailable>,
): unknown {
  const range = current.source.read.scopes.find(
    ({ range: currentRange, enumeration }) =>
      enumeration === "complete" &&
      isDeepStrictEqual(currentRange, previousRange),
  )?.range;
  return range;
}

function identityKey(identity: TranslationIdentity): string {
  return JSON.stringify([identity.language, identity.key]);
}

function sameIdentity(
  left: TranslationIdentity,
  right: TranslationIdentity,
): boolean {
  return identityKey(left) === identityKey(right);
}

function isPlanAssociations(value: unknown): boolean {
  return (
    isRecord(value) &&
    Array.isArray(value.previous) &&
    value.previous.every(isAssociation) &&
    Array.isArray(value.current) &&
    value.current.every(isAssociation) &&
    hasUniqueAssociations(value.previous) &&
    hasUniqueAssociations(value.current)
  );
}

function hasUniqueAssociations(
  associations: readonly TranslationAssociationFact[],
): boolean {
  const subjects = new Set<string>();
  const targets = new Set<number>();
  for (const association of associations) {
    const subject = JSON.stringify([
      association.language,
      association.sourceKey,
    ]);
    if (subjects.has(subject)) return false;
    subjects.add(subject);
    for (const index of association.translationIndexes) {
      if (targets.has(index)) return false;
      targets.add(index);
    }
  }
  return true;
}

function assertUpdatePlanAssociations(value: unknown): void {
  assertJsonValue(value, "更新计划中的关联事实");
  if (!isPlanAssociations(value))
    throw new TypeError("更新计划中的关联事实必须按语言和消息键唯一对应。");
}

function assertUpdatePlanItems(value: unknown): void {
  if (!Array.isArray(value)) {
    assertJsonValue(value, "更新计划中的更新决定");
    return;
  }
  const items = value.map((item) => {
    if (!isRecord(item) || !isRecord(item.changes)) return item;
    const { source, translations, ...changes } = item.changes;
    return {
      ...item,
      changes: {
        ...changes,
        ...(source === undefined
          ? {}
          : { source: withoutUndefinedComparisonSides(source) }),
        ...(translations === undefined
          ? {}
          : {
              translations: Array.isArray(translations)
                ? translations.map(withoutUndefinedComparisonSides)
                : translations,
            }),
      },
    };
  });
  assertJsonValue(items, "更新计划中的更新决定");
}

function withoutUndefinedComparisonSides(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const { previous, current, ...change } = value;
  return {
    ...change,
    ...(previous === undefined ? {} : { previous }),
    ...(current === undefined ? {} : { current }),
  };
}

function isPlanItem(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !isPlanAction(value.action) ||
    typeof value.language !== "string" ||
    typeof value.reason !== "string" ||
    !isRecord(value.changes) ||
    (value.sourceKey !== undefined && typeof value.sourceKey !== "string") ||
    (value.target !== undefined && !isIdentity(value.target)) ||
    (value.changes.source !== undefined &&
      (!isRecord(value.changes.source) ||
        typeof value.changes.source.key !== "string" ||
        !isComparisonStatus(value.changes.source.status))) ||
    !Array.isArray(value.changes.translations) ||
    !value.changes.translations.every(
      (change: unknown) =>
        isRecord(change) &&
        isIdentity(change.identity) &&
        isComparisonStatus(change.status),
    ) ||
    (value.after !== undefined && !isRecord(value.after))
  )
    return false;
  if (value.action === "write")
    return (
      isWriteRequest(value.request) &&
      value.request.operation === "write" &&
      isRecord(value.after) &&
      Object.hasOwn(value.after, "content") &&
      isDeepStrictEqual(value.after.content, value.request.content)
    );
  if (value.action === "delete")
    return (
      isDeleteRequest(value.request) && value.request.operation === "delete"
    );
  return value.request === undefined && value.after === undefined;
}

function isWriteRequest(
  value: unknown,
): value is UpdatePlanWriteRequest<TranslationUnitInput, JsonValue> {
  if (
    !isRecord(value) ||
    value.operation !== "write" ||
    !isRecord(value.target) ||
    Object.hasOwn(value, "content") === false ||
    !isTargetExpectation(value.expectedTarget) ||
    (value.expectedSource !== undefined &&
      !isSourceExpectation(value.expectedSource))
  )
    return false;
  const sourceTarget =
    typeof value.target.sourceKey === "string" &&
    typeof value.target.language === "string";
  if (sourceTarget) return value.expectedTarget.status === "missing";
  return (
    isIdentity(value.target.identity) &&
    value.expectedTarget.status === "present" &&
    sameIdentity(value.target.identity, value.expectedTarget.identity)
  );
}

function isDeleteRequest(
  value: unknown,
): value is UpdatePlanWriteRequest<TranslationUnitInput, JsonValue> {
  return (
    isRecord(value) &&
    value.operation === "delete" &&
    isRecord(value.target) &&
    isIdentity(value.target.identity) &&
    isRecord(value.expectedTarget) &&
    value.expectedTarget.status === "present" &&
    isIdentity(value.expectedTarget.identity) &&
    sameIdentity(value.target.identity, value.expectedTarget.identity) &&
    (value.expectedSource === undefined ||
      isSourceExpectation(value.expectedSource))
  );
}

function isSourceExpectation(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.presence === "present"
      ? typeof value.key === "string" &&
        Object.hasOwn(value, "unit") &&
        Object.hasOwn(value, "content") &&
        Object.hasOwn(value, "range")
      : value.presence === "absent" &&
        typeof value.key === "string" &&
        Object.hasOwn(value, "range"))
  );
}

function isTargetExpectation(
  value: unknown,
): value is UpdateTargetExpectation<JsonValue> {
  return (
    isRecord(value) &&
    (value.status === "missing" ||
      (value.status === "present" &&
        isIdentity(value.identity) &&
        Object.hasOwn(value, "content") &&
        (!Object.hasOwn(value, "range") || value.range !== undefined) &&
        (!Object.hasOwn(value, "record") || value.record !== undefined)))
  );
}

function isAssociation(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.sourceKey === "string" &&
    typeof value.language === "string" &&
    ["matched", "missing", "unavailable", "unknown"].includes(
      String(value.status),
    ) &&
    ["complete", "incomplete", "failed", "notRead"].includes(
      String(value.coverageStatus),
    ) &&
    Array.isArray(value.scopeIndexes) &&
    value.scopeIndexes.every((index) => Number.isInteger(index)) &&
    Array.isArray(value.translationIndexes) &&
    value.translationIndexes.length <= 1 &&
    value.translationIndexes.every((index) => Number.isInteger(index))
  );
}

function isIdentity(value: unknown): value is TranslationIdentity {
  return (
    isRecord(value) &&
    typeof value.language === "string" &&
    typeof value.key === "string"
  );
}

function isPlanAction(value: unknown): value is UpdatePlanAction {
  return ["write", "delete", "retain", "review", "blocked"].includes(
    String(value),
  );
}

function isComparisonStatus(value: unknown): value is ComparisonStatus {
  return [
    "historyMissing",
    "historyInsufficient",
    "currentInsufficient",
    "bothInsufficient",
    "added",
    "removed",
    "modified",
    "unchanged",
  ].includes(String(value));
}

function invalidPlan(message: string): never {
  throw new TypeError(`更新计划无效：${message}`);
}
