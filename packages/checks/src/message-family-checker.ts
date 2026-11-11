import type {
  ActualTranslationFact,
  Awaitable,
  CheckerLoadInput,
  CheckerPrepareInput,
  CheckerPreparation,
  FrameworkFacts,
  QualityCheckDefinition,
  QualityEvidence,
  QualityIssue,
  QualityLocation,
  QualityObject,
  SourceUnitFact,
  TranslationAssociationFact,
  TranslationUnitInput,
} from "@lioni/core";
import {
  assertJsonValue,
  defineChecker,
  StandardSchemaContractError,
} from "@lioni/core";
import type { MemoScope } from "@lioni/memo";
import type {
  TemplateOptions,
  TemplateSignature,
  TextAnalysis,
} from "@lioni/text-analysis";
import { createTextAnalysis, signatureKey } from "@lioni/text-analysis";
import { z } from "zod";

import {
  messageFamilyInputSchema,
  messageFamilyEvidenceKey,
  messageFamilySignatureEvidence,
  messageFamilyLimitsSchema,
  compareMessageFamily,
  indexMessageFamilies,
} from "./message-families.ts";
import type {
  MessageFamilyComparison,
  MessageFamilyGroup,
  MessageFamilyInput,
  MessageFamilyIssue,
  MessageFamilyLimits,
  MessageFamilyReference,
  MessageFragment,
} from "./message-families.ts";

export type MessageFamilyReferenceProjection<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable = never,
> = {
  readonly kind: "reference";
  readonly sourceUnit: SourceUnitFact<TUnit>;
  readonly sourceKey: string;
  readonly language: string;
  readonly association: TranslationAssociationFact;
  readonly translation: ActualTranslationFact<
    TTranslation,
    TBody,
    TUnavailable
  >;
};

/** 固定参照解释只读取事实与本次加载的资料，不接收当前候选。 */
export type MessageFamilyContext<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable = never,
  TLoaded = unknown,
> = Pick<
  CheckerPrepareInput<TUnit, TTranslation, TBody, TUnavailable, TLoaded>,
  "facts" | "relationships" | "loaded" | "memo"
>;

export type MessageFamilyCheckerOptions<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable = never,
  TLoaded = undefined,
> = {
  readonly id?: string;
  /** 已选且存在候选时加载一次；运行时对象只用于准备完整 JSON 输入。 */
  readonly load?: (
    input: CheckerLoadInput<TUnit, TTranslation, TBody, TUnavailable>,
  ) => Awaitable<TLoaded>;
  /** 逐候选选择适用范围并提供实际消息组，参照由工厂统一准备。 */
  readonly prepare: (
    input: CheckerPrepareInput<
      TUnit,
      TTranslation,
      TBody,
      TUnavailable,
      TLoaded
    >,
  ) => Awaitable<CheckerPreparation<MessageFamilyInput>>;
  readonly reference: (
    reference: MessageFamilyReferenceProjection<
      TUnit,
      TTranslation,
      TBody,
      TUnavailable
    >,
    context: MessageFamilyContext<
      TUnit,
      TTranslation,
      TBody,
      TUnavailable,
      TLoaded
    >,
  ) => Awaitable<MessageFamilyInput>;
  readonly analysis?: TextAnalysis;
  readonly sourceTemplate?: TemplateOptions;
  readonly targetTemplate?: TemplateOptions;
  /** 等价策略解释保存参照与候选时使用同一固定上下文，生成的键进入完整输入。 */
  readonly targetEquivalence?: (
    signature: TemplateSignature,
    language: string,
    context: MessageFamilyContext<
      TUnit,
      TTranslation,
      TBody,
      TUnavailable,
      TLoaded
    >,
  ) => string;
  readonly limits?: Partial<MessageFamilyLimits>;
};

type SignedMessageGroup = {
  readonly group: MessageFamilyGroup;
  readonly familyKey: string;
  readonly sourceSignatures: readonly TemplateSignature[];
  readonly targetSignatures?: readonly TemplateSignature[];
  readonly targetKey?: string;
  readonly issues: readonly MessageFamilyIssue[];
};

type ProjectedReferences = {
  readonly references: readonly Omit<
    MessageFamilyReference,
    "translationIndex"
  >[];
  readonly incomplete: boolean;
  readonly issues: readonly MessageFamilyIssue[];
};

type ReferenceEvidence = Pick<ProjectedReferences, "incomplete" | "issues">;

type CheckInput = {
  readonly sourceKey: string;
  readonly language: string;
  readonly projected: MessageFamilyInput;
  readonly groups: readonly SignedMessageGroup[];
  readonly savedReferences: readonly Omit<
    MessageFamilyReference,
    "translationIndex"
  >[];
  readonly location: QualityLocation;
  readonly sourceAvailability: string;
  readonly associationIncomplete: boolean;
  readonly references: ReferenceEvidence;
  readonly limits: MessageFamilyLimits;
};
const checkInputSchema = z.custom<CheckInput>((value) => {
  assertJsonValue(value, "消息族完整检查输入");
  return typeof value === "object" && value !== null;
});

const defaultLimits: MessageFamilyLimits = {
  maxCategories: 6,
  maxSourcesPerCategory: 3,
};

