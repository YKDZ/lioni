import type {
  ActualTranslationFact,
  Awaitable,
  FrameworkFacts,
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
  StandardSchemaV1,
  TranslationAssociationFact,
  TranslationUnitInput,
} from "@lioni/core";
import {
  QualityCheckBindingError,
  bindQualityCheck,
  StandardSchemaContractError,
} from "@lioni/core";
import type { MemoScope } from "@lioni/memo";
import type {
  TemplateOptions,
  TemplateSignature,
  TextAnalysis,
  TextRange,
} from "@lioni/text-analysis";
import { createTextAnalysis, signatureKey } from "@lioni/text-analysis";

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

type Configuration = { readonly limits: MessageFamilyLimits };

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
  readonly analysis?: TextAnalysis;
  readonly sourceTemplate?: TemplateOptions;
  readonly targetTemplate?: TemplateOptions;
  /** 将合法等价签名映射到同一键；未映射签名使用自身签名键。 */
  readonly targetEquivalence?: (signature: TemplateSignature) => string;
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
  readonly references: readonly MessageFamilyReference[];
  readonly index: MessageFamilyIndex;
  readonly incomplete: boolean;
  readonly incompleteFamilies: ReadonlySet<string>;
  readonly issues: readonly MessageFamilyIssue[];
};

const defaultLimits: MessageFamilyLimits = {
  maxCategories: 6,
  maxSourcesPerCategory: 3,
};

const configurationSchema: StandardSchemaV1<Configuration, Configuration> = {
  "~standard": {
    version: 1,
    vendor: "lioni-message-family-checker",
    validate(value) {
      if (!isRecord(value) || !isRecord(value.limits))
        return { issues: [{ message: "消息族展示配置无效。" }] };
      const { maxCategories, maxSourcesPerCategory } = value.limits;
      if (
        !isPositiveInteger(maxCategories) ||
        !isPositiveInteger(maxSourcesPerCategory)
      )
        return { issues: [{ message: "消息族展示上限必须为正整数。" }] };
      return {
        value: {
          limits: { maxCategories, maxSourcesPerCategory },
        },
      };
    },
  },
};

