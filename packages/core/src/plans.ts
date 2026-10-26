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

const UPDATE_PLAN_FORMAT = "lioni.update-plan/v1" as const;

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
  /** 单目标决定使用 target；多匹配冲突使用 targets 并保留全部身份。 */
  readonly target?: TranslationIdentity;
  readonly targets?: readonly TranslationIdentity[];
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
  /** 把历史原文重新与当前目标匹配后的关系，用于确认删除依据仍成立。 */
  readonly currentFromPrevious?: readonly TranslationAssociationFact[];
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
  readonly sourceToContent?: (source: TUnit["source"]) => TBody;
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
    options.sourceToContent !== undefined &&
    typeof options.sourceToContent !== "function"
  )
    throw new TypeError("sourceToContent 必须是纯原文到目标正文的投影函数。");
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

      if (association.status === "conflict") {
        items.push({
          ...base,
          action: "review",
          targets: associated.map(({ identity }) => identity),
          reason: "同一原文匹配到多条译文；保留全部条目并复核关联。",
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
        items.push({
          ...base,
          action: "retain",
          target: target.identity,
          reason:
            changes.source?.status === "modified"
              ? "原文已变化；保留现有译文，避免覆盖人工内容。"
              : "保留已存在的译文。",
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
        if (input.sourceToContent === undefined) {
          items.push({
            ...base,
            action: "blocked",
            reason: "宿主没有提供原文到目标正文的投影，无法生成待译占位。",
          });
          continue;
        }
        const projected = input.sourceToContent(sourceUnit.unit.source);
        const content =
          input.contentSchema === undefined
            ? projected
            : await validateWithStandardSchema(
                input.contentSchema,
                projected,
                "更新占位正文",
                { preserveValue: true, requireJson: true },
              );
        assertJsonValue(content, "更新占位正文");
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
          reason: "目标范围已完整读取且没有对应译文；复制原文作为待译占位。",
        });
        continue;
      }

      items.push({
        ...base,
        action: association.status === "unavailable" ? "blocked" : "review",
        ...(associated.length === 1 ? { target: associated[0]!.identity } : {}),
        ...(associated.length > 1
          ? { targets: associated.map(({ identity }) => identity) }
          : {}),
        reason:
          association.status === "unavailable"
            ? "译文正文不可用；保留目标并阻止自动修改。"
            : "目标读取依据不完整；不判断为缺译或已处理。",
      });
    }
  }

  const currentOwners = new Map<number, TranslationAssociationFact[]>();
  for (const association of input.associations.current) {
    for (const index of association.translationIndexes) {
      const owners = currentOwners.get(index) ?? [];
      owners.push(association);
      currentOwners.set(index, owners);
    }
  }

  for (const translation of current.translations.records) {
    if ((currentOwners.get(translation.index)?.length ?? 0) > 0) continue;
    const change = translationChanges.get(identityKey(translation.identity));
    const previousRecord = input.previous?.translations.records.find(
      ({ identity }) => sameIdentity(identity, translation.identity),
    );
    const previousOwners =
      previousRecord === undefined
        ? []
        : input.associations.previous.filter((association) =>
            association.translationIndexes.includes(previousRecord.index),
          );
    const historicalSources = previousOwners.flatMap((association) => {
      const sourceChange = sourceChanges.get(association.sourceKey);
      const source =
        sourceChange?.previous?.key === association.sourceKey
          ? sourceChange.previous
          : undefined;
      return source === undefined
        ? []
        : [{ association, source, sourceChange }];
    });
    const changes = sourceDecisionChanges(
      historicalSources.length === 1
        ? historicalSources[0]!.sourceChange
        : undefined,
      change === undefined ? [] : [change],
    );
    const base = {
      language: translation.language,
      target: translation.identity,
      changes,
    };
    const uniquelyHistoricallyMatched =
      historicalSources.length === 1 &&
      historicalSources[0]!.association.status === "matched";
    const removedSource = uniquelyHistoricallyMatched
      ? historicalSources[0]
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
        const currentHistoricalAssociation =
          input.associations.currentFromPrevious?.find(
            ({ sourceKey, language }) =>
              sourceKey === removedSource.source.key &&
              language === translation.language,
          );
        if (
          currentHistoricalAssociation?.status !== "matched" ||
          !currentHistoricalAssociation.translationIndexes.includes(
            translation.index,
          )
        ) {
          const associationChanged =
            currentHistoricalAssociation?.status === "missing";
          items.push({
            ...base,
            action: associationChanged ? "retain" : "review",
            reason: associationChanged
              ? "目标已不再匹配被移除的历史原文；保留现有译文。"
              : "当前目标与历史原文的关联依据不足或有冲突；保留并复核。",
          });
          continue;
        }
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

    if (
      previousOwners.length > 1 ||
      previousOwners.some(({ status }) => status === "conflict")
    ) {
      items.push({
        ...base,
        action: "review",
        reason:
          "目标与多条历史源译关联相连，无法唯一确认删除依据；保留并复核。",
      });
      continue;
    }

    if (previousOwners.length === 0) {
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

/** 读取当前事实、选用配置比较器并生成业务计划；不写资源或推进基线。 */
export async function previewUpdate<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  config: FrameworkConfig<TUnit, TTranslation, TBody, TUnavailable>,
  store?: ComparisonBaselineStore<TUnit, TTranslation, TBody, TUnavailable>,
): Promise<UpdatePlan<TUnit, TTranslation, TBody, TUnavailable>> {
  validateFrameworkConfig(config);
  if (
    config.updatePolicy !== undefined &&
    typeof config.updatePolicy !== "function"
  )
    throw new TypeError(
      "defineConfig 的 updatePolicy 必须是集合更新策略函数。",
    );
  if (
    config.sourceToContent !== undefined &&
    typeof config.sourceToContent !== "function"
  )
    throw new TypeError("defineConfig 的 sourceToContent 必须是纯投影函数。");

  const baseline = await store?.load();
  if (baseline !== undefined) validateComparisonBaseline(baseline);
  const current = await readFacts(config);
  const previous = baseline?.snapshot;
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
        : associateSnapshot<TUnit, TTranslation, TBody, TUnavailable>(
            previous,
            config,
          ),
    current: current.associations,
    currentFromPrevious:
      previous === undefined
        ? []
        : associatePreviousSourcesWithCurrentTargets<
            TUnit,
            TTranslation,
            TBody,
            TUnavailable
          >(previous, current, config),
  };
  return createUpdatePlan<TUnit, TTranslation, TBody, TUnavailable>({
    ...(previous === undefined ? {} : { previous }),
    current,
    comparisons,
    associations,
    ...(config.sourceToContent === undefined
      ? {}
      : { sourceToContent: config.sourceToContent }),
    ...(config.translations === undefined
      ? {}
      : { contentSchema: config.translations.contentSchema }),
    ...(config.updatePolicy === undefined
      ? {}
      : { updatePolicy: config.updatePolicy }),
  });
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

function associateSnapshot<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  snapshot: ComparisonSnapshot<TUnit, TTranslation, TBody, TUnavailable>,
  config: FrameworkConfig<TUnit, TTranslation, TBody, TUnavailable>,
): TranslationAssociationFact[] {
  const adapter = config.translations;
  if (adapter === undefined || typeof adapter.matches !== "function") return [];
  const associations: TranslationAssociationFact[] = [];
  for (const languageRead of snapshot.translations.reads) {
    for (const sourceUnit of snapshot.source.units) {
      const scopeIndexes = languageRead.scopes.flatMap((scope, index) =>
        scope.covers.includes(sourceUnit.key) ? [index] : [],
      );
      const relevantScopes = languageRead.scopes.filter((_, index) =>
        scopeIndexes.includes(index),
      );
      const coverageStatus = readStatus(
        relevantScopes,
        scopeIndexes.length === 0 ? languageRead.error : undefined,
      );
      const translationIndexes = snapshot.translations.records
        .filter(
          ({ language, scopeIndex }) =>
            language === languageRead.language &&
            scopeIndexes.includes(scopeIndex),
        )
        .filter(({ translation }) =>
          adapter.matches!(sourceUnit.unit, translation),
        )
        .map(({ index }) => index);
      const status =
        translationIndexes.length > 1
          ? "conflict"
          : translationIndexes.length === 0
            ? coverageStatus === "complete"
              ? "missing"
              : "unknown"
            : coverageStatus !== "complete"
              ? "unknown"
              : snapshot.translations.records[translationIndexes[0] as number]
                    ?.bodyAvailability === "available"
                ? "matched"
                : "unavailable";
      associations.push({
        sourceKey: sourceUnit.key,
        language: languageRead.language,
        status,
        coverageStatus,
        scopeIndexes,
        translationIndexes,
      });
    }
  }
  return associations;
}