const projectionSchema = messageFamilyInputSchema;

const defaultTemplate: TemplateOptions = { abstract: () => undefined };

function messageFamilyCheckerFor<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable = never,
>() {
  function create<TLoaded = undefined>(
    options: MessageFamilyCheckerOptions<
      TUnit,
      TTranslation,
      TBody,
      TUnavailable,
      TLoaded
    > & { readonly id?: undefined },
  ): QualityCheckDefinition<
    TUnit,
    TTranslation,
    QualityObject,
    TBody,
    TUnavailable,
    "message-family-consistency"
  >;
  function create<TLoaded = undefined, const TId extends string = string>(
    options: MessageFamilyCheckerOptions<
      TUnit,
      TTranslation,
      TBody,
      TUnavailable,
      TLoaded
    > & { readonly id: TId },
  ): QualityCheckDefinition<
    TUnit,
    TTranslation,
    QualityObject,
    TBody,
    TUnavailable,
    TId
  >;
  function create<TLoaded = undefined>(
    options: MessageFamilyCheckerOptions<
      TUnit,
      TTranslation,
      TBody,
      TUnavailable,
      TLoaded
    >,
  ): QualityCheckDefinition<
    TUnit,
    TTranslation,
    QualityObject,
    TBody,
    TUnavailable,
    string
  >;
  function create<TLoaded = undefined>(
    options: MessageFamilyCheckerOptions<
      TUnit,
      TTranslation,
      TBody,
      TUnavailable,
      TLoaded
    >,
  ) {
    return messageFamilyChecker(options);
  }
  return create;
}

/** 显式宿主类型后继续推导加载资料与检查项 ID。 */
export const createMessageFamilyChecker = Object.assign(messageFamilyChecker, {
  withTypes: messageFamilyCheckerFor,
});

/** 共享已保存参照目录；检查规则只消费当前候选的完整、稳定 JSON 输入。 */
function messageFamilyChecker<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable = never,
  TLoaded = undefined,
>(
  options: MessageFamilyCheckerOptions<
    TUnit,
    TTranslation,
    TBody,
    TUnavailable,
    TLoaded
  > & { readonly id?: undefined },
): QualityCheckDefinition<
  TUnit,
  TTranslation,
  QualityObject,
  TBody,
  TUnavailable,
  "message-family-consistency"
>;
function messageFamilyChecker<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable = never,
  TLoaded = undefined,
  const TId extends string = string,
>(
  options: MessageFamilyCheckerOptions<
    TUnit,
    TTranslation,
    TBody,
    TUnavailable,
    TLoaded
  > & { readonly id: TId },
): QualityCheckDefinition<
  TUnit,
  TTranslation,
  QualityObject,
  TBody,
  TUnavailable,
  TId
>;
function messageFamilyChecker<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable = never,
  TLoaded = undefined,
>(
  options: MessageFamilyCheckerOptions<
    TUnit,
    TTranslation,
    TBody,
    TUnavailable,
    TLoaded
  >,
): QualityCheckDefinition<
  TUnit,
  TTranslation,
  QualityObject,
  TBody,
  TUnavailable,
  string
>;
function messageFamilyChecker<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable = never,
  TLoaded = undefined,
>(
  options: MessageFamilyCheckerOptions<
    TUnit,
    TTranslation,
    TBody,
    TUnavailable,
    TLoaded
  >,
): QualityCheckDefinition<
  TUnit,
  TTranslation,
  QualityObject,
  TBody,
  TUnavailable,
  string
