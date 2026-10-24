import { isDeepStrictEqual } from "node:util";

import { readFacts } from "./index.ts";
import type {
  ActualTranslationFact,
  Awaitable,
  CoverageStatus,
  FrameworkConfig,
  FrameworkFacts,
  SourceReadFact,
  SourceUnitFact,
  TranslationAssociationFact,
  TranslationUnitInput,
} from "./index.ts";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type SemanticEditTarget = {
  readonly kind: "existing" | "create";
  readonly locator: JsonValue;
};

export type SemanticEditCandidate = {
  readonly sourceKey: string;
  readonly language: string;
  readonly content: JsonValue;
};

export type SemanticEdit = {
  readonly formatVersion: "l10n.semantic-edit/v1";
  readonly createdFromFactsVersion: string;
  readonly sourceKey: string;
  readonly language: string;
  readonly target: SemanticEditTarget;
  readonly content: JsonValue;
  readonly expected: {
    readonly source: JsonValue;
    readonly target:
      | { readonly status: "missing" }
      | { readonly status: "present"; readonly content: JsonValue };
    readonly dependencies: JsonValue;
  };
};

export type SemanticEditInput = Omit<SemanticEdit, "formatVersion" | "content">;

export type SemanticEditSubject = Pick<
  SemanticEditCandidate,
  "sourceKey" | "language"
>;

export type EditTargetResolution =
  | { readonly status: "located"; readonly locator: JsonValue }
  | { readonly status: "notWritable"; readonly reason: string };

export type TranslationWritebackAdapter<
  TUnit extends TranslationUnitInput,
  TTranslation,
> = {
  readonly targetContent: (translation: TTranslation) => JsonValue;
  readonly locateExistingTarget: (input: {
    readonly sourceUnit: SourceUnitFact<TUnit>;
    readonly translation: ActualTranslationFact<TTranslation>;
  }) => Awaitable<EditTargetResolution>;
  readonly locateNewTarget: (input: {
    readonly sourceUnit: SourceUnitFact<TUnit>;
    readonly language: string;
  }) => Awaitable<EditTargetResolution>;
  readonly dependencies?: (input: {
    readonly sourceUnit: SourceUnitFact<TUnit>;
    readonly language: string;
    readonly association: TranslationAssociationFact;
    readonly translations: readonly ActualTranslationFact<TTranslation>[];
  }) => Awaitable<JsonValue | undefined>;
  readonly write?: (input: {
    readonly edit: SemanticEdit;
    readonly sourceUnit: SourceUnitFact<TUnit>;
    readonly target: SemanticEditTarget;
    readonly currentTranslation?: ActualTranslationFact<TTranslation>;
  }) => Awaitable<void>;
};

export type SemanticEditPreparation =
  | { readonly status: "prepared"; readonly edit: SemanticEdit }
  | { readonly status: "notWritable"; readonly reason: string };

export type SemanticEditInputResolution =
  | { readonly status: "resolved"; readonly input: SemanticEditInput }
  | { readonly status: "notWritable"; readonly reason: string };

export type SemanticEditObservation<
  TUnit extends TranslationUnitInput,
  TTranslation,
> = {
  readonly factsVersion: string;
  readonly sourceReadStatus: SourceReadFact["status"];
  readonly translationReadStatus: CoverageStatus | null;
  readonly sourceUnit: SourceUnitFact<TUnit> | null;
  readonly association: TranslationAssociationFact | null;
  readonly translations: readonly ActualTranslationFact<TTranslation>[];
};

export type SemanticEditResult<
  TUnit extends TranslationUnitInput,
  TTranslation,
> = {
  readonly sourceKey: string;
  readonly language: string;
  readonly status:
    | "written"
    | "writeUnconfirmed"
    | "conflict"
    | "notWritable"
    | "writeFailed"
    | "unprocessed";
  readonly reason?: string;
  readonly before?: SemanticEditObservation<TUnit, TTranslation>;
  readonly after?: SemanticEditObservation<TUnit, TTranslation>;
};

export type SemanticEditBatchResult<
  TUnit extends TranslationUnitInput,
  TTranslation,
> = {
  readonly results: readonly SemanticEditResult<TUnit, TTranslation>[];
};

export async function resolveSemanticEditInput<
  TUnit extends TranslationUnitInput,
  TTranslation,
