import type {
  ActualTranslationFact,
  Awaitable,
  FrameworkFacts,
  QualityCheckDefinition,
  QualityCheckInput,
  QualityCheckOutcome,
  QualityDataLoadInput,
  QualityCheckProjectionInput,
  QualityCheckRuleInput,
  QualityCheckSelection,
  QualityEvidence,
  QualityInputBasis,
  QualityIssue,
  QualityLocation,
  QualityObject,
  SourceUnitFact,
  TranslationAssociationFact,
  TranslationUnitInput,
} from "@lioni/core";
import {
  QualityCheckBindingError,
  assertJsonValue,
  bindQualityCheck,
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
} from "./message-families.ts";
import type {
  MessageFamilyComparison,
  MessageFamilyGroup,
  MessageFamilyIndex,
  MessageFamilyInput,
  MessageFamilyIssue,
  MessageFamilyLimits,
  MessageFamilyReference,
  MessageFragment,
} from "./message-families.ts";
import {
  compareMessageFamily,
  indexMessageFamilies,
} from "./message-families.ts";
import { MessageFamilyBasis } from "./message-family-basis.ts";
const configurationSchema = z
  .object({ limits: messageFamilyLimitsSchema })
  .readonly();
type Configuration = z.output<typeof configurationSchema>;

export type MessageFamilySubject<
  TSelectedUnit extends TranslationUnitInput,
  TBody,
> = {
  readonly sourceUnit: SourceUnitFact<TSelectedUnit>;
  readonly sourceKey: string;
  readonly language: string;
  readonly content: TBody;
};

export type MessageFamilyReferenceProjection<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
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

/** 同次检查的固定依据；参照解释不能读取当前候选。 */
export type MessageFamilyContext<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable = never,
> = Pick<
  QualityCheckInput<TUnit, TTranslation, unknown, TBody, TUnavailable>,
  "facts" | "dependencies" | "relationships" | "memo"
>;

export type MessageFamilyCheckerOptions<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TSelectedUnit extends TUnit,
  TBody,
  TUnavailable = never,
  TSubject extends MessageFamilySubject<TSelectedUnit, TBody> =
    MessageFamilySubject<TSelectedUnit, TBody>,