function associatePreviousSourcesWithCurrentTargets<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  previous: ComparisonSnapshot<TUnit, TTranslation, TBody, TUnavailable>,
  current: FrameworkFacts<TUnit, TTranslation, TBody, TUnavailable>,
  config: FrameworkConfig<TUnit, TTranslation, TBody, TUnavailable>,
): TranslationAssociationFact[] {
  const matches = config.translations?.matches;
  if (matches === undefined) return [];

  const associations: TranslationAssociationFact[] = [];
  for (const languageRead of current.translations.reads) {
    const coverageStatus = readStatus(languageRead.scopes, languageRead.error);
    for (const sourceUnit of previous.source.units) {
      const matchingRecords = current.translations.records.filter(
        (record) =>
          record.language === languageRead.language &&
          matches(sourceUnit.unit, record.translation),
      );
      const translationIndexes = matchingRecords.map(({ index }) => index);
      const status =
        translationIndexes.length > 1
          ? "conflict"
          : translationIndexes.length === 0
            ? coverageStatus === "complete"
              ? "missing"
              : "unknown"
            : coverageStatus !== "complete"
              ? "unknown"
              : matchingRecords[0]?.bodyAvailability === "available"
                ? "matched"
                : "unavailable";
      associations.push({
        sourceKey: sourceUnit.key,
        language: languageRead.language,
        status,
        coverageStatus,
        scopeIndexes: [
          ...new Set(matchingRecords.map(({ scopeIndex }) => scopeIndex)),
        ],
        translationIndexes,
      });
    }
  }
  return associations;
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

function readStatus(
  scopes: readonly {
    readonly enumeration: "complete" | "partial" | "failed";
  }[],
  error?: string,
): "complete" | "incomplete" | "failed" | "notRead" {
  if (
    error !== undefined ||
    scopes.some(({ enumeration }) => enumeration === "failed")
  )
    return "failed";
  if (scopes.length === 0) return "notRead";
  return scopes.every(({ enumeration }) => enumeration === "complete")
    ? "complete"
    : "incomplete";
}

function identityKey(identity: TranslationIdentity): string {
  return JSON.stringify([identity.language, identity.namespace, identity.key]);
}

function sameIdentity(
  left: TranslationIdentity,
  right: TranslationIdentity,
): boolean {
  return identityKey(left) === identityKey(right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlanAssociations(value: unknown): boolean {
  return (
    isRecord(value) &&
    Array.isArray(value.previous) &&
    value.previous.every(isAssociation) &&
    Array.isArray(value.current) &&
    value.current.every(isAssociation) &&
    (value.currentFromPrevious === undefined ||
      (Array.isArray(value.currentFromPrevious) &&
        value.currentFromPrevious.every(isAssociation)))
  );
}

function assertUpdatePlanAssociations(value: unknown): void {
  if (!isRecord(value)) {
    assertJsonValue(value, "更新计划中的关联事实");
    return;
  }
  const { currentFromPrevious, ...associations } = value;
  assertJsonValue(
    currentFromPrevious === undefined ? associations : value,
    "更新计划中的关联事实",
  );
  if (currentFromPrevious !== undefined)
    assertJsonValue(currentFromPrevious, "更新计划中的历史关联事实");
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
    (value.targets !== undefined &&
      (!Array.isArray(value.targets) || !value.targets.every(isIdentity))) ||
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
    ["matched", "missing", "unavailable", "unknown", "conflict"].includes(
      String(value.status),
    ) &&
    ["complete", "incomplete", "failed", "notRead"].includes(
      String(value.coverageStatus),
    ) &&
    Array.isArray(value.scopeIndexes) &&
    value.scopeIndexes.every((index) => Number.isInteger(index)) &&
    Array.isArray(value.translationIndexes) &&
    value.translationIndexes.every((index) => Number.isInteger(index))
  );
}

function isIdentity(value: unknown): value is TranslationIdentity {
  return (
    isRecord(value) &&
    typeof value.language === "string" &&
    typeof value.namespace === "string" &&
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