> {
  const checkId = options.id ?? "message-family-consistency";
  const analysis = options.analysis ?? createTextAnalysis();
  const sourceTemplate = options.sourceTemplate ?? defaultTemplate;
  const targetTemplate = options.targetTemplate ?? defaultTemplate;
  const limits = {
    maxCategories: options.limits?.maxCategories ?? defaultLimits.maxCategories,
    maxSourcesPerCategory:
      options.limits?.maxSourcesPerCategory ??
      defaultLimits.maxSourcesPerCategory,
  };
  if (!messageFamilyLimitsSchema.safeParse(limits).success)
    throw new TypeError("消息族展示上限必须为正整数。");
  if (
    typeof options.prepare !== "function" ||
    typeof options.reference !== "function"
  )
    throw new TypeError("消息族检查必须提供 prepare 与 reference 函数。");

  if (options.load !== undefined && typeof options.load !== "function")
    throw new TypeError("消息族 load 必须为函数。");
  if (
    typeof sourceTemplate.abstract !== "function" ||
    typeof targetTemplate.abstract !== "function"
  )
    throw new TypeError("消息族模板必须提供 abstract 函数。");
  if (
    options.targetEquivalence !== undefined &&
    typeof options.targetEquivalence !== "function"
  )
    throw new TypeError("消息族目标等价策略必须为函数。");

  // 关联属于映射依据：同一物理译文通过不同原文映射时不能共享投影。
  async function projectSavedReference(
    reference: MessageFamilyReferenceProjection<
      TUnit,
      TTranslation,
      TBody,
      TUnavailable
    >,
    context: MessageFamilyContext<
      TUnit,
      TTranslation,
      TBody,
      TUnavailable,
      TLoaded
    >,
  ) {
    const { sourceKey, language } = reference;
    const projected = validateProjection(
      await options.reference(reference, context),
      sourceKey,
      language,
      checkId,
    );
    const projectionIssues = withSource(
      projected.issues ?? [],
      sourceKey,
      language,
    );
    if (projected.complete === false && projectionIssues.length === 0) {
      projectionIssues.push(
        issue(
          "referenceProjectionIncomplete",
          "保存参照投影仍有未提供的消息组。",
          { language, sourceKey },
        ),
      );
    }
    const signedGroups = await Promise.all(
      projected.groups.map(async (group) => {
        assertProjectedLanguage(group, language, checkId);
        return signGroup(
          group,
          analysis,
          sourceTemplate,
          targetTemplate,
          options.targetEquivalence,
          language,
          { sourceKey },
          context.memo,
          context,
        );
      }),
    );
    return {
      projected,
      projectionIssues,
      signedGroups: signedGroups.map((signed) => ({
        ...signed,
        sourceSignatures: signed.sourceSignatures.map(
          messageFamilySignatureEvidence,
        ),
        ...(signed.targetSignatures === undefined
          ? {}
          : {
              targetSignatures: signed.targetSignatures.map(
                messageFamilySignatureEvidence,
              ),
            }),
      })),
    };
  }

  const preparedRecords = new WeakMap<
    TranslationAssociationFact,
    Map<
      ActualTranslationFact<TTranslation, TBody, TUnavailable>,
      | Awaited<ReturnType<typeof projectSavedReference>>
      | { readonly error: unknown }
    >
  >();
  async function prepareSavedReference(
    reference: MessageFamilyReferenceProjection<
      TUnit,
      TTranslation,
      TBody,
      TUnavailable
    >,
  ) {
    const prepared = preparedRecords
      .get(reference.association)
      ?.get(reference.translation);
    if (prepared === undefined)
      throw new TypeError("消息族参照目录缺少现存记录。");
    if ("error" in prepared) throw prepared.error;
    return prepared;
  }

  async function evaluateReferences(
    input: MessageFamilyContext<
      TUnit,
      TTranslation,
      TBody,
      TUnavailable,
      TLoaded
    >,
    language: string,
    replacedIndex: number | undefined,
    familyKeys: ReadonlySet<string>,
    associations: readonly TranslationAssociationFact[],
    sourceByKey: ReadonlyMap<string, SourceUnitFact<TUnit>>,
    readEvidence: boolean,
  ): Promise<ReferenceEvidence> {
    const facts = input.facts;
    const issues: MessageFamilyIssue[] = [];
    let incomplete = false;
    if (readEvidence) {
      if (
        facts.source.read.status !== "complete" ||
        facts.source.read.scopes.some(
          ({ enumeration }) => enumeration !== "complete",
        )
      ) {
        incomplete = true;
        issues.push(
          issue(
            "sourceEvidenceIncomplete",
            "原文读取不完整，可能缺少消息族参照。",
          ),
        );
      }
      const translationRead = facts.translations.reads.find(
        (read) => read.language === language,
      );
      // 有明确 covers 的缺口由对应关联处理；没有范围归属的读取失败可能隐藏任意同族参照。
      if (
        translationRead === undefined ||
        translationRead.error !== undefined ||
        translationRead.scopes.some(
          (scope) =>
            scope.enumeration !== "complete" && scope.covers.length === 0,
        )
      ) {
        incomplete = true;
        issues.push(
          issue(
            "translationEvidenceIncomplete",
            `目标语言 ${language} 的译文读取不完整，可能缺少消息族参照。`,
            { language },
          ),
        );
      }
    }
    for (const association of associations) {
      if (association.language !== language) continue;
      const sourceKey = association.sourceKey;
      const sourceUnit = sourceByKey.get(sourceKey);
      if (sourceUnit === undefined) {
        incomplete = true;
        issues.push(
          issue(
            "sourceAssociationUnavailable",
            "消息族关联缺少对应原文单元。",
            { language, sourceKey },
          ),
        );
        continue;
      }
      const associationIssues: MessageFamilyIssue[] = [];
      let associationIncomplete =
        sourceUnit.bodyAvailability !== "available" ||
        association.coverageStatus !== "complete" ||
        ["unknown", "unavailable"].includes(association.status);
      if (sourceUnit.bodyAvailability !== "available")
        associationIssues.push(
          issue(
            "sourceBodyUnavailable",
            "原文正文不可用，无法完整投影消息族。",
            { language, sourceKey },
          ),
        );
      if (
        association.coverageStatus !== "complete" ||
        ["unknown", "unavailable"].includes(association.status)
      )
        associationIssues.push(
          issue(
            association.status === "unknown"
              ? "translationAssociationUnknown"
              : association.status === "unavailable"
                ? "translationBodyUnavailable"
                : "translationAssociationIncomplete",
            `原文 ${sourceKey} 的目标译文关联不完整（${association.status}）。`,
            { language, sourceKey },
          ),
        );
      let knownFamilies = association.translationIndexes.length > 0;
      const preparedRecords = new Map<
        number,
        Awaited<ReturnType<typeof prepareSavedReference>>
      >();
      // 先判定整个关联的归属完整性，再统一选取依据，避免记录顺序改变成员集合。
      for (const translationIndex of association.translationIndexes) {
        if (translationIndex === replacedIndex) continue;
        const translation = facts.translations.records[translationIndex];
        if (translation === undefined || translation.language !== language) {
          knownFamilies = false;
          continue;
        }
        const prepared = await prepareSavedReference({
          kind: "reference",
          sourceUnit,
          sourceKey,
          language,
          association,
          translation,
        });
        preparedRecords.set(translationIndex, prepared);
        if (
          prepared.projected.complete === false ||
          prepared.signedGroups.some(({ familyKey }) => familyKey === "")
        )
          knownFamilies = false;
      }
      let relevant = false;
      for (const translationIndex of association.translationIndexes) {
        if (translationIndex === replacedIndex) continue;
        const translation = facts.translations.records[translationIndex];
        if (translation === undefined || translation.language !== language) {
          associationIncomplete = true;
          associationIssues.push(
            issue(
              "translationRecordUnavailable",
              `目标语言 ${language} 的关联译文记录不可用。`,
              { language, sourceKey },
            ),
          );
          continue;
        }
        const { projected, projectionIssues, signedGroups } =
          preparedRecords.get(translationIndex)!;
        if (projected.complete === false) {
          associationIncomplete = true;
        }
        const projectionRelevant = signedGroups.some(({ familyKey }) =>
          familyKeys.has(familyKey),
        );
        relevant ||= projectionRelevant;
        if (!knownFamilies || projectionRelevant) {
          associationIssues.push(...projectionIssues);
        }
        for (const signed of signedGroups) {
          if (signed.familyKey !== "" && !familyKeys.has(signed.familyKey))
            continue;
          issues.push(...signed.issues);
          if (
            signed.familyKey === "" ||
            signed.targetKey === undefined ||
            signed.targetSignatures === undefined
          ) {
            incomplete = true;
            continue;
          }
        }
      }
      if (
        relevant ||
        (!knownFamilies &&
          (associationIssues.length > 0 || preparedRecords.size > 0))
      ) {
        issues.push(...associationIssues);
        incomplete ||= associationIncomplete;
      }
    }
    return {
      incomplete,
      issues: issues.sort(stableCompare),
    };
  }

  async function prepareDirectory(
    input: MessageFamilyContext<
      TUnit,
      TTranslation,
      TBody,
      TUnavailable,
      TLoaded
    >,
    language: string,
  ) {
    const facts = input.facts;
    const sourceByKey = new Map(
      facts.source.units.map((unit) => [unit.key, unit]),
    );
    const associations = facts.associations.filter(
      (item) => item.language === language,
    );
    const reads = await evaluateReferences(
      input,
      language,
      undefined,
      new Set(),
      [],
      sourceByKey,
      true,
    );
    const byFamily = new Map<string, Set<TranslationAssociationFact>>();
    const unknown = new Set<TranslationAssociationFact>();
    // 同次运行按候选涉及的语言建立一次固定目录。
    const references: MessageFamilyReference[] = [];
    for (const association of associations) {
      const { sourceKey } = association;
      const sourceUnit = sourceByKey.get(sourceKey);
      if (sourceUnit === undefined) {
        unknown.add(association);
        continue;
      }
      if (
        association.translationIndexes.length === 0 &&
        (sourceUnit.bodyAvailability !== "available" ||
          association.coverageStatus !== "complete" ||
          ["unknown", "unavailable"].includes(association.status))
      )
        unknown.add(association);
      for (const translationIndex of association.translationIndexes) {
        const translation = facts.translations.records[translationIndex];
        if (translation === undefined || translation.language !== language) {
          unknown.add(association);
          continue;
        }
        let records = preparedRecords.get(association);
        if (records === undefined) {
          records = new Map();
          preparedRecords.set(association, records);
        }
        let prepared: Awaited<ReturnType<typeof projectSavedReference>>;
        try {
          prepared = await projectSavedReference(
            {
              kind: "reference",
              sourceUnit,
              sourceKey,
              language,
              association,
              translation,
            },
            input,
          );
          records.set(translation, prepared);
        } catch (error) {
          // 替换候选不消费自身旧记录；其投影错误延至实际被其他候选使用时报告。
          records.set(translation, { error });
          unknown.add(association);
          continue;
        }
        if (prepared.projected.complete === false) unknown.add(association);
        for (const signed of prepared.signedGroups) {
          if (signed.familyKey === "") {
            unknown.add(association);
            continue;
          }
          let members = byFamily.get(signed.familyKey);
          if (members === undefined) {
            members = new Set();
            byFamily.set(signed.familyKey, members);
          }
          members.add(association);
          if (
            signed.targetKey === undefined ||
            signed.targetSignatures === undefined
          )
            continue;
          references.push({
            familyKey: signed.familyKey,
            targetKey: signed.targetKey,
            translationIndex,
            translationIdentity: translation.identity,
            sourceKey,
            group: signed.group,
            sourceSignatures: signed.sourceSignatures,
            targetSignatures: signed.targetSignatures,
            translationLocation: prepared.projected.location ?? {
              language,
              range: translation.range,
              key: sourceKey,
            },
          });
        }
      }
    }
    const index = indexMessageFamilies(references);
    // 稳定证据顺序在 load 中固定；物理索引只用于排除自身记录，不进入最终输入。
    const orderedFamilies = new Map(
      [...index.families].map(([familyKey, family]) => [
        familyKey,
        [...family.categories.values()]
          .flatMap((category) => [...category.references.values()])
          .map((reference) => {
            const { translationIndex: _translationIndex, ...evidence } =
              reference;
            return {
              translationIndex: reference.translationIndex,
              reference: evidence,
              key: messageFamilyEvidenceKey(evidence),
            };
          })
          .sort((left, right) =>
            left.key < right.key ? -1 : left.key > right.key ? 1 : 0,
          )
          .map(({ translationIndex, reference }) => ({
            translationIndex,
            reference,
          })),
      ]),
    );

    return async (
      excluded: number | undefined,
      familyKeys: ReadonlySet<string>,
    ): Promise<ProjectedReferences> => {
      const relevant = new Set(
        [...familyKeys].flatMap((familyKey) => [
          ...(byFamily.get(familyKey) ?? []),
        ]),
      );
      for (const association of unknown) relevant.add(association);
      const evidence = await evaluateReferences(
        input,
        language,
        excluded,
        familyKeys,
        [...relevant],
        sourceByKey,
        false,
      );
      return {
        references: [...familyKeys]
          .sort()
          .flatMap((familyKey) => orderedFamilies.get(familyKey) ?? [])
          .filter(({ translationIndex }) => translationIndex !== excluded)
          .map(({ reference }) => reference),
        incomplete: reads.incomplete || evidence.incomplete,
        issues: [...reads.issues, ...evidence.issues].sort(stableCompare),
      };
    };
  }

  return defineChecker.withTypes<TUnit, TTranslation, TBody, TUnavailable>()({
    id: checkId,
    version: "checks.message-family-consistency/v5",
    inputSchema: checkInputSchema,
    load: async (input) => {
      const loaded = (await options.load?.(input)) as TLoaded;
      const context = fixedContext({ ...input, loaded });
      const directories = new Map<
        string,
        Awaited<ReturnType<typeof prepareDirectory>>
      >();
      for (const language of new Set(
        input.candidates.map((candidate) => candidate.language),
      ))
        directories.set(language, await prepareDirectory(context, language));
      return { loaded, directories };
    },
    prepare: async (input) => {
      const context = fixedContext({ ...input, loaded: input.loaded.loaded });
      const preparation = await options.prepare({
        ...input,
        loaded: input.loaded.loaded,
      });
      if (preparation.status !== "ready") return preparation;
      const { sourceKey, language } = input.candidate;
      const projected = validateProjection(
        preparation.input,
        sourceKey,
        language,
        checkId,
      );
      const groups = await Promise.all(
        projected.groups.map(async (group) => {
          assertProjectedLanguage(group, language, checkId);
          return signGroup(
            group,
            analysis,
            sourceTemplate,
            targetTemplate,
            options.targetEquivalence,
            language,
            { sourceKey },
            input.memo,
            context,
          );
        }),
      );
      const excluded = candidateRecordIndex(
        input.facts,
        sourceKey,
        language,
        input.memo,
      );
      const references = await input.loaded.directories.get(language)!(
        excluded,
        new Set(groups.map(({ familyKey }) => familyKey)),
      );
      return {
        status: "ready",
        input: {
          sourceKey,
          language,
          projected,
          groups: groups.map((signed) => ({
            ...signed,
            sourceSignatures: signed.sourceSignatures.map(
              messageFamilySignatureEvidence,
            ),
            ...(signed.targetSignatures === undefined
              ? {}
              : {
                  targetSignatures: signed.targetSignatures.map(
                    messageFamilySignatureEvidence,
                  ),
                }),
          })),
          savedReferences: references.references,
          location:
            projected.location ??
            translationLocation(input.facts, sourceKey, language, excluded),
          sourceAvailability: input.sourceUnit.bodyAvailability,
          associationIncomplete:
            excluded === undefined &&
            (input.association.coverageStatus !== "complete" ||
              ["unknown", "unavailable"].includes(input.association.status)),
          references: {
            incomplete: references.incomplete,
            issues: references.issues,
          },
          limits,
        },
      };
    },
    check: (preparedInput) => {
      // 运行时已按完整输入 schema 校验并固定；避免递归 JSON 引用重复展开只读映射。
      const input = preparedInput as unknown as CheckInput;
      const object: QualityObject = {
        kind: "translation-unit",
        key: input.sourceKey,
        language: input.language,
      };
      const candidateLocation = input.location;
      const candidateIssues: MessageFamilyIssue[] = withSource(
        input.projected.issues ?? [],
        input.sourceKey,
        input.language,
      );
      let incomplete = input.projected.complete === false;
      if (input.sourceAvailability !== "available") {
        incomplete = true;
        candidateIssues.push(
          issue("candidateSourceUnavailable", "候选对应的原文正文不可用。", {
            sourceKey: input.sourceKey,
            language: input.language,
          }),
        );
      }
      if (input.projected.complete === false && candidateIssues.length === 0)
        candidateIssues.push(
          issue(
            "candidateProjectionIncomplete",
            "候选投影仍有未提供的消息组。",
            {
              language: input.language,
              sourceKey: input.sourceKey,
            },
          ),
        );

      if (input.associationIncomplete) {
        incomplete = true;
        candidateIssues.push(
          issue(
            "candidateAssociationUnknown",
            "无法唯一确认候选替代的已保存译文，保留关联限制。",
            { language: input.language, sourceKey: input.sourceKey },
          ),
        );
      }
      const references = input.references;
      const initialCandidateIssueCount = candidateIssues.length;
      incomplete = incomplete || references.incomplete;
      const allIssues = [
        ...candidateIssues,
        ...withSource(references.issues, undefined, input.language),
      ];
      const diagnostics: {
        readonly severity: "warning";
        readonly object: QualityObject;
        readonly location: QualityLocation;
        readonly message: string;
        readonly evidence: readonly QualityEvidence[];
      }[] = [];
      let comparable = false;
      // 既有比较算法按物理记录去重；这里从稳定身份恢复当前输入内的局部索引。
      const recordIndexes = new Map<string, number>();
      const referenceIndex = indexMessageFamilies(
        input.savedReferences.map((reference) => {
          const identity = messageFamilyEvidenceKey(
            reference.translationIdentity,
          );
          if (!recordIndexes.has(identity))
            recordIndexes.set(identity, recordIndexes.size);
          return {
            ...reference,
            translationIndex: recordIndexes.get(identity)!,
          };
        }),
      );

      for (const signed of input.groups) {
        const group = signed.group;
        candidateIssues.push(...signed.issues);
        if (signed.familyKey === "") {
          incomplete = true;
          continue;
        }
        const candidateTargetKey = signed.targetKey;
        const comparison = compareMessageFamily(
          referenceIndex,
          {
            familyKey: signed.familyKey,
            targetKey:
              candidateTargetKey ?? "\u0000unknown-candidate-target-signature",
          },
          new Set(),
          input.limits,
        );

        if (candidateTargetKey === undefined) {
          incomplete = true;
          if (comparison.categoryCount > 1) {
            comparable = true;
            diagnostics.push(
              createDiagnostic(
                object,
                candidateLocation,
                "保存参照中已知存在多种消息表达；候选结构不完整，尚不能确定其目标类别。",
                comparison,
                signed,
                input,
              ),
            );
          }
          continue;
        }

        if (comparison.status === "no-comparison") {
          if (!references.incomplete) {
            allIssues.push(
              issue(
                "noComparableReference",
                "完整保存证据中没有与该消息族相同的参照。",
                {
                  language: input.language,
                  sourceKey: input.sourceKey,
                  ref: group.ref,
                },
              ),
            );
          } else {
            incomplete = true;
          }
          continue;
        }
        comparable = true;
        if (comparison.status === "different")
          diagnostics.push(
            createDiagnostic(
              object,
              candidateLocation,
              "同一消息族的已保存译文存在不同表达；此发现不裁定当前候选错误。",
              comparison,
              signed,
              input,
            ),
          );
      }

      allIssues.push(...candidateIssues.slice(initialCandidateIssueCount));
      if (input.projected.groups.length === 0 && !comparable) {
        allIssues.push(
          issue("noComparableReference", "候选投影没有提供可比较的消息组。", {
            language: input.language,
            sourceKey: input.sourceKey,
          }),
        );
      }

      const notApplicable = !incomplete && !comparable;

      return {
        status: incomplete
          ? "incomplete"
          : notApplicable
            ? "not-applicable"
            : "complete",
        diagnostics,
        issues: allIssues.map((item) => toQualityIssue(item, object)),
        coverage: {
          selected: 1,
          evaluated: notApplicable ? 0 : 1,
          notApplicable: notApplicable ? 1 : 0,
          incomplete: incomplete ? 1 : 0,
          failed: 0,
        },
      };
    },
  });
}

