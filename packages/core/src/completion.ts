import type {
  ActualTranslationFact,
  Awaitable,
  BodyAvailability,
  CoverageStatus,
  FrameworkFacts,
  SourceReadFact,
  SourceUnitFact,
  TranslationAssociationFact,
  TranslationAssociationStatus,
  TranslationUnitInput,
} from "./index.ts";

export type CompletionResolution =
  | boolean
  | { readonly status: "unknown"; readonly reason: string };

export type CompletionResolverInput<
  TUnit extends TranslationUnitInput,
  TTranslation,
> = {
  readonly factsVersion: string;
  readonly obligation: {
    readonly sourceKey: string;
    readonly language: string;
  };
  readonly sourceUnit: SourceUnitFact<TUnit>;
  readonly association: TranslationAssociationFact;
  readonly translations: readonly ActualTranslationFact<TTranslation>[];
};

export type ResolveCompletion<
  TUnit extends TranslationUnitInput,
  TTranslation,
> = (
  input: CompletionResolverInput<TUnit, TTranslation>,
) => Awaitable<CompletionResolution>;

export type CompletionPolicy<
  TUnit extends TranslationUnitInput,
  TTranslation,
> = {
  readonly criterion: string;
  readonly resolveCompletion: ResolveCompletion<TUnit, TTranslation>;
};

export type CompletionStatus = "complete" | "incomplete" | "unknown";

export type CompletionObligationFact = {
  readonly sourceKey: string;
  readonly language: string;
  readonly status: CompletionStatus;
  readonly associationStatus: TranslationAssociationStatus;
  readonly coverageStatus: CoverageStatus;
  readonly sourceBodyAvailability: BodyAvailability;
  readonly translationIndexes: readonly number[];
  readonly reason?: string;
};

export type CompletionReport = {
  readonly factsVersion: string;
  readonly criterion: string;
  readonly status: CompletionStatus;
  readonly scope: {
    readonly sourceReadStatus: SourceReadFact["status"];
    readonly sourceUnitCount: number | null;
    readonly knownSourceUnitCount: number;
    readonly targetLanguages: readonly string[];
    readonly obligationCount: number | null;
    readonly knownObligationCount: number;
    readonly unknownTotalReason?: string;
  };
  readonly confirmedCompleteCount: number;
  readonly confirmedIncompleteCount: number;
  readonly unknownCount: number;
  readonly completionRate: number | null;
  readonly obligations: readonly CompletionObligationFact[];
};

export type CompletionFacts<
  TUnit extends TranslationUnitInput,
  TTranslation,
> = FrameworkFacts<TUnit, TTranslation> & {
  readonly completion: CompletionReport;
};

export type CompletionConfigurationErrorReason =
  | "missingPolicy"
  | "missingTranslations";

export class CompletionConfigurationError extends Error {
  readonly reason: CompletionConfigurationErrorReason;

  constructor(reason: CompletionConfigurationErrorReason) {
    super(
      reason === "missingPolicy"
        ? "完成计算需要宿主配置 completion.resolveCompletion 判据。"
        : "完成计算需要宿主显式配置目标语言 translations。",
    );
    this.name = "CompletionConfigurationError";
    this.reason = reason;
  }
}

export async function evaluateCompletion<
  TUnit extends TranslationUnitInput,
  TTranslation,
