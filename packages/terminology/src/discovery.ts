import { normalizeText, type TextAnalysis } from "@lioni/text-analysis";

import {
  contractIssue,
  copyJson,
  TermContractError,
  type JsonValue,
} from "./data.ts";
import {
  validateTextInput,
  type TermFragment,
  type TermRange,
} from "./input.ts";
import {
  basicTermTextAnalysis,
  type TermAnalysisIssue,
  type TermRuntime,
} from "./matching.ts";

export type TermCorpusEntry = {
  readonly ref: JsonValue;
  readonly fragments: readonly TermFragment[];
};

export type TermDiscoveryCorpus = {
  readonly language: string;
  readonly entries: readonly TermCorpusEntry[];
  readonly complete?: boolean;
};

export type TermCandidateOccurrence = {
  readonly entryIndex: number;
  readonly entryRef: JsonValue;
  readonly fragmentIndex: number;
  readonly ref: JsonValue;
  readonly range: TermRange;
  readonly text: string;
  readonly context: string;
};

export type TermCandidate = {
  readonly text: string;
  readonly language: string;
  readonly occurrences: number;
  /** 覆盖的输入条目位置数，不根据文字或不透明引用隐式合并条目。 */
  readonly entryCount: number;
  readonly examples: readonly TermCandidateOccurrence[];
  readonly examplesTruncated: boolean;
  readonly ranking: {
    readonly method: "frequency-times-word-count";
    readonly maxWordCount: number;
    readonly score: number;
  };
};

export type DiscoverTermsOptions = TermRuntime & {
  readonly maxWords?: number;
  readonly maxCharacters?: number;
  readonly minOccurrences?: number;
  readonly limit?: number;
  readonly maxExamples?: number;
  readonly analysis?: TextAnalysis;
  readonly include?: (candidate: TermCandidate) => boolean;
};

export type TermDiscovery = {
  readonly status: "complete" | "incomplete";
  readonly candidates: readonly TermCandidate[];
  readonly issues: readonly (TermAnalysisIssue & {
    readonly entryIndex?: number;
  })[];
  readonly statistics: {
    readonly entries: number;
    readonly distinctCandidates: number;
    readonly eligibleCandidates: number;
    readonly omittedCandidates: number;
  };
};