async function signGroup<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
  TLoaded,
>(
  group: MessageFamilyGroup,
  analysis: TextAnalysis,
  sourceTemplate: TemplateOptions,
  targetTemplate: TemplateOptions,
  targetEquivalence:
    | ((
        signature: TemplateSignature,
        language: string,
        input: MessageFamilyContext<
          TUnit,
          TTranslation,
          TBody,
          TUnavailable,
          TLoaded
        >,
      ) => string)
    | undefined,
  language: string,
  context: { readonly sourceKey?: string },
  memo: MemoScope,
  input: MessageFamilyContext<
    TUnit,
    TTranslation,
    TBody,
    TUnavailable,
    TLoaded
  >,
): Promise<SignedMessageGroup> {
  const issues: MessageFamilyIssue[] = [];
  const source = await signText(
    group.source.fragments,
    group.source.language,
    group.source.complete,
    group.source.issues,
    sourceTemplate,
    analysis,
    group.ref,
    context.sourceKey,
    memo,
  );
  issues.push(...source.issues);
  if (source.signatures === undefined)
    return { group, familyKey: "", sourceSignatures: [], issues };
  const familyKey = JSON.stringify([
    group.scope,
    group.source.language,
    group.target.language,
    source.signatures.map(signatureKey),
  ]);
  const target = await signText(
    group.target.fragments,
    group.target.language,
    group.target.complete,
    group.target.issues,
    targetTemplate,
    analysis,
    group.ref,
    context.sourceKey,
    memo,
  );
  issues.push(...target.issues);
  if (target.signatures === undefined)
    return {
      group,
      familyKey,
      sourceSignatures: source.signatures,
      issues,
    };
  const targetParts = target.signatures.map((signature) => {
    const key =
      targetEquivalence?.(signature, language, fixedContext(input)) ??
      signatureKey(signature);
    if (typeof key !== "string" || key.length === 0)
      throw new TypeError("目标签名等价键必须为非空字符串。");
    return key;
  });
  return {
    group,
    familyKey,
    sourceSignatures: source.signatures,
    targetSignatures: target.signatures,
    targetKey: JSON.stringify([group.target.language, targetParts]),
    issues,
  };
}