const inputSchema: StandardSchemaV1<MessageFamilyInput, MessageFamilyInput> = {
  "~standard": {
    version: 1,
    vendor: "lioni-message-family-checker",
    validate(value) {
      if (!isMessageFamilyInput(value))
        return { issues: [{ message: "消息族投影必须包含有效的 groups。" }] };
      return { value };
    },
  },
};

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
) {
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
    facts: FrameworkFacts<TUnit, TTranslation, TBody, TUnavailable>,
    language: string,
    memo: MemoScope,
  ): Promise<ProjectedReferences> {
    const issues: MessageFamilyIssue[] = [];
    const incompleteFamilies = new Set<string>();
    const references: MessageFamilyReference[] = [];
    let incomplete = false;
    const sourceByKey = new Map(
      facts.source.units.map((unit) => [unit.key, unit]),
    );
    const sourceComplete =
      facts.source.read.status === "complete" &&
      facts.source.read.scopes.every(
        ({ enumeration }) => enumeration === "complete",
      );
    if (!sourceComplete) {
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
    const languageComplete =
      translationRead?.status === "complete" &&
      translationRead.scopes.every(
        ({ enumeration }) => enumeration === "complete",
      );
    if (!languageComplete) {
      incomplete = true;
      issues.push(
        issue(
          "translationEvidenceIncomplete",
          `目标语言 ${language} 的译文读取不完整，可能缺少消息族参照。`,
          { language },
        ),
      );
    }

    for (const association of facts.associations) {
      if (association.language !== language) continue;
      const sourceUnit = sourceByKey.get(association.sourceKey);
      if (sourceUnit === undefined) {
        incomplete = true;
        issues.push(
          issue(
            "sourceAssociationUnavailable",
            "消息族关联缺少对应原文单元。",
            {
              language,
              sourceKey: association.sourceKey,
            },
          ),
        );
        continue;
      }
      if (sourceUnit.bodyAvailability !== "available") {
        incomplete = true;
        issues.push(
          issue(
            "sourceBodyUnavailable",
            "原文正文不可用，无法完整投影消息族。",
            {
              language,
              sourceKey: association.sourceKey,
            },
          ),
        );
      }
      if (
        association.coverageStatus !== "complete" ||
        association.status === "unknown" ||
        association.status === "conflict" ||
        association.status === "unavailable"
      ) {
        incomplete = true;
        issues.push(
          issue(
            association.status === "conflict"
              ? "translationAssociationConflict"
              : association.status === "unknown"
                ? "translationAssociationUnknown"
                : association.status === "unavailable"
                  ? "translationBodyUnavailable"
                  : "translationAssociationIncomplete",
            `原文 ${association.sourceKey} 的目标译文关联不完整（${association.status}）。`,
            { language, sourceKey: association.sourceKey },
          ),
        );
      }
      if (
        association.status === "missing" &&
        association.translationIndexes.length === 0
      )
        continue;

      for (const translationIndex of association.translationIndexes) {
        const translation = facts.translations.records[translationIndex];
        if (translation === undefined || translation.language !== language) {
          incomplete = true;
          issues.push(
            issue(
              "translationRecordUnavailable",
              `译文记录 ${translationIndex} 不在目标语言 ${language} 的读取事实中。`,
              { language, sourceKey: association.sourceKey },
            ),
          );
          continue;
        }
        const context: MessageFamilyReferenceProjection<
          TUnit,
          TTranslation,
          TBody,
          TUnavailable
        > = {
          kind: "reference",
          sourceUnit,
          sourceKey: association.sourceKey,
          language,
          association,
          translation,
        };
        let projected: MessageFamilyInput;
        try {
          projected = await options.project(context);
        } catch (error) {
          throw new QualityCheckBindingError(checkId, "projection", error);
        }
        projected = validateProjection(
          projected,
          association.sourceKey,
          language,
          checkId,
        );
        if (projected.complete === false) {
          incomplete = true;
          if ((projected.issues?.length ?? 0) === 0)
            issues.push(
              issue(
                "referenceProjectionIncomplete",
                "保存参照投影仍有未提供的消息组。",
                { language, sourceKey: association.sourceKey },
              ),
            );
        }
        issues.push(
          ...withSource(
            projected.issues ?? [],
            association.sourceKey,
            language,
          ),
        );

        for (const group of projected.groups) {
          assertProjectedLanguage(group, language, checkId);
          const signed = await signGroup(
            group,
            analysis,
            sourceTemplate,
            targetTemplate,
            options.targetEquivalence,
            { sourceKey: association.sourceKey },
            memo,
          );
          issues.push(...signed.issues);
          if (signed.familyKey === "") {
            incomplete = true;
            continue;
          }
          if (
            signed.targetKey === undefined ||
            signed.targetSignatures === undefined
          ) {
            incomplete = true;
            incompleteFamilies.add(signed.familyKey);
            continue;
          }
          references.push({
            familyKey: signed.familyKey,
            targetKey: signed.targetKey,
            translationIndex,
            sourceKey: association.sourceKey,
            group,
            sourceSignatures: signed.sourceSignatures,
            targetSignatures: signed.targetSignatures,
            translationLocation: {
              language,
              range: translation.range,
              key: association.sourceKey,
            },
          });
        }
      }
    }

    const index = indexMessageFamilies(references);
    return { references, index, incomplete, incompleteFamilies, issues };
  }

  const memoKeyReferences = (
    facts: FrameworkFacts<TUnit, TTranslation, TBody, TUnavailable>,
    language: string,
    _memo: MemoScope,
  ): readonly unknown[] => [facts, language];
  function getReferences(
    memo: MemoScope,
    facts: FrameworkFacts<TUnit, TTranslation, TBody, TUnavailable>,
    language: string,
  ): Promise<ProjectedReferences> {
    const memoized = memo.memo(projectReferences, {
      key: memoKeyReferences,
    });
    return memoized(facts, language, memo);
  }

  return bindQualityCheck<
    TUnit,
    TTranslation,
    typeof configurationSchema,
    typeof inputSchema,
    TSubject,
    QualityObject,
    TBody,
    TUnavailable
  >({
    id: checkId,
    version: `checks.message-family-consistency/v1+${options.hostVersion}`,
    configurationSchema,
    configuration: { limits },
    inputSchema,
    select: options.select,
    project: async (
      input: QualityCheckProjectionInput<
        TUnit,
        TTranslation,
        Configuration,
        TSubject,
        TBody,
        TUnavailable
      >,
    ) => ({
      status: "ready",
      value:
        options.projectCandidate === undefined
          ? await options.project({
              kind: "candidate",
              subject: input.subject,
            })
          : await options.projectCandidate(input),
    }),
    check: async (
      input: QualityCheckRuleInput<
        TUnit,
        TTranslation,
        Configuration,
        TSubject,
        MessageFamilyInput,
        TBody,
        TUnavailable
      >,
    ): Promise<QualityCheckOutcome<QualityObject>> => {
      const object: QualityObject = {
        kind: "translation-unit",
        key: input.subject.sourceKey,
        language: input.subject.language,
      };
      const candidateLocation = translationLocation(
        input.facts,
        input.subject.sourceKey,
        input.subject.language,
        candidateRecordIndex(
          input.facts,
          input.subject.sourceKey,
          input.subject.language,
        ),
      );
      const candidateIssues: MessageFamilyIssue[] = withSource(
        input.projected.issues ?? [],
        input.subject.sourceKey,
        input.subject.language,
      );
      let incomplete = input.projected.complete === false;
      if (input.subject.sourceUnit.bodyAvailability !== "available") {
        incomplete = true;
        candidateIssues.push(
          issue("candidateSourceUnavailable", "候选对应的原文正文不可用。", {
            language: input.subject.language,
            sourceKey: input.subject.sourceKey,
          }),
        );
      }
      if (input.projected.complete === false && candidateIssues.length === 0)
        candidateIssues.push(
          issue(
            "candidateProjectionIncomplete",
            "候选投影仍有未提供的消息组。",
            {
              language: input.subject.language,
              sourceKey: input.subject.sourceKey,
            },
          ),
        );

      const association = findAssociation(
        input.facts,
        input.subject.sourceKey,
        input.subject.language,
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
              language: input.subject.language,
              sourceKey: input.subject.sourceKey,
            },
          ),
        );
      }

      const references = await getReferences(
        input.memo,
        input.facts,
        input.subject.language,
      );
      const initialCandidateIssueCount = candidateIssues.length;
      incomplete = incomplete || references.incomplete;
      const allIssues = [
        ...candidateIssues,
        ...withSource(references.issues, undefined, input.subject.language),
      ];
      const diagnostics: {
        readonly severity: "warning";
        readonly object: QualityObject;
        readonly location: QualityLocation;
        readonly message: string;
        readonly evidence: readonly QualityEvidence[];
      }[] = [];
      let comparable = false;

      for (const group of input.projected.groups) {
        assertProjectedLanguage(group, input.subject.language, checkId);
        const signed = await signGroup(
          group,
          analysis,
          sourceTemplate,
          targetTemplate,
          options.targetEquivalence,
          { sourceKey: input.subject.sourceKey },
          input.memo,
        );
        candidateIssues.push(...signed.issues);
        if (signed.familyKey === "") {
          incomplete = true;
          continue;
        }
        const familyIncomplete = references.incompleteFamilies.has(
          signed.familyKey,
        );
        if (familyIncomplete) incomplete = true;
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
                input.subject,
              ),
            );
          }
          continue;
        }

        if (comparison.status === "no-comparison") {
          if (!references.incomplete && !familyIncomplete) {
            allIssues.push(
              issue(
                "noComparableReference",
                "完整保存证据中没有与该消息族相同的参照。",
                {
                  language: input.subject.language,
                  sourceKey: input.subject.sourceKey,
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
              input.subject,
            ),
          );
      }

      allIssues.push(...candidateIssues.slice(initialCandidateIssueCount));
      if (input.projected.groups.length === 0 && !comparable) {
        allIssues.push(
          issue("noComparableReference", "候选投影没有提供可比较的消息组。", {
            language: input.subject.language,
            sourceKey: input.subject.sourceKey,
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

async function signGroup(
  group: MessageFamilyGroup,
  analysis: TextAnalysis,
  sourceTemplate: TemplateOptions,
  targetTemplate: TemplateOptions,
  targetEquivalence: ((signature: TemplateSignature) => string) | undefined,
  context: { readonly sourceKey?: string },
  memo: MemoScope,
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
    const key = targetEquivalence?.(signature) ?? signatureKey(signature);
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
      signatures: signed.targetSignatures?.map(sanitizeSignature) ?? null,
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
          translationIndex: reference.translationIndex,
          sourceKey: reference.sourceKey,
          groupRef: reference.group.ref,
          scope: reference.group.scope,
          source: reference.group.source,
          target: reference.group.target,
          sourceSignatures: reference.sourceSignatures.map(sanitizeSignature),
          targetSignatures: reference.targetSignatures.map(sanitizeSignature),
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

function sanitizeSignature(signature: TemplateSignature): unknown {
  return {
    parts: signature.parts,
    slots: signature.slots.map(({ start, end, kind, identity, raw }) => ({
      start,
      end,
      kind,
      identity,
      raw,
    })),
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
    throw new QualityCheckBindingError(
      checkId,
      "projection",
      new StandardSchemaContractError(
        `消息族投影 ${sourceKey}/${language}`,
        "schema-mismatch",
        result.issues.map(({ message }) => message).join("；"),
        result.issues,
      ),
    );
  return result.value;
}

function isMessageFamilyInput(value: unknown): value is MessageFamilyInput {
  if (!isRecord(value) || !Array.isArray(value.groups)) return false;
  if (value.complete !== undefined && typeof value.complete !== "boolean")
    return false;
  if (value.issues !== undefined && !isIssues(value.issues)) return false;
  return value.groups.every(isGroup);
}

function isGroup(value: unknown): value is MessageFamilyGroup {
  return (
    isRecord(value) &&
    isJsonValue(value.ref) &&
    typeof value.scope === "string" &&
    value.scope.length > 0 &&
    isMessageText(value.source) &&
    isMessageText(value.target)
  );
}

function isMessageText(value: unknown): value is MessageFamilyGroup["source"] {
  return (
    isRecord(value) &&
    typeof value.language === "string" &&
    value.language.length > 0 &&
    Array.isArray(value.fragments) &&
    (value.complete === undefined || typeof value.complete === "boolean") &&
    (value.issues === undefined || isIssues(value.issues)) &&
    value.fragments.every(isFragment)
  );
}

function isFragment(value: unknown): value is MessageFragment {
  return (
    isRecord(value) &&
    isJsonValue(value.ref) &&
    typeof value.text === "string" &&
    (value.protectedRanges === undefined ||
      (Array.isArray(value.protectedRanges) &&
        value.protectedRanges.every((range) =>
          isTextRange(value.text as string, range),
        )))
  );
}

function isIssues(value: unknown): value is readonly MessageFamilyIssue[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        isRecord(item) &&
        typeof item.code === "string" &&
        item.code.length > 0 &&
        typeof item.message === "string" &&
        (item.language === undefined || typeof item.language === "string") &&
        (item.sourceKey === undefined || typeof item.sourceKey === "string") &&
        (item.ref === undefined || isJsonValue(item.ref)) &&
        (item.range === undefined || isRange(item.range)),
    )
  );
}

function isRange(value: unknown): value is TextRange {
  return (
    isRecord(value) &&
    Number.isInteger(value.start) &&
    Number.isInteger(value.end) &&
    (value.start as number) >= 0 &&
    (value.end as number) >= (value.start as number)
  );
}

function isTextRange(text: string, value: unknown): value is TextRange {
  if (!isRange(value) || value.end > text.length) return false;
  return (
    isCodePointBoundary(text, value.start) &&
    isCodePointBoundary(text, value.end)
  );
}

function isCodePointBoundary(text: string, index: number): boolean {
  if (index === 0 || index === text.length) return true;
  const before = text.charCodeAt(index - 1);
  const after = text.charCodeAt(index);
  return !(
    before >= 0xd800 &&
    before <= 0xdbff &&
    after >= 0xdc00 &&
    after <= 0xdfff
  );
}

function isJsonValue(
  value: unknown,
  active: Set<object> = new Set(),
): value is import("@lioni/core").JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" &&
      Number.isFinite(value) &&
      !Object.is(value, -0))
  )
    return true;
  if (typeof value !== "object" || active.has(value)) return false;
  active.add(value);
  try {
    if (Array.isArray(value)) {
      if (
        Object.getPrototypeOf(value) !== Array.prototype ||
        Reflect.ownKeys(value).some(
          (key) =>
            key !== "length" &&
            (typeof key !== "string" || !/^0$|^[1-9][0-9]*$/u.test(key)),
        )
      )
        return false;
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index) || !isJsonValue(value[index], active))
          return false;
      }
      return true;
    }
    if (
      !isRecord(value) ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      Reflect.ownKeys(value).some((key) => typeof key !== "string")
    )
      return false;
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !Object.hasOwn(descriptor, "value") ||
        !isJsonValue(descriptor.value, active)
      )
        return false;
    }
    return true;
  } finally {
    active.delete(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}
