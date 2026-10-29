import type {
  ActualTranslationFact,
  Awaitable,
  FrameworkFacts,
  QualityCheckDefinition,
  QualityInputBasis,
  QualityCheckInput,
  QualityCheckOutcome,
  QualityCheckProjectionInput,
  QualityCheckRuleInput,
  QualityCheckSelection,
  QualityEvidence,
  QualityIssue,
  QualityLocation,
  QualityObject,
  SourceUnitFact,
  TranslationAssociationFact,
  TranslationUnitInput,
} from "@lioni/core";
import {
  QualityCheckBindingError,
  bindQualityCheck,
  StandardSchemaContractError,
  snapshotJsonValue,
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

export type MessageFamilyCandidateProjection<
  TSelectedUnit extends TranslationUnitInput,
  TBody,
  TSubject extends MessageFamilySubject<TSelectedUnit, TBody> =
    MessageFamilySubject<TSelectedUnit, TBody>,
> = {
  readonly kind: "candidate";
  readonly subject: TSubject;
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

export type MessageFamilyProjection<
  TUnit extends TranslationUnitInput,
  TSelectedUnit extends TUnit,
  TTranslation,
  TBody,
  TUnavailable,
  TSubject extends MessageFamilySubject<TSelectedUnit, TBody> =
    MessageFamilySubject<TSelectedUnit, TBody>,
> =
  | MessageFamilyCandidateProjection<TSelectedUnit, TBody, TSubject>
  | MessageFamilyReferenceProjection<TUnit, TTranslation, TBody, TUnavailable>;

export type MessageFamilyCheckerOptions<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TSelectedUnit extends TUnit,
  TBody,
  TUnavailable = never,
  TSubject extends MessageFamilySubject<TSelectedUnit, TBody> =
    MessageFamilySubject<TSelectedUnit, TBody>,
> = {
  readonly id?: string;
  /** 宿主投影、分析配置与等价策略的版本。 */
  readonly hostVersion: string;
  readonly select: (
    input: QualityCheckInput<TUnit, TTranslation, unknown, TBody, TUnavailable>,
  ) => Awaitable<QualityCheckSelection<TSubject>>;
  /** 只映射宿主资料，不执行分析；候选与已保存参照共用该映射。 */
  readonly project: (
    input: MessageFamilyProjection<
      TUnit,
      TSelectedUnit,
      TTranslation,
      TBody,
      TUnavailable,
      TSubject
    >,
    context: QualityCheckInput<
      TUnit,
      TTranslation,
      unknown,
      TBody,
      TUnavailable
    >,
  ) => Awaitable<MessageFamilyInput>;
  /** 候选可访问完整 QA 输入，以便复用候选共用投影。 */
  readonly projectCandidate?: (
    input: QualityCheckProjectionInput<
      TUnit,
      TTranslation,
      unknown,
      TSubject,
      TBody,
      TUnavailable
    >,
  ) => Awaitable<MessageFamilyInput>;
  /**
   * 显式声明宿主投影、选择及等价策略所用的额外依据。
   * 工厂自动补入全部同族参照、候选签名、关联、位置及完整性；未声明时沿用核心完整事实默认值。
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
    input: QualityCheckInput<TUnit, TTranslation, unknown, TBody, TUnavailable>,
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

const defaultLimits: MessageFamilyLimits = {
  maxCategories: 6,
  maxSourcesPerCategory: 3,
};

const inputSchema = messageFamilyInputSchema;

const defaultTemplate: TemplateOptions = { abstract: () => undefined };

/** 通过正式 QA 绑定接入宿主事实，并比较显式投影的消息族。 */
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
  TUnavailable
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

  async function projectReferences(
    input: QualityCheckInput<TUnit, TTranslation, unknown, TBody, TUnavailable>,
    language: string,
    candidateSourceKey: string,
    familyKeys: ReadonlySet<string>,
  ): Promise<ProjectedReferences> {
    const facts = input.facts;
    const issues: MessageFamilyIssue[] = [];
    const references: MessageFamilyReference[] = [];
    const basis: unknown[] = [];
    let incomplete = false;
    const sourceByKey = new Map(
      facts.source.units.map((unit) => [unit.key, unit]),
    );
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

    const replacedIndex = candidateRecordIndex(
      facts,
      candidateSourceKey,
      language,
    );
    for (const association of facts.associations) {
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
        ["unknown", "conflict", "unavailable"].includes(association.status);
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
        ["unknown", "conflict", "unavailable"].includes(association.status)
      )
        associationIssues.push(
          issue(
            association.status === "conflict"
              ? "translationAssociationConflict"
              : association.status === "unknown"
                ? "translationAssociationUnknown"
                : association.status === "unavailable"
                  ? "translationBodyUnavailable"
                  : "translationAssociationIncomplete",
            `原文 ${sourceKey} 的目标译文关联不完整（${association.status}）。`,
            { language, sourceKey },
          ),
        );
      let knownFamilies = association.translationIndexes.length > 0;
      let relevant = false;
      const projectedBasis: unknown[] = [];
      for (const translationIndex of association.translationIndexes) {
        if (translationIndex === replacedIndex) continue;
        const translation = facts.translations.records[translationIndex];
        if (translation === undefined || translation.language !== language) {
          knownFamilies = false;
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
        let projected: MessageFamilyInput;
        try {
          projected = validateProjection(
            await options.project(
              {
                kind: "reference",
                sourceUnit,
                sourceKey,
                language,
                association,
                translation,
              },
              input,
            ),
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
        if (projected.complete === false) {
          knownFamilies = false;
          associationIncomplete = true;
          if (projectionIssues.length === 0)
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
              input.memo,
              input,
            );
          }),
        );
        const projectionRelevant = signedGroups.some(({ familyKey }) =>
          familyKeys.has(familyKey),
        );
        if (signedGroups.some(({ familyKey }) => familyKey === ""))
          knownFamilies = false;
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
      index: indexMessageFamilies(references),
      incomplete,
      issues: issues.sort(stableCompare),
      basis: basis.sort(stableCompare),
    };
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
    TUnavailable
  >({
    id: checkId,
    version: `checks.message-family-consistency/v2+${options.hostVersion}`,
    configurationSchema,
    configuration: { limits },
    inputSchema,
    select: async (input) => {
      const selection = await options.select(input);
      if (selection.status !== "selected") return selection;
      const subject = selection.subject;
      const projected = validateProjection(
        options.projectCandidate === undefined
          ? await options.project({ kind: "candidate", subject }, input)
          : await options.projectCandidate({ ...input, subject }),
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
      // 宿主回调可读取当前候选，参照准备不可按 facts/language 错误共享首次候选的结果。
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
            );
            return snapshotJsonValue(
              {
                input: options.fingerprintInput!({ ...input, subject }),
                candidate: {
                  sourceKey: subject.sourceKey,
                  language: subject.language,
                  complete: input.projected.complete ?? true,
                  issues: input.projected.issues ?? [],
                  groups: input.subject.groups.map(signedBasis),
                },
                candidateSourceAvailability:
                  subject.sourceUnit.bodyAvailability,
                candidateLocation: translationLocation(
                  input.facts,
                  subject.sourceKey,
                  subject.language,
                  candidateRecordIndex(
                    input.facts,
                    subject.sourceKey,
                    subject.language,
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
                              input.facts.translations.records[index]
                                ?.identity ?? null,
                          )
                          .sort(stableCompare),
                      },
                references: input.subject.references.basis,
                issues: input.subject.references.issues,
                incomplete: input.subject.references.incomplete,
              },
              "消息族检查依据",
            );
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
        association.status === "conflict" ||
        association.status === "unavailable"
      ) {
        incomplete = true;
        candidateIssues.push(
          issue(
            association?.status === "conflict"
              ? "candidateAssociationConflict"
              : "candidateAssociationUnknown",
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
        input: QualityCheckInput<
          TUnit,
          TTranslation,
          unknown,
          TBody,
          TUnavailable
        >,
      ) => string)
    | undefined,
  language: string,
  context: { readonly sourceKey?: string },
  memo: MemoScope,
  input: QualityCheckInput<TUnit, TTranslation, unknown, TBody, TUnavailable>,
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
      targetEquivalence?.(signature, language, input) ??
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
): number | undefined {
  const association = findAssociation(facts, sourceKey, language);
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
): TranslationAssociationFact | undefined {
  return facts.associations.find(
    (association) =>
      association.sourceKey === sourceKey && association.language === language,
  );
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