async function signText(
  fragments: readonly MessageFragment[],
  language: string,
  declaredComplete: boolean | undefined,
  inputIssues: readonly MessageFamilyIssue[] | undefined,
  policy: TemplateOptions,
  analysis: TextAnalysis,
  ref: MessageFamilyGroup["ref"],
  sourceKey: string | undefined,
  memo: MemoScope,
): Promise<{
  readonly signatures?: readonly TemplateSignature[];
  readonly issues: readonly MessageFamilyIssue[];
}> {
  const issues: MessageFamilyIssue[] = (inputIssues ?? []).map((item) => ({
    ...item,
    language: item.language ?? language,
    ...(item.sourceKey !== undefined || sourceKey === undefined
      ? {}
      : { sourceKey }),
    ref: item.ref ?? ref,
  }));
  if (declaredComplete === false) {
    if (issues.length === 0)
      issues.push(
        issue(
          "messageTextIncomplete",
          "消息文本投影不完整，不能形成完整签名。",
          {
            language,
            ...(sourceKey === undefined ? {} : { sourceKey }),
            ref,
          },
        ),
      );
    return { issues };
  }
  const signatures: TemplateSignature[] = [];
  for (const fragment of fragments) {
    const input = {
      text: fragment.text,
      language,
      ...(fragment.protectedRanges === undefined
        ? {}
        : { protectedRanges: fragment.protectedRanges }),
    };
    const structure = await analysis.structures(input, { memo });
    if (!structure.complete) {
      issues.push(
        ...structure.issues.map((item) => ({
          ...item,
          language,
          ...(sourceKey === undefined ? {} : { sourceKey }),
          ref: fragment.ref,
        })),
      );
      if (structure.issues.length === 0)
        issues.push(
          issue(
            "structureIncomplete",
            "消息结构分析不完整，不能形成完整签名。",
            {
              language,
              ...(sourceKey === undefined ? {} : { sourceKey }),
              ref: fragment.ref,
            },
          ),
        );
      return { issues };
    }
    signatures.push(await analysis.signature(input, policy, { memo }));
  }
  return { signatures, issues };
}

