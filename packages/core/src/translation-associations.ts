import type {
  ComparisonSnapshot,
  TranslationAssociation,
  TranslationUnitInput,
} from "./index.ts";
import { readStatus } from "./read-coverage.ts";

/** 当前读取与历史快照共用消息键关联；范围只决定读取依据，不排除已知的同键译文。 */
export function associateSnapshot<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  snapshot: ComparisonSnapshot<TUnit, TTranslation, TBody, TUnavailable>,
): TranslationAssociation[] {
  const associations: TranslationAssociation[] = [];
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
        .filter(({ language }) => language === languageRead.language)
        .filter(({ identity }) => identity.key === sourceUnit.key)
        .map(({ index }) => index);
      const status =
        translationIndexes.length === 0
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