/** 有界相邻词组基线；排名只表示审阅顺序，不证明候选是术语。 */
export async function discoverTerms(
  corpus: TermDiscoveryCorpus,
  options: DiscoverTermsOptions = {},
): Promise<TermDiscovery> {
  copyJson(corpus, "input");
  if (
    !Array.isArray(corpus.entries) ||
    typeof corpus.language !== "string" ||
    !corpus.language.trim() ||
    (corpus.complete !== undefined && typeof corpus.complete !== "boolean")
  )
    throw new TermContractError("input", [
      contractIssue(
        "invalid-corpus",
        "发现语料需要语言、条目数组及明确的完整性。",
      ),
    ]);
  const maxWords = options.maxWords ?? 3;
  const maxCharacters = options.maxCharacters ?? 80;
  const minOccurrences = options.minOccurrences ?? 1;
  const limit = options.limit ?? 100;
  const maxExamples = options.maxExamples ?? 3;
  for (const [name, value] of Object.entries({
    maxWords,
    maxCharacters,
    minOccurrences,
    limit,
    maxExamples,
  }))
    if (
      !Number.isInteger(value) ||
      value < (name === "limit" ? 0 : 1) ||
      (name === "maxWords" && value > 8)
    )
      throw new TermContractError("input", [
        contractIssue(
          "invalid-discovery-options",
          "候选参数必须为有效整数，词组长度最多为 8 个词。",
          [name],
        ),
      ]);
  const issues: (TermAnalysisIssue & { entryIndex?: number })[] = [];
  if (corpus.complete === false)
    issues.push({
      code: "incomplete-corpus",
      message: "输入语料范围不完整，统计仅覆盖实际提供的条目。",
    });
  const accumulated = new Map<
    string,
    {
      count: number;
      entries: Set<number>;
      examples: TermCandidateOccurrence[];
      maxWordCount: number;
    }
  >();
  const textAnalysis = options.analysis ?? basicTermTextAnalysis;
  for (const [entryIndex, entry] of corpus.entries.entries()) {
    if (
      entry === null ||
      typeof entry !== "object" ||
      !Object.hasOwn(entry, "ref")
    )
      throw new TermContractError("input", [
        contractIssue("invalid-corpus-entry", "语料条目必须包含 ref。", [
          "entries",
          entryIndex,
        ]),
      ]);
    validateTextInput({
      language: corpus.language,
      fragments: entry.fragments,
    });
    for (const [fragmentIndex, fragment] of entry.fragments.entries()) {
      const textInput = {
        text: fragment.text,
        language: corpus.language,
        ...(fragment.protectedRanges === undefined
          ? {}
          : { protectedRanges: fragment.protectedRanges }),
      };
      const structure = await textAnalysis.structures(textInput, options);
      const analysis = await textAnalysis.words(textInput, options);
      if (!analysis.complete) {
        issues.push(
          ...analysis.issues.map((issue) => ({
            code: issue.code,
            message: issue.message,
            entryIndex,
            fragmentIndex,
          })),
        );
        if (!analysis.issues.length)
          issues.push({
            code: "incomplete-segmentation",
            message: "分词能力未完整处理该片段。",
            entryIndex,
            fragmentIndex,
          });
      }
      const words = analysis.words;
      let previousEnd = 0;
      for (const word of words) {
        if (
          !Number.isInteger(word.start) ||
          !Number.isInteger(word.end) ||
          word.start < previousEnd ||
          word.end <= word.start ||
          word.end > fragment.text.length ||
          fragment.text.slice(word.start, word.end) !== word.text
        )
          throw new TermContractError("input", [
            contractIssue(
              "invalid-word-analysis",
              "分词结果必须按序返回精确的原文区间。",
              ["entries", entryIndex, "fragments", fragmentIndex],
            ),
          ]);
        previousEnd = word.end;
      }
      for (let start = 0; start < words.length; start += 1) {
        for (
          let end = start;
          end < Math.min(words.length, start + maxWords);
          end += 1
        ) {
          const first = words[start]!;
          const last = words[end]!;
          if (
            end > start &&
            !/^\s*$/u.test(fragment.text.slice(words[end - 1]!.end, last.start))
          )
            break;
          const range = { start: first.start, end: last.end };
          if (
            structure.protectedRanges.some(
              (protectedRange) =>
                range.start < protectedRange.end &&
                protectedRange.start < range.end,
            )
          )
            break;
          const text = fragment.text.slice(range.start, range.end);
          if ([...text].length > maxCharacters) break;
          if (!/[\p{L}\p{M}]/u.test(text)) continue;
          const normalized = options.memo
            ? options.memo.memo(normalizeText)(text)
            : normalizeText(text);
          const key = normalized.text;
          let record = accumulated.get(key);
          if (!record) {
            record = {
              count: 0,
              entries: new Set(),
              examples: [],
              maxWordCount: 0,
            };
            accumulated.set(key, record);
          }
          record.count += 1;
          record.entries.add(entryIndex);
          record.maxWordCount = Math.max(record.maxWordCount, end - start + 1);
          if (record.examples.length < maxExamples)
            record.examples.push(
              Object.freeze({
                entryIndex,
                entryRef: entry.ref,
                fragmentIndex,
                ref: fragment.ref,
                range: Object.freeze(range),
                text,
                context: fragment.text,
              }),
            );
        }
      }
    }
  }
  const candidates = [...accumulated].flatMap(
    ([text, record]): TermCandidate[] => {
      if (record.count < minOccurrences) return [];
      const candidate: TermCandidate = Object.freeze({
        text,
        language: corpus.language,
        occurrences: record.count,
        entryCount: record.entries.size,
        examples: Object.freeze(record.examples),
        examplesTruncated: record.count > record.examples.length,
        ranking: Object.freeze({
          method: "frequency-times-word-count",
          maxWordCount: record.maxWordCount,
          score: record.count * record.maxWordCount,
        }),
      });
      return options.include && !options.include(candidate) ? [] : [candidate];
    },
  );
  candidates.sort(
    (left, right) =>
      right.ranking.score - left.ranking.score ||
      right.entryCount - left.entryCount ||
      (left.text < right.text ? -1 : left.text > right.text ? 1 : 0),
  );
  return Object.freeze({
    status: issues.length ? "incomplete" : "complete",
    candidates: Object.freeze(candidates.slice(0, limit)),
    issues: Object.freeze(issues),
    statistics: Object.freeze({
      entries: corpus.entries.length,
      distinctCandidates: accumulated.size,
      eligibleCandidates: candidates.length,
      omittedCandidates: Math.max(0, candidates.length - limit),
    }),
  });
}