function createDiagnostic(
  object: QualityObject,
  location: QualityLocation,
  message: string,
  comparison: MessageFamilyComparison,
  signed: SignedMessageGroup,
  subject: { readonly sourceKey: string; readonly language: string },
): {
  readonly severity: "warning";
  readonly object: QualityObject;
  readonly location: QualityLocation;
  readonly message: string;
  readonly evidence: readonly QualityEvidence[];
} {
  const candidateEvidence: QualityEvidence = {
    role: "candidate",
    object,
    location,
    value: {
      sourceKey: subject.sourceKey,
      language: subject.language,
      groupRef: signed.group.ref,
      scope: signed.group.scope,
      source: signed.group.source,
      target: signed.group.target,
      signatures:
        signed.targetSignatures?.map(messageFamilySignatureEvidence) ?? null,
    },
  };
  const saved: QualityEvidence[] = comparison.categories.flatMap(
    ({ references }) =>
      references.map((reference) => ({
        role: "saved-reference",
        object: {
          kind: "translation-unit",
          key: reference.sourceKey,
          language: reference.group.target.language,
        },
        location: reference.translationLocation ?? {
          language: reference.group.target.language,
          range: null,
          key: reference.sourceKey,
        },
        value: {
          translationIdentity: reference.translationIdentity,
          sourceKey: reference.sourceKey,
          groupRef: reference.group.ref,
          scope: reference.group.scope,
          source: reference.group.source,
          target: reference.group.target,
          sourceSignatures: reference.sourceSignatures.map(
            messageFamilySignatureEvidence,
          ),
          targetSignatures: reference.targetSignatures.map(
            messageFamilySignatureEvidence,
          ),
          category: reference.targetKey,
        },
      })),
  );
  return {
    severity: "warning",
    object,
    location,
    message,
    evidence: [
      candidateEvidence,
      ...saved,
      {
        role: "comparison-summary",
        object,
        location,
        value: {
          categoryCount: comparison.categoryCount,
          referenceCount: comparison.referenceCount,
          omittedCategories: comparison.omittedCategories,
          omittedReferences: comparison.omittedReferences,
          categories: comparison.categories.map(({ key, referenceCount }) => ({
            key,
            referenceCount,
          })),
        },
      },
    ],
  };
}