> = {
  /** 普通可选 string 会产生宽 ID；静态选择需要依赖运行时目录校验。 */
  readonly id?: string;
  /** 宿主投影、分析配置与等价策略的版本。 */
  readonly hostVersion: string;
  /** 只在检查项已选且存在候选时读取；可用同一 qualityData reader 显式共享。 */
  readonly loadDependencies?: (
    input: QualityDataLoadInput<TUnit, TTranslation, TBody, TUnavailable>,
  ) => Awaitable<unknown>;
  readonly select: (
    input: QualityCheckInput<TUnit, TTranslation, unknown, TBody, TUnavailable>,
  ) => Awaitable<QualityCheckSelection<TSubject>>;
  /** 投影当前候选；保留候选选择后的完整上下文。 */
  readonly project: (
    input: QualityCheckProjectionInput<
      TUnit,
      TTranslation,
      unknown,
      TSubject,
      TBody,
      TUnavailable
    >,
  ) => Awaitable<MessageFamilyInput>;
  /** 投影已保存参照，同一固定依据下可跨候选复用。 */
  readonly reference: (
    reference: MessageFamilyReferenceProjection<
      TUnit,
      TTranslation,
      TBody,
      TUnavailable
    >,
    context: MessageFamilyContext<TUnit, TTranslation, TBody, TUnavailable>,
  ) => Awaitable<MessageFamilyInput>;
  /**
   * 显式声明宿主投影、选择及等价策略所用的额外依据。
   * 工厂自动补入全部同族参照、候选签名、关联、位置及完整性；未声明时沿用核心完整事实默认值。
   * 回调返回后核心立即校验并摘要；此处只读访问共享输入。
   */
  readonly fingerprintInput?: (
    input: QualityCheckRuleInput<
      TUnit,
      TTranslation,
      unknown,
      TSubject,
      MessageFamilyInput,
      TBody,
      TUnavailable
    >,
  ) => QualityInputBasis;
  readonly analysis?: TextAnalysis;
  readonly sourceTemplate?: TemplateOptions;
  readonly targetTemplate?: TemplateOptions;
  /** 将合法等价签名映射到同一键；未映射签名使用自身签名键。 */
  readonly targetEquivalence?: (
    signature: TemplateSignature,
    language: string,
    input: MessageFamilyContext<TUnit, TTranslation, TBody, TUnavailable>,
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
  readonly index: MessageFamilyIndex;
  readonly incomplete: boolean;
  readonly issues: readonly MessageFamilyIssue[];
  readonly basis: readonly unknown[];
};

type ReferenceEvidence = Pick<
  ProjectedReferences,
  "incomplete" | "issues" | "basis"
>;

const defaultLimits: MessageFamilyLimits = {
  maxCategories: 6,
  maxSourcesPerCategory: 3,
};

const inputSchema = messageFamilyInputSchema;

const defaultTemplate: TemplateOptions = { abstract: () => undefined };

/**
 * 通过正式 QA 绑定接入宿主事实，并比较显式投影的消息族。
 * 字面量 ID 保留精确类型；普通可选 string ID 返回 string，选择由运行时目录校验。
 */
export function createMessageFamilyChecker<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TSelectedUnit extends TUnit,
  TBody,
  TUnavailable = never,
  TSubject extends MessageFamilySubject<TSelectedUnit, TBody> =
    MessageFamilySubject<TSelectedUnit, TBody>,
>(
  options: MessageFamilyCheckerOptions<
    TUnit,
    TTranslation,
    TSelectedUnit,
    TBody,
    TUnavailable,
    TSubject
  > & { readonly id?: undefined },
): QualityCheckDefinition<
  TUnit,
  TTranslation,
  QualityObject,
  TBody,
  TUnavailable,
  "message-family-consistency"
>;
export function createMessageFamilyChecker<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TSelectedUnit extends TUnit,
  TBody,
  TUnavailable = never,
  TSubject extends MessageFamilySubject<TSelectedUnit, TBody> =
    MessageFamilySubject<TSelectedUnit, TBody>,
  const TId extends string = string,
>(
  options: MessageFamilyCheckerOptions<
    TUnit,
    TTranslation,
    TSelectedUnit,
    TBody,
    TUnavailable,
    TSubject
  > & { readonly id: TId },
): QualityCheckDefinition<
  TUnit,
  TTranslation,
  QualityObject,
  TBody,
  TUnavailable,
  TId
>;
export function createMessageFamilyChecker<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TSelectedUnit extends TUnit,
  TBody,
  TUnavailable = never,
  TSubject extends MessageFamilySubject<TSelectedUnit, TBody> =
    MessageFamilySubject<TSelectedUnit, TBody>,
>(
  options: MessageFamilyCheckerOptions<
    TUnit,
    TTranslation,
    TSelectedUnit,
    TBody,
    TUnavailable,
    TSubject
  >,
): QualityCheckDefinition<
  TUnit,
  TTranslation,
  QualityObject,
  TBody,
  TUnavailable,
  string
>;
export function createMessageFamilyChecker<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TSelectedUnit extends TUnit,
  TBody,
  TUnavailable = never,
  TSubject extends MessageFamilySubject<TSelectedUnit, TBody> =
    MessageFamilySubject<TSelectedUnit, TBody>,
>(
  options: MessageFamilyCheckerOptions<
    TUnit,
    TTranslation,
    TSelectedUnit,
    TBody,
    TUnavailable,
    TSubject
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
  const loadDependencies = options.loadDependencies;
  const limits = {
    maxCategories: options.limits?.maxCategories ?? defaultLimits.maxCategories,
    maxSourcesPerCategory:
      options.limits?.maxSourcesPerCategory ??
      defaultLimits.maxSourcesPerCategory,
  };

  const savedReferenceKey = (
    reference: MessageFamilyReferenceProjection<
      TUnit,
      TTranslation,
      TBody,
      TUnavailable
    >,
    context: MessageFamilyContext<TUnit, TTranslation, TBody, TUnavailable>,
  ): readonly unknown[] => [
    context.facts,
    context.dependencies,
    context.relationships,
    reference.sourceUnit,
    reference.association,
    reference.translation,
    reference.language,
  ];

  // 关联属于映射依据：同一物理译文通过不同原文映射时不能共享投影。
  async function prepareSavedReference(
    reference: MessageFamilyReferenceProjection<
      TUnit,
      TTranslation,
      TBody,
      TUnavailable
    >,
    context: MessageFamilyContext<TUnit, TTranslation, TBody, TUnavailable>,
  ) {
    const { sourceKey, language } = reference;
    let projected: MessageFamilyInput;
    try {
      projected = validateProjection(
        await options.reference(reference, context),
        sourceKey,
        language,
        checkId,
      );
    } catch (error) {
      throw new QualityCheckBindingError(checkId, "projection", error);
    }
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
    return { projected, projectionIssues, signedGroups };
  }

  async function evaluateReferences(
    input: MessageFamilyContext<TUnit, TTranslation, TBody, TUnavailable>,
    language: string,
    replacedIndex: number | undefined,
    familyKeys: ReadonlySet<string>,
    associations: readonly TranslationAssociationFact[],
    sourceByKey: ReadonlyMap<string, SourceUnitFact<TUnit>>,
    readEvidence: boolean,
  ): Promise<ReferenceEvidence> {
    const facts = input.facts;
    const issues: MessageFamilyIssue[] = [];
    const basis: unknown[] = [];
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
        basis.push({ sourceRead: facts.source.read });
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
        basis.push({ translationRead: translationRead ?? null });
      }
    }
    for (const association of associations) {
      if (association.language !== language) continue;
      const sourceKey = association.sourceKey;
      const sourceUnit = sourceByKey.get(sourceKey);
      const associationBasis = {
        sourceKey,
        language,
        status: association.status,
        coverageStatus: association.coverageStatus,
        translations: association.translationIndexes
          .map((index) => facts.translations.records[index]?.identity ?? null)
          .sort(stableCompare),
      };
      if (sourceUnit === undefined) {
        incomplete = true;
        issues.push(
          issue(
            "sourceAssociationUnavailable",
            "消息族关联缺少对应原文单元。",
            { language, sourceKey },
          ),
        );
        basis.push(associationBasis);
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
        const prepared = await input.memo.memo(prepareSavedReference, {
          key: savedReferenceKey,
        })(
          {
            kind: "reference",
            sourceUnit,
            sourceKey,
            language,
            association,
            translation,
          },
          fixedContext(input),
        );
        preparedRecords.set(translationIndex, prepared);
        if (
          prepared.projected.complete === false ||
          prepared.signedGroups.some(({ familyKey }) => familyKey === "")
        )
          knownFamilies = false;
      }
      let relevant = false;
      const projectedBasis: unknown[] = [];
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
          projectedBasis.push({
            identity: translation.identity,
            location: translation.range,
            complete: projected.complete ?? true,
            issues: projectionIssues,
          });
        }
        for (const signed of signedGroups) {
          if (signed.familyKey !== "" && !familyKeys.has(signed.familyKey))
            continue;
          issues.push(...signed.issues);
          projectedBasis.push({
            identity: translation.identity,
            location: translation.range,
            ...signedBasis(signed),
          });
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
          (associationIssues.length > 0 || projectedBasis.length > 0))
      ) {
        issues.push(...associationIssues);
        incomplete ||= associationIncomplete;
        basis.push({
          association: associationBasis,
          sourceAvailability: sourceUnit.bodyAvailability,
          projections: projectedBasis.sort(stableCompare),
        });
      }
    }
    return {
      incomplete,
      issues: issues.sort(stableCompare),
      basis: basis.sort(stableCompare),
    };
  }

  const directoryKey = (
    input: MessageFamilyContext<TUnit, TTranslation, TBody, TUnavailable>,
    language: string,
    _firstExcluded: number | undefined,
  ): readonly unknown[] => [
    input.facts,
    input.dependencies,
    input.relationships,
    language,
  ];

  async function prepareDirectory(
    input: MessageFamilyContext<TUnit, TTranslation, TBody, TUnavailable>,
    language: string,
    firstExcluded: number | undefined,
  ) {
    const facts = input.facts;
    const sourceByKey = new Map(
      facts.source.units.map((unit) => [unit.key, unit]),
    );
    const associations = facts.associations.filter(
      (item) => item.language === language,
    );
    const byRecord = new Map<number, TranslationAssociationFact[]>();
    for (const association of associations) {
      for (const index of association.translationIndexes) {
        const items = byRecord.get(index) ?? [];
        items.push(association);
        byRecord.set(index, items);
      }
    }
    const reads = await evaluateReferences(
      input,
      language,
      undefined,
      new Set(),
      [],
      sourceByKey,
      true,
    );
    const readsDigest = new MessageFamilyBasis([
      ["reads", reads.basis],
    ]).withChanges([]);
    let pending = firstExcluded;
    let index = indexMessageFamilies([]);
    const byFamily = new Map<string, Set<TranslationAssociationFact>>();
    const unknown = new Set<TranslationAssociationFact>();
    type View = {
      readonly chunks: Map<TranslationAssociationFact, ReferenceEvidence>;
      readonly issueAssociations: Set<TranslationAssociationFact>;
      readonly basis: MessageFamilyBasis;
      readonly incompleteCount: number;
    };
    const views = new Map<string, Promise<View>>();
    const associationKey = (association: TranslationAssociationFact) =>
      JSON.stringify([association.language, association.sourceKey]);

    // 首个候选自己的旧记录按需延后；它首次成为其他候选的参照时只补齐一次。
    async function rebuild() {
      byFamily.clear();
      unknown.clear();
      views.clear();
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
          if (translationIndex === pending) continue;
          const translation = facts.translations.records[translationIndex];
          if (translation === undefined || translation.language !== language) {
            unknown.add(association);
            continue;
          }
          const prepared = await input.memo.memo(prepareSavedReference, {
            key: savedReferenceKey,
          })(
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
              translationLocation: {
                language,
                range: translation.range,
                key: sourceKey,
              },
            });
          }
        }
      }
      index = indexMessageFamilies(references);
    }
    await rebuild();

    async function prepareView(familyKey: string): Promise<View> {
      const chunks = new Map<TranslationAssociationFact, ReferenceEvidence>();
      const issueAssociations = new Set<TranslationAssociationFact>();
      const entries: [string, unknown][] = [];
      let incompleteCount = 0;
      for (const association of new Set([
        ...(byFamily.get(familyKey) ?? []),
        ...unknown,
      ])) {
        const chunk = await evaluateReferences(
          input,
          language,
          pending,
          new Set([familyKey]),
          [association],
          sourceByKey,
          false,
        );
        chunks.set(association, chunk);
        if (chunk.basis.length > 0)
          entries.push([associationKey(association), chunk.basis]);
        if (chunk.incomplete) incompleteCount++;
        if (chunk.issues.length > 0) issueAssociations.add(association);
      }
      return {
        chunks,
        issueAssociations,
        basis: new MessageFamilyBasis(entries),
        incompleteCount,
      };
    }

    return async (
      excluded: number | undefined,
      familyKeys: ReadonlySet<string>,
    ): Promise<ProjectedReferences> => {
      if (pending !== undefined && excluded !== pending) {
        pending = undefined;
        await rebuild();
      }
      const basis: unknown[] = [readsDigest];
      let incomplete = reads.incomplete;
      const issueAssociations = new Set<TranslationAssociationFact>();
      const requestedFamilies =
        familyKeys.size === 0 ? new Set([""]) : familyKeys;
      for (const familyKey of [...requestedFamilies].sort()) {
        let promised = views.get(familyKey);
        if (promised === undefined) {
          promised = prepareView(familyKey);
          views.set(familyKey, promised);
        }
        const view = await promised;
        let incompleteCount = view.incompleteCount;
        const changes: [string, unknown][] = [];
        for (const association of view.issueAssociations)
          issueAssociations.add(association);
        if (excluded !== undefined && excluded !== pending) {
          for (const association of byRecord.get(excluded) ?? []) {
            const original = view.chunks.get(association);
            if (original === undefined) continue;
            const replacement = await evaluateReferences(
              input,
              language,
              excluded,
              new Set([familyKey]),
              [association],
              sourceByKey,
              false,
            );
            if (original.incomplete) incompleteCount--;
            if (replacement.incomplete) incompleteCount++;
            if (replacement.issues.length > 0)
              issueAssociations.add(association);
            changes.push([
              associationKey(association),
              replacement.basis.length === 0 ? undefined : replacement.basis,
            ]);
          }
        }
        incomplete ||= incompleteCount > 0;
        basis.push([familyKey, view.basis.withChanges(changes)]);
      }
      // 只展开实际要输出的问题；正常的大族查询不再遍历所有关联或族成员。
      const issues = [...reads.issues];
      for (const association of issueAssociations) {
        const current = await evaluateReferences(
          input,
          language,
          excluded,
          familyKeys,
          [association],
          sourceByKey,
          false,
        );
        issues.push(...current.issues);
        incomplete ||= current.incomplete;
      }
      return { index, incomplete, issues: issues.sort(stableCompare), basis };
    };
  }

  async function projectReferences(
    input: QualityCheckInput<TUnit, TTranslation, unknown, TBody, TUnavailable>,
    language: string,
    sourceKey: string,
    familyKeys: ReadonlySet<string>,
  ): Promise<ProjectedReferences> {
    const excluded = candidateRecordIndex(
      input.facts,
      sourceKey,
      language,
      input.memo,
    );
    const query = await input.memo.memo(prepareDirectory, {
      key: directoryKey,
    })(fixedContext(input), language, excluded);
    return query(excluded, familyKeys);
  }

  type PreparedSubject = {
    readonly value: TSubject;
    readonly projected: MessageFamilyInput;
    readonly groups: readonly SignedMessageGroup[];
    readonly references: ProjectedReferences;
  };

  return bindQualityCheck<
    TUnit,
    TTranslation,
    typeof configurationSchema,
    typeof inputSchema,
    PreparedSubject,
    QualityObject,
    TBody,
    TUnavailable,
    string
  >({
    id: checkId,
    version: `checks.message-family-consistency/v3+${options.hostVersion}`,
    configurationSchema,
    configuration: { limits },
    inputSchema,
    ...(loadDependencies === undefined ? {} : { loadDependencies }),
    select: async (input) => {
      const selection = await options.select(input);
      if (selection.status !== "selected") return selection;
      const subject = selection.subject;
      const projected = validateProjection(
        await options.project({ ...input, subject }),
        subject.sourceKey,
        subject.language,
        checkId,
      );
      const groups = await Promise.all(
        projected.groups.map(async (group) => {
          assertProjectedLanguage(group, subject.language, checkId);
          return signGroup(
            group,
            analysis,
            sourceTemplate,
            targetTemplate,
            options.targetEquivalence,
            subject.language,
            { sourceKey: subject.sourceKey },
            input.memo,
            input,
          );
        }),
      );
      // 候选视图仍须排除自身旧记录；保存参照的映射与签名已按固定依据复用。
      const references = await projectReferences(
        input,
        subject.language,
        subject.sourceKey,
        new Set(groups.map(({ familyKey }) => familyKey)),
      );
      return {
        status: "selected",
        subject: { value: subject, projected, groups, references },
      };
    },
    project: ({ subject }) => ({ status: "ready", value: subject.projected }),
    ...(options.fingerprintInput === undefined
      ? {}
      : {
          fingerprintInput: (
            input: QualityCheckRuleInput<
              TUnit,
              TTranslation,
              Configuration,
              PreparedSubject,
              MessageFamilyInput,
              TBody,
              TUnavailable
            >,
          ) => {
            const subject = input.subject.value;
            const association = findAssociation(
              input.facts,
              subject.sourceKey,
              subject.language,
              input.memo,
            );
            const basis = {
              input: options.fingerprintInput!({ ...input, subject }),
              candidate: {
                sourceKey: subject.sourceKey,
                language: subject.language,
                complete: input.projected.complete ?? true,
                issues: input.projected.issues ?? [],
                groups: input.subject.groups.map(signedBasis),
              },
              candidateSourceAvailability: subject.sourceUnit.bodyAvailability,
              candidateLocation: translationLocation(
                input.facts,
                subject.sourceKey,
                subject.language,
                candidateRecordIndex(
                  input.facts,
                  subject.sourceKey,
                  subject.language,
                  input.memo,
                ),
              ),
              replacement:
                association === undefined
                  ? null
                  : {
                      status: association.status,
                      coverageStatus: association.coverageStatus,
                      translations: association.translationIndexes
                        .map(
                          (index) =>
                            input.facts.translations.records[index]?.identity ??
                            null,
                        )
                        .sort(stableCompare),
                    },
              references: input.subject.references.basis,
              issues: input.subject.references.issues,
              incomplete: input.subject.references.incomplete,
            };
            assertJsonValue(basis, "消息族检查依据");
            return basis;
          },
        }),
    check: async (
      input: QualityCheckRuleInput<
        TUnit,
        TTranslation,
        Configuration,
        PreparedSubject,
        MessageFamilyInput,
        TBody,
        TUnavailable
      >,
    ): Promise<QualityCheckOutcome<QualityObject>> => {
      const object: QualityObject = {
        kind: "translation-unit",
        key: input.subject.value.sourceKey,
        language: input.subject.value.language,
      };
      const candidateLocation = translationLocation(
        input.facts,
        input.subject.value.sourceKey,
        input.subject.value.language,
        candidateRecordIndex(
          input.facts,
          input.subject.value.sourceKey,
          input.subject.value.language,
          input.memo,
        ),
      );
      const candidateIssues: MessageFamilyIssue[] = withSource(
        input.projected.issues ?? [],
        input.subject.value.sourceKey,
        input.subject.value.language,
      );
      let incomplete = input.projected.complete === false;
      if (input.subject.value.sourceUnit.bodyAvailability !== "available") {
        incomplete = true;
        candidateIssues.push(
          issue("candidateSourceUnavailable", "候选对应的原文正文不可用。", {
            language: input.subject.value.language,
            sourceKey: input.subject.value.sourceKey,
          }),
        );
      }
      if (input.projected.complete === false && candidateIssues.length === 0)
        candidateIssues.push(
          issue(
            "candidateProjectionIncomplete",
            "候选投影仍有未提供的消息组。",
            {
              language: input.subject.value.language,
              sourceKey: input.subject.value.sourceKey,
            },
          ),
        );

      const association = findAssociation(
        input.facts,
        input.subject.value.sourceKey,
        input.subject.value.language,
        input.memo,
      );
      const excludedRecordIndexes = new Set<number>();
      if (
        association?.coverageStatus === "complete" &&
        (association.status === "matched" ||
          association.status === "unavailable") &&
        association.translationIndexes.length === 1
      ) {
        excludedRecordIndexes.add(association.translationIndexes[0]!);
      } else if (
        association === undefined ||
        association.coverageStatus !== "complete" ||
        association.status === "unknown" ||
        association.status === "unavailable"
      ) {
        incomplete = true;
        candidateIssues.push(
          issue(
            "candidateAssociationUnknown",
            "无法唯一确认候选替代的已保存译文，保留关联限制。",
            {
              language: input.subject.value.language,
              sourceKey: input.subject.value.sourceKey,
            },
          ),
        );
      }

      const references = input.subject.references;
      const initialCandidateIssueCount = candidateIssues.length;
      incomplete = incomplete || references.incomplete;
      const allIssues = [
        ...candidateIssues,
        ...withSource(
          references.issues,
          undefined,
          input.subject.value.language,
        ),
      ];
      const diagnostics: {
        readonly severity: "warning";
        readonly object: QualityObject;
        readonly location: QualityLocation;
        readonly message: string;
        readonly evidence: readonly QualityEvidence[];
      }[] = [];
      let comparable = false;

      for (const signed of input.subject.groups) {
        const group = signed.group;
        candidateIssues.push(...signed.issues);
        if (signed.familyKey === "") {
          incomplete = true;
          continue;
        }
        const candidateTargetKey = signed.targetKey;
        const comparison = compareMessageFamily(
          references.index,
          {
            familyKey: signed.familyKey,
            targetKey:
              candidateTargetKey ?? "\u0000unknown-candidate-target-signature",
          },
          excludedRecordIndexes,
          input.configuration.limits,
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
                input.subject.value,
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
                  language: input.subject.value.language,
                  sourceKey: input.subject.value.sourceKey,
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
              input.subject.value,
            ),
          );
      }

      allIssues.push(...candidateIssues.slice(initialCandidateIssueCount));
      if (input.projected.groups.length === 0 && !comparable) {
        allIssues.push(
          issue("noComparableReference", "候选投影没有提供可比较的消息组。", {
            language: input.subject.value.language,
            sourceKey: input.subject.value.sourceKey,
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
>(
  group: MessageFamilyGroup,
  analysis: TextAnalysis,
  sourceTemplate: TemplateOptions,
  targetTemplate: TemplateOptions,
  targetEquivalence:
    | ((
        signature: TemplateSignature,
        language: string,
        input: MessageFamilyContext<TUnit, TTranslation, TBody, TUnavailable>,
      ) => string)
    | undefined,
  language: string,
  context: { readonly sourceKey?: string },
  memo: MemoScope,
  input: MessageFamilyContext<TUnit, TTranslation, TBody, TUnavailable>,
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

function createDiagnostic<TSelectedUnit extends TranslationUnitInput, TBody>(
  object: QualityObject,
  location: QualityLocation,
  message: string,
  comparison: MessageFamilyComparison,
  signed: SignedMessageGroup,
  subject: MessageFamilySubject<TSelectedUnit, TBody>,
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

function signedBasis(signed: SignedMessageGroup) {
  return {
    group: signed.group,
    familyKey: signed.familyKey,
    sourceSignatures: signed.sourceSignatures.map(
      messageFamilySignatureEvidence,
    ),
    targetSignatures:
      signed.targetSignatures?.map(messageFamilySignatureEvidence) ?? null,
    targetKey: signed.targetKey ?? null,
    issues: signed.issues,
  };
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
    throw new QualityCheckBindingError(
      checkId,
      "projection",
      new TypeError(
        `消息族投影的目标语言 ${group.target.language} 与适配器语言 ${language} 不一致。`,
      ),
    );
}

function validateProjection(
  value: unknown,
  sourceKey: string,
  language: string,
  checkId: string,
): MessageFamilyInput {
  const result = inputSchema["~standard"].validate(value);
  if ("then" in result)
    throw new QualityCheckBindingError(
      checkId,
      "projection",
      new TypeError("消息族投影 schema 必须同步验证。"),
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
>(
  input: MessageFamilyContext<TUnit, TTranslation, TBody, TUnavailable>,
): MessageFamilyContext<TUnit, TTranslation, TBody, TUnavailable> {
  const { facts, dependencies, relationships, memo } = input;
  return {
    facts,
    dependencies,
    ...(relationships === undefined ? {} : { relationships }),
    memo,
  };
}
