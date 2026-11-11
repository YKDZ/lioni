import type { FrameworkFacts, TranslationUnitInput } from "../index.ts";
import type { SemanticEditCandidate } from "../semantic-edits.ts";

/** 验证单次 QA 候选都对应本次固定事实中的原文、语言与唯一身份。 */
export function validateQualityCandidateScope<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  facts: FrameworkFacts<TUnit, TTranslation, TBody, TUnavailable>,
  candidates: readonly SemanticEditCandidate<TBody>[],
): void {
  const sourceKeys = new Set(facts.source.units.map(({ key }) => key));
  const languages = new Set(
    facts.translations.reads.map(({ language }) => language),
  );
  const candidatesBySource = new Map<string, Set<string>>();

  for (const candidate of candidates) {
    if (
      typeof candidate?.sourceKey !== "string" ||
      typeof candidate.language !== "string"
    )
      throw new TypeError("译文候选必须包含字符串 sourceKey 与 language。");
    if (!sourceKeys.has(candidate.sourceKey))
      throw new TypeError(
        `译文候选原文键 ${JSON.stringify(candidate.sourceKey)} 不存在于本次已读取的原文中。`,
      );
    if (!languages.has(candidate.language))
      throw new TypeError(
        `译文候选语言 ${JSON.stringify(candidate.language)} 不在本次执行范围内。`,
      );

    let candidateLanguages = candidatesBySource.get(candidate.sourceKey);
    if (candidateLanguages === undefined) {
      candidateLanguages = new Set();
      candidatesBySource.set(candidate.sourceKey, candidateLanguages);
    }
    if (candidateLanguages.has(candidate.language))
      throw new TypeError(
        `译文候选身份 ${JSON.stringify({ sourceKey: candidate.sourceKey, language: candidate.language })} 重复。`,
      );
    candidateLanguages.add(candidate.language);
  }
}