function stableCompare(left: unknown, right: unknown): number {
  const leftKey = messageFamilyEvidenceKey(left);
  const rightKey = messageFamilyEvidenceKey(right);
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function candidateRecordIndex<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  facts: FrameworkFacts<TUnit, TTranslation, TBody, TUnavailable>,
  sourceKey: string,
  language: string,
  memo: MemoScope,
): number | undefined {
  const association = findAssociation(facts, sourceKey, language, memo);
  if (
    association?.coverageStatus === "complete" &&
    (association.status === "matched" ||
      association.status === "unavailable") &&
    association.translationIndexes.length === 1
  )
    return association.translationIndexes[0];
  return undefined;
}

function findAssociation<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  facts: FrameworkFacts<TUnit, TTranslation, TBody, TUnavailable>,
  sourceKey: string,
  language: string,
  memo: MemoScope,
): TranslationAssociationFact | undefined {
  return memo.memo(indexAssociations)(facts).get(language)?.get(sourceKey);
}

/** 同次事实的关联定位只建一次，避免候选替换和指纹阶段反复线性查找。 */
function indexAssociations(facts: {
  readonly associations: readonly TranslationAssociationFact[];
}) {
  const languages = new Map<string, Map<string, TranslationAssociationFact>>();
  for (const association of facts.associations) {
    let sources = languages.get(association.language);
    if (sources === undefined) {
      sources = new Map();
      languages.set(association.language, sources);
    }
    if (!sources.has(association.sourceKey))
      sources.set(association.sourceKey, association);
  }
  return languages;
}