>(
  facts: FrameworkFacts<TUnit, TTranslation>,
  subject: SemanticEditSubject,
  config: FrameworkConfig<TUnit, TTranslation>,
): Promise<SemanticEditInputResolution> {
  const adapter = config.translationWriteback;
  if (adapter === undefined)
    return {
      status: "notWritable",
      reason: "宿主没有提供译文目标解析能力。",
    };

  const sourceUnit = facts.source.units.find(
    ({ key }) => key === subject.sourceKey,
  );
  if (sourceUnit === undefined)
    return { status: "notWritable", reason: "找不到候选对应的原文单元。" };
  if (sourceUnit.bodyAvailability !== "available")
    return {
      status: "notWritable",
      reason: "原文正文不可用，无法核对编辑输入。",
    };

  const association = facts.associations.find(
    ({ sourceKey, language }) =>
      sourceKey === subject.sourceKey && language === subject.language,
  );
  if (association === undefined)
    return {
      status: "notWritable",
      reason: `目标语言 ${subject.language} 不在当前源译事实中。`,
    };
  if (association.status === "unknown")
    return {
      status: "notWritable",
      reason: "目标范围读取不完整，无法确认唯一写入目标。",
    };
  if (association.status === "conflict")
    return {
      status: "notWritable",
      reason: "当前义务匹配到多条译文，无法确定唯一写入目标。",
    };
  if (association.status === "unavailable")
    return {
      status: "notWritable",
      reason: "现有译文正文不可用，无法核对目标输入。",
    };
  if (
    (association.status === "matched" || association.status === "missing") &&
    association.coverageStatus !== "complete"
  )
    return {
      status: "notWritable",
      reason: "目标范围读取不完整，无法确认唯一写入目标。",
    };

  let currentTranslation: ActualTranslationFact<TTranslation> | undefined;
  if (association.status === "matched") {
    if (association.translationIndexes.length !== 1)
      return {
        status: "notWritable",
        reason: "关联结果没有唯一译文索引。",
      };
    currentTranslation =
      facts.translations.records[association.translationIndexes[0] as number];
    if (
      currentTranslation === undefined ||
      currentTranslation.bodyAvailability !== "available"
    )
      return {
        status: "notWritable",
        reason: "现有译文正文不可用，无法核对目标输入。",
      };
  }

  const translations =
    currentTranslation === undefined ? [] : [currentTranslation];
  let target: SemanticEditTarget;
  let expectedTarget: SemanticEdit["expected"]["target"];
  try {
    const resolution =
      currentTranslation === undefined
        ? await adapter.locateNewTarget({
            sourceUnit,
            language: subject.language,
          })
        : await adapter.locateExistingTarget({
            sourceUnit,
            translation: currentTranslation,
          });
    if (resolution.status === "notWritable")
      return { status: "notWritable", reason: resolution.reason };
    target = {
      kind: currentTranslation === undefined ? "create" : "existing",
      locator: snapshotJson(resolution.locator, "目标定位"),
    };
    expectedTarget =
      currentTranslation === undefined
        ? { status: "missing" }
        : {
            status: "present",
            content: snapshotJson(
              adapter.targetContent(currentTranslation.translation),
              "现有译文正文",
            ),
          };
    const dependencies = await adapter.dependencies?.({
      sourceUnit,
      language: subject.language,
      association,
      translations,
    });
    return {
      status: "resolved",
      input: {
        createdFromFactsVersion: facts.version,
        sourceKey: subject.sourceKey,
        language: subject.language,
        target,
        expected: {
          source: snapshotJson(sourceUnit.unit.source, "原文正文"),
          target: expectedTarget,
          dependencies: snapshotJson(dependencies ?? null, "编辑依赖"),
        },
      },
    };
  } catch (error) {
    return {
      status: "notWritable",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/** 根据已经解析的输入和候选纯计算可保存的语义编辑。 */
export function prepareSemanticEdit(
  input: SemanticEditInput,
  candidate: SemanticEditCandidate,
): SemanticEditPreparation {
  if (
    input.sourceKey !== candidate.sourceKey ||
    input.language !== candidate.language
  )
    return {
      status: "notWritable",
      reason: "候选与已解析的编辑输入不匹配。",
    };

  try {
    const snapshot = snapshotJson(input, "已解析编辑输入") as SemanticEditInput;
    return {
      status: "prepared",
      edit: {
        ...snapshot,
        formatVersion: "l10n.semantic-edit/v1",
        content: snapshotJson(candidate.content, "候选内容"),
      },
    };
  } catch (error) {
    return {
      status: "notWritable",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function applySemanticEdits<
  TUnit extends TranslationUnitInput,
  TTranslation,
>(
  edits: readonly SemanticEdit[],
  config: FrameworkConfig<TUnit, TTranslation>,
): Promise<SemanticEditBatchResult<TUnit, TTranslation>> {
  const results: SemanticEditResult<TUnit, TTranslation>[] = [];
  for (const edit of edits) {
    const base = { sourceKey: edit.sourceKey, language: edit.language };
    const adapter = config.translationWriteback;
    if (adapter === undefined || adapter.write === undefined) {
      results.push({
        ...base,
        status: "notWritable",
        reason: "宿主没有提供语义编辑写入能力。",
      });
      continue;
    }

    let facts: FrameworkFacts<TUnit, TTranslation>;
    try {
      facts = await readFacts(config);
    } catch (error) {
      results.push({
        ...base,
        status: "unprocessed",
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    const beforeObservation = readEditObservation(
      facts,
      edit.sourceKey,
      edit.language,
    );
    const before = snapshotEditObservation(beforeObservation);
    const validation = await validateSemanticEdit(
      edit,
      beforeObservation,
      config,
    );
    if (validation.status !== "ready") {
      results.push({
        ...base,
        status: validation.status,
        reason: validation.reason,
        before,
      });
      continue;
    }

    try {
      await adapter.write({
        edit,
        sourceUnit: validation.sourceUnit,
        target: edit.target,
        ...(validation.currentTranslation === undefined
          ? {}
          : { currentTranslation: validation.currentTranslation }),
      });
    } catch (error) {
      let after: SemanticEditObservation<TUnit, TTranslation> | undefined;
      try {
        after = snapshotEditObservation(
          readEditObservation(
            await readFacts(config),
            edit.sourceKey,
            edit.language,
          ),
        );
      } catch {
        // 保留写入失败结果；回读错误不会覆盖更直接的写入故障。
      }
      results.push({
        ...base,
        status: "writeFailed",
        reason: error instanceof Error ? error.message : String(error),
        before,
        ...(after === undefined ? {} : { after }),
      });
      continue;
    }

    try {
      const afterFacts = await readFacts(config);
      const afterObservation = readEditObservation(
        afterFacts,
        edit.sourceKey,
        edit.language,
      );
      const after = snapshotEditObservation(afterObservation);
      if (confirmsEditContent(edit, afterObservation, adapter)) {
        results.push({ ...base, status: "written", before, after });
      } else {
        results.push({
          ...base,
          status: "writeUnconfirmed",
          reason: "写入已返回成功，但回读结果未确认候选内容。",
          before,
          after,
        });
      }
    } catch (error) {
      results.push({
        ...base,
        status: "writeUnconfirmed",
        reason: `写入已返回成功，但回读失败：${error instanceof Error ? error.message : String(error)}`,
        before,
      });
    }
  }
  return { results };
}

async function validateSemanticEdit<
  TUnit extends TranslationUnitInput,
  TTranslation,
>(
  edit: SemanticEdit,
  observation: SemanticEditObservation<TUnit, TTranslation>,
  config: FrameworkConfig<TUnit, TTranslation>,
): Promise<
  | {
      readonly status: "ready";
      readonly sourceUnit: SourceUnitFact<TUnit>;
      readonly currentTranslation?: ActualTranslationFact<TTranslation>;
    }
  | {
      readonly status: "conflict" | "notWritable" | "unprocessed";
      readonly reason: string;
    }
> {
  if (edit.formatVersion !== "l10n.semantic-edit/v1")
    return { status: "unprocessed", reason: "不支持的语义编辑版本。" };

  const adapter = config.translationWriteback;
  if (adapter === undefined)
    return { status: "notWritable", reason: "宿主没有提供译文写回适配器。" };

  const sourceUnit = observation.sourceUnit;
  if (sourceUnit === null) {
    return observation.sourceReadStatus === "complete"
      ? { status: "conflict", reason: "候选对应的原文单元已不存在。" }
      : { status: "unprocessed", reason: "当前原文读取不足，无法核对编辑。" };
  }
  if (sourceUnit.bodyAvailability !== "available")
    return { status: "unprocessed", reason: "当前原文正文不可用。" };

  let currentSource: JsonValue;
  try {
    currentSource = snapshotJson(sourceUnit.unit.source, "当前原文正文");
  } catch (error) {
    return {
      status: "unprocessed",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  if (!isDeepStrictEqual(currentSource, edit.expected.source))
    return { status: "conflict", reason: "原文正文已变化。" };

  const association = observation.association;
  if (association === null)
    return {
      status: "unprocessed",
      reason:
        observation.translationReadStatus === "failed"
          ? "当前目标语言读取失败，无法核对编辑。"
          : "当前目标语言关联尚未读取。",
    };
  if (association.status === "unknown")
    return {
      status: "unprocessed",
      reason: "目标读取不完整，无法核对唯一写入目标。",
    };
  if (association.status === "conflict")
    return {
      status: "conflict",
      reason: "当前原文匹配到多条实际译文，拒绝写入。",
    };
  if (association.status === "unavailable")
    return {
      status: "unprocessed",
      reason: "当前译文正文不可用，无法核对目标输入。",
    };

  let currentTranslation: ActualTranslationFact<TTranslation> | undefined;
  if (edit.expected.target.status === "missing") {
    if (edit.target.kind !== "create")
      return {
        status: "unprocessed",
        reason: "编辑目标类型与预期输入不一致。",
      };
    if (association.status !== "missing")
      return { status: "conflict", reason: "原先缺失的目标现在已存在。" };
    if (association.coverageStatus !== "complete")
      return { status: "unprocessed", reason: "当前目标范围读取不完整。" };
  } else {
    if (edit.target.kind !== "existing")
      return {
        status: "unprocessed",
        reason: "编辑目标类型与预期输入不一致。",
      };
    if (association.status === "missing")
      return { status: "conflict", reason: "原先的目标译文现在已缺失。" };
    if (association.status !== "matched")
      return { status: "conflict", reason: "当前译文不再是唯一匹配目标。" };
    if (association.coverageStatus !== "complete")
      return { status: "unprocessed", reason: "当前目标范围读取不完整。" };
    if (association.translationIndexes.length !== 1)
      return { status: "conflict", reason: "当前译文不再是唯一匹配目标。" };
    currentTranslation = observation.translations[0];
    if (
      currentTranslation === undefined ||
      currentTranslation.bodyAvailability !== "available"
    )
      return { status: "unprocessed", reason: "当前译文正文不可用。" };
    let currentTargetContent: JsonValue;
    try {
      currentTargetContent = snapshotJson(
        adapter.targetContent(currentTranslation.translation),
        "当前译文正文",
      );
    } catch (error) {
      return {
        status: "unprocessed",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    if (!isDeepStrictEqual(currentTargetContent, edit.expected.target.content))
      return { status: "conflict", reason: "目标译文内容已变化。" };
  }

  let dependencies: JsonValue;
  let resolution: EditTargetResolution;
  try {
    dependencies = snapshotJson(
      (await adapter.dependencies?.({
        sourceUnit,
        language: edit.language,
        association,
        translations: observation.translations,
      })) ?? null,
      "当前编辑依赖",
    );
    resolution =
      currentTranslation === undefined
        ? await adapter.locateNewTarget({ sourceUnit, language: edit.language })
        : await adapter.locateExistingTarget({
            sourceUnit,
            translation: currentTranslation,
          });
  } catch (error) {
    return {
      status: "notWritable",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  if (resolution.status === "notWritable")
    return { status: "notWritable", reason: resolution.reason };
  if (!isDeepStrictEqual(dependencies, edit.expected.dependencies))
    return { status: "conflict", reason: "候选声明的上下文依赖已变化。" };
  if (!isDeepStrictEqual(resolution.locator, edit.target.locator))
    return { status: "conflict", reason: "宿主解析出的实际目标位置已变化。" };

  return {
    status: "ready",
    sourceUnit,
    ...(currentTranslation === undefined ? {} : { currentTranslation }),
  };
}

function readEditObservation<TUnit extends TranslationUnitInput, TTranslation>(
  facts: FrameworkFacts<TUnit, TTranslation>,
  sourceKey: string,
  language: string,
): SemanticEditObservation<TUnit, TTranslation> {
  const sourceUnit =
    facts.source.units.find(({ key }) => key === sourceKey) ?? null;
  const association =
    facts.associations.find(
      (item) => item.sourceKey === sourceKey && item.language === language,
    ) ?? null;
  const translations = (association?.translationIndexes ?? []).flatMap(
    (index) => {
      const fact = facts.translations.records[index];
      return fact === undefined ? [] : [fact];
    },
  );
  return {
    factsVersion: facts.version,
    sourceReadStatus: facts.source.read.status,
    translationReadStatus:
      facts.translations.reads.find((read) => read.language === language)
        ?.status ?? null,
    sourceUnit,
    association,
    translations,
  };
}

function snapshotEditObservation<
  TUnit extends TranslationUnitInput,
  TTranslation,
>(
  observation: SemanticEditObservation<TUnit, TTranslation>,
): SemanticEditObservation<TUnit, TTranslation> {
  return snapshotJson(observation, "编辑事实观察") as SemanticEditObservation<
    TUnit,
    TTranslation
  >;
}

function confirmsEditContent<TUnit extends TranslationUnitInput, TTranslation>(
  edit: SemanticEdit,
  observation: SemanticEditObservation<TUnit, TTranslation>,
  adapter: TranslationWritebackAdapter<TUnit, TTranslation>,
): boolean {
  if (
    observation.association?.status !== "matched" ||
    observation.association.translationIndexes.length !== 1
  )
    return false;
  const translation = observation.translations[0];
  if (translation === undefined || translation.bodyAvailability !== "available")
    return false;
  return isDeepStrictEqual(
    snapshotJson(
      adapter.targetContent(translation.translation),
      "回读译文正文",
    ),
    edit.content,
  );
}

function snapshotJson(value: unknown, description: string): JsonValue {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new TypeError(`${description}必须可序列化为 JSON。`, {
      cause: error,
    });
  }
  if (serialized === undefined)
    throw new TypeError(`${description}必须可序列化为 JSON。`);
  return JSON.parse(serialized) as JsonValue;
}