>(
  facts: FrameworkFacts<TUnit, TTranslation>,
  policy: CompletionPolicy<TUnit, TTranslation>,
): Promise<CompletionReport> {
  const sourceUnits = new Map(
    facts.source.units.map((sourceUnit) => [sourceUnit.key, sourceUnit]),
  );
  const obligations: CompletionObligationFact[] = [];

  for (const association of facts.associations) {
    const sourceUnit = sourceUnits.get(association.sourceKey);
    if (sourceUnit === undefined)
      throw new TypeError(`完成关联引用不存在的原文：${association.sourceKey}`);

    const translations: ActualTranslationFact<TTranslation>[] = [];
    let missingTranslationReference = false;
    for (const index of association.translationIndexes) {
      const translation = facts.translations.records[index];
      if (translation === undefined) {
        missingTranslationReference = true;
      } else {
        translations.push(translation);
      }
    }

    const base = {
      sourceKey: association.sourceKey,
      language: association.language,
      associationStatus: association.status,
      coverageStatus: association.coverageStatus,
      sourceBodyAvailability: sourceUnit.bodyAvailability,
      translationIndexes: [...association.translationIndexes],
    };
    if (missingTranslationReference) {
      obligations.push({
        ...base,
        status: "unknown",
        reason: "源译关联引用的实际译文记录不存在。",
      });
      continue;
    }

    if (association.status === "unknown" || association.status === "conflict") {
      obligations.push({
        ...base,
        status: "unknown",
        reason: associationUnknownReason(association),
      });
      continue;
    }

    const resolution = await policy.resolveCompletion({
      factsVersion: facts.version,
      obligation: {
        sourceKey: association.sourceKey,
        language: association.language,
      },
      sourceUnit,
      association,
      translations,
    });
    if (typeof resolution === "boolean") {
      obligations.push({
        ...base,
        status: resolution ? "complete" : "incomplete",
      });
    } else {
      obligations.push({
        ...base,
        status: "unknown",
        reason: resolution.reason,
      });
    }
  }

  const confirmedCompleteCount = obligations.filter(
    ({ status }) => status === "complete",
  ).length;
  const confirmedIncompleteCount = obligations.filter(
    ({ status }) => status === "incomplete",
  ).length;
  const unknownCount = obligations.filter(
    ({ status }) => status === "unknown",
  ).length;
  const targetLanguages = facts.translations.reads.map(
    ({ language }) => language,
  );
  const sourceUnitCount = facts.source.totalUnitCount;
  const obligationCount =
    sourceUnitCount === null ? null : sourceUnitCount * targetLanguages.length;
  const knownSourceUnitCount = facts.source.units.length;
  const knownObligationCount = obligations.length;
  const unknownTotalReason =
    sourceUnitCount === null
      ? sourceCountUnknownReason(facts.source.read.status)
      : undefined;
  const status: CompletionStatus =
    confirmedIncompleteCount > 0
      ? "incomplete"
      : obligationCount !== null &&
          unknownCount === 0 &&
          confirmedCompleteCount === obligationCount
        ? "complete"
        : "unknown";
  const completionRate =
    obligationCount !== null && obligationCount > 0 && unknownCount === 0
      ? confirmedCompleteCount / obligationCount
      : null;

  return {
    factsVersion: facts.version,
    criterion: policy.criterion,
    status,
    scope: {
      sourceReadStatus: facts.source.read.status,
      sourceUnitCount,
      knownSourceUnitCount,
      targetLanguages,
      obligationCount,
      knownObligationCount,
      ...(unknownTotalReason === undefined ? {} : { unknownTotalReason }),
    },
    confirmedCompleteCount,
    confirmedIncompleteCount,
    unknownCount,
    completionRate,
    obligations,
  };
}

function associationUnknownReason(
  association: TranslationAssociationFact,
): string {
  if (association.status === "conflict")
    return "同一义务匹配到多条实际译文，完成对象不唯一。";

  switch (association.coverageStatus) {
    case "notRead":
      return "相关目标语言范围尚未读取。";
    case "incomplete":
      return "相关目标语言范围未完整枚举，无法确认唯一匹配。";
    case "failed":
      return "相关目标语言范围读取失败。";
    case "complete":
      return "源译关联状态不足以判断完成情况。";
  }
}

function sourceCountUnknownReason(status: SourceReadFact["status"]): string {
  switch (status) {
    case "notRead":
      return "原文范围尚未读取，原文总数未知。";
    case "incomplete":
      return "原文范围未完整枚举，原文总数未知。";
    case "failed":
      return "原文范围读取失败，原文总数未知。";
    case "complete":
      return "原文总数未能确定。";
  }
}