function translationLocation<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  facts: FrameworkFacts<TUnit, TTranslation, TBody, TUnavailable>,
  sourceKey: string,
  language: string,
  translationIndex: number | undefined,
): QualityLocation {
  const record =
    translationIndex === undefined
      ? undefined
      : facts.translations.records[translationIndex];
  return {
    language,
    range: record?.range ?? null,
    key: sourceKey,
  };
}

function withSource(
  issues: readonly MessageFamilyIssue[],
  sourceKey: string | undefined,
  language: string,
): MessageFamilyIssue[] {
  return issues.map((item) => ({
    ...item,
    ...(item.sourceKey === undefined && sourceKey !== undefined
      ? { sourceKey }
      : {}),
    language: item.language ?? language,
  }));
}

function toQualityIssue(
  item: MessageFamilyIssue,
  object: QualityObject,
): QualityIssue<QualityObject> {
  return {
    code: item.code,
    message: item.message,
    object,
    ...(item.language === undefined
      ? {}
      : {
          location: {
            language: item.language,
            range: item.range ?? null,
            ...(item.sourceKey === undefined ? {} : { key: item.sourceKey }),
          },
        }),
    evidence:
      item.ref === undefined
        ? []
        : [
            {
              role: "limited-input",
              object,
              location: {
                language: item.language ?? null,
                range: item.range ?? null,
                ...(item.sourceKey === undefined
                  ? {}
                  : { key: item.sourceKey }),
              },
              value: { ref: item.ref },
            },
          ],
  };
}

function issue(
  code: string,
  message: string,
  details: Partial<
    Pick<MessageFamilyIssue, "language" | "sourceKey" | "ref" | "range">
  > = {},
): MessageFamilyIssue {
  return { code, message, ...details };
}

function assertProjectedLanguage(
  group: MessageFamilyGroup,
  language: string,
  checkId: string,
): void {
  if (group.target.language !== language)
    throw new StandardSchemaContractError(
      `QA 检查项 ${checkId} 消息族投影`,
      "schema-mismatch",
      `消息族投影的目标语言 ${group.target.language} 与适配器语言 ${language} 不一致。`,
    );
}

function validateProjection(
  value: unknown,
  sourceKey: string,
  language: string,
  checkId: string,
): MessageFamilyInput {
  const result = projectionSchema["~standard"].validate(value);
  if ("then" in result)
    throw new StandardSchemaContractError(
      `QA 检查项 ${checkId} 消息族投影`,
      "invalid-schema-result",
      "消息族投影 schema 必须同步验证。",
    );
  if (result.issues !== undefined)
    throw new StandardSchemaContractError(
      `消息族投影 ${sourceKey}/${language}`,
      "schema-mismatch",
      result.issues.map(({ message }) => message).join("；"),
      result.issues,
    );
  return result.value;
}

function fixedContext<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
  TLoaded,
>(
  input: MessageFamilyContext<
    TUnit,
    TTranslation,
    TBody,
    TUnavailable,
    TLoaded
  >,
): MessageFamilyContext<TUnit, TTranslation, TBody, TUnavailable, TLoaded> {
  const { facts, loaded, relationships, memo } = input;
  return {
    facts,
    loaded,
    relationships,
    memo,
  };
}
