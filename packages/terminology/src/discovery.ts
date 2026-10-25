import {
  normalizeText,
  type TextAnalysis,
  type WordToken,
} from "@lioni/text-analysis";

import {
  contractIssue,
  copyJson,
  isRecord,
  TermContractError,
  type JsonValue,
} from "./data.ts";
import {
  splitsSurrogatePair,
  validateTextInput,
  type TermFragment,
  type TermRange,
} from "./input.ts";
import { basicTermTextAnalysis, type TermRuntime } from "./matching.ts";

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

export type TermCandidateRanking = {
  readonly method: string;
  readonly maxWordCount: number;
  readonly score: number;
};

export type TermCandidate = {
  readonly text: string;
  readonly language: string;
  readonly occurrences: number;
  /** 覆盖的输入条目位置数，不根据文字或不透明引用隐式合并条目。 */
  readonly entryCount: number;
  readonly examples: readonly TermCandidateOccurrence[];
  readonly examplesTruncated: boolean;
  readonly ranking: TermCandidateRanking;
};

export type TermCandidateGenerationInput = {
  readonly language: string;
  readonly text: string;
  readonly words: readonly WordToken[];
  readonly protectedRanges: readonly TermRange[];
  readonly maxWords: number;
  readonly maxCharacters: number;
};

export type TermCandidateGenerator = (
  input: TermCandidateGenerationInput,
) => readonly TermRange[];

export type TermCandidateRankResult = {
  readonly method: string;
  readonly score: number;
};

export type TermCandidateRanker = (
  candidate: TermCandidate,
) => TermCandidateRankResult;

export type TermDiscoveryIssue = {
  readonly code: string;
  readonly message: string;
  readonly entryIndex?: number;
  readonly fragmentIndex?: number;
  readonly range?: TermRange;
};

export type DiscoverTermsOptions = TermRuntime & {
  readonly maxWords?: number;
  readonly maxCharacters?: number;
  readonly minOccurrences?: number;
  readonly limit?: number;
  readonly maxExamples?: number;
  readonly analysis?: TextAnalysis;
  readonly candidateGenerator?: TermCandidateGenerator;
  readonly candidateRanker?: TermCandidateRanker;
  readonly include?: (candidate: TermCandidate) => boolean;
};

export type TermDiscovery = {
  readonly status: "complete" | "incomplete";
  readonly candidates: readonly TermCandidate[];
  readonly issues: readonly TermDiscoveryIssue[];
  readonly statistics: {
    readonly entries: number;
    readonly distinctCandidates: number;
    readonly eligibleCandidates: number;
    readonly omittedCandidates: number;
  };
};

function intersects(left: TermRange, right: TermRange): boolean {
  return left.start < right.end && right.start < left.end;
}

function defaultCandidateRanges(
  input: TermCandidateGenerationInput,
): readonly TermRange[] {
  const ranges: TermRange[] = [];
  for (let start = 0; start < input.words.length; start += 1) {
    for (
      let end = start;
      end < Math.min(input.words.length, start + input.maxWords);
      end += 1
    ) {
      const first = input.words[start]!;
      const last = input.words[end]!;
      if (
        end > start &&
        !/^\s*$/u.test(input.text.slice(input.words[end - 1]!.end, last.start))
      )
        break;
      const range = { start: first.start, end: last.end };
      if (
        input.protectedRanges.some((protectedRange) =>
          intersects(range, protectedRange),
        )
      )
        break;
      if (
        Array.from(input.text.slice(range.start, range.end)).length >
        input.maxCharacters
      )
        break;
      ranges.push(Object.freeze(range));
    }
  }
  return Object.freeze(ranges);
}

/** 有界相邻词组基线；排名只表示审阅顺序，不证明候选是术语。 */
export async function discoverTerms(
  corpus: TermDiscoveryCorpus,
  options: DiscoverTermsOptions = {},
): Promise<TermDiscovery> {
  const snapshot = copyJson(corpus, "input");
  if (
    !isRecord(snapshot) ||
    !Array.isArray(snapshot.entries) ||
    typeof snapshot.language !== "string" ||
    !snapshot.language.trim() ||
    (snapshot.complete !== undefined && typeof snapshot.complete !== "boolean")
  )
    throw new TermContractError("input", [
      contractIssue(
        "invalid-corpus",
        "发现语料需要语言、条目数组及明确的完整性。",
      ),
    ]);
  const input = snapshot as unknown as TermDiscoveryCorpus;
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
  const issues: TermDiscoveryIssue[] = [];
  const issueKeys = new Set<string>();
  const addIssue = (issue: TermDiscoveryIssue) => {
    const key = JSON.stringify([
      issue.entryIndex,
      issue.fragmentIndex,
      issue.code,
      issue.message,
      issue.range?.start,
      issue.range?.end,
    ]);
    if (issueKeys.has(key)) return;
    issueKeys.add(key);
    issues.push(
      Object.freeze({
        ...issue,
        ...(issue.range === undefined
          ? {}
          : { range: Object.freeze({ ...issue.range }) }),
      }),
    );
  };
  if (input.complete === false)
    addIssue({
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
  for (const [entryIndex, entry] of input.entries.entries()) {
    if (
      entry === null ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      !Object.hasOwn(entry, "ref")
    )
      throw new TermContractError("input", [
        contractIssue("invalid-corpus-entry", "语料条目必须包含 ref。", [
          "entries",
          entryIndex,
        ]),
      ]);
    validateTextInput({
      language: input.language,
      fragments: entry.fragments,
    });
    for (const [fragmentIndex, fragment] of entry.fragments.entries()) {
      const textInput = {
        text: fragment.text,
        language: input.language,
        ...(fragment.protectedRanges === undefined
          ? {}
          : { protectedRanges: fragment.protectedRanges }),
      };
      const structure = await textAnalysis.structures(textInput, options);
      const analysis = await textAnalysis.words(textInput, options);
      for (const issue of structure.issues)
        addIssue({ ...issue, entryIndex, fragmentIndex });
      if (!structure.complete && structure.issues.length === 0)
        addIssue({
          code: "incomplete-structure",
          message: "结构分析未完整处理该片段。",
          entryIndex,
          fragmentIndex,
        });
      for (const issue of analysis.issues)
        addIssue({ ...issue, entryIndex, fragmentIndex });
      if (!analysis.complete) {
        if (structure.complete && analysis.issues.length === 0)
          addIssue({
            code: "incomplete-segmentation",
            message: "分词能力未完整处理该片段。",
            entryIndex,
            fragmentIndex,
          });
      }
      const words = Object.freeze(
        analysis.words.map((word) => Object.freeze({ ...word })),
      );
      let previousEnd = 0;
      for (const word of words) {
        if (
          !Number.isInteger(word.start) ||
          !Number.isInteger(word.end) ||
          word.start < previousEnd ||
          word.end <= word.start ||
          word.end > fragment.text.length ||
          splitsSurrogatePair(fragment.text, word.start) ||
          splitsSurrogatePair(fragment.text, word.end) ||
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
      const protectedRanges = Object.freeze(
        structure.protectedRanges.map((range) => Object.freeze({ ...range })),
      );
      const generationInput: TermCandidateGenerationInput = Object.freeze({
        language: input.language,
        text: fragment.text,
        words,
        protectedRanges,
        maxWords,
        maxCharacters,
      });
      const generatedRanges =
        options.candidateGenerator === undefined
          ? defaultCandidateRanges(generationInput)
          : options.candidateGenerator(generationInput);
      if (!Array.isArray(generatedRanges))
        throw new TermContractError("input", [
          contractIssue(
            "invalid-candidate-generation",
            "候选生成政策必须返回区间数组。",
            ["entries", entryIndex, "fragments", fragmentIndex],
          ),
        ]);
      const wordStarts = new Map(
        words.map((word, index) => [word.start, index]),
      );
      const wordEnds = new Map(words.map((word, index) => [word.end, index]));
      const seenRanges = new Set<string>();
      for (const [rangeIndex, candidateRange] of generatedRanges.entries()) {
        if (
          !isRecord(candidateRange) ||
          typeof candidateRange.start !== "number" ||
          typeof candidateRange.end !== "number" ||
          !Number.isInteger(candidateRange.start) ||
          !Number.isInteger(candidateRange.end) ||
          candidateRange.start < 0 ||
          candidateRange.end <= candidateRange.start ||
          candidateRange.end > fragment.text.length ||
          splitsSurrogatePair(fragment.text, candidateRange.start) ||
          splitsSurrogatePair(fragment.text, candidateRange.end)
        )
          throw new TermContractError("input", [
            contractIssue(
              "invalid-candidate-range",
              "候选政策必须返回正文内不切开代理对的非空区间。",
              [
                "entries",
                entryIndex,
                "fragments",
                fragmentIndex,
                "candidates",
                rangeIndex,
              ],
            ),
          ]);
        const range = {
          start: candidateRange.start,
          end: candidateRange.end,
        };
        const firstWord = wordStarts.get(range.start);
        const lastWord = wordEnds.get(range.end);
        if (
          firstWord === undefined ||
          lastWord === undefined ||
          lastWord < firstWord
        )
          throw new TermContractError("input", [
            contractIssue(
              "unaligned-candidate-range",
              "候选区间必须与完整词项边界对齐。",
              [
                "entries",
                entryIndex,
                "fragments",
                fragmentIndex,
                "candidates",
                rangeIndex,
              ],
            ),
          ]);
        const wordCount = lastWord - firstWord + 1;
        if (wordCount > maxWords) continue;
        if (
          protectedRanges.some((protectedRange) =>
            intersects(range, protectedRange),
          )
        )
          continue;
        const text = fragment.text.slice(range.start, range.end);
        if (Array.from(text).length > maxCharacters) continue;
        if (!/[\p{L}\p{M}]/u.test(text)) continue;
        const rangeKey = `${range.start}:${range.end}`;
        if (seenRanges.has(rangeKey))
          throw new TermContractError("input", [
            contractIssue(
              "duplicate-candidate-range",
              "候选政策不能重复返回同一原文区间。",
              [
                "entries",
                entryIndex,
                "fragments",
                fragmentIndex,
                "candidates",
                rangeIndex,
              ],
            ),
          ]);
        seenRanges.add(rangeKey);
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
        record.maxWordCount = Math.max(record.maxWordCount, wordCount);
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
  const candidates = [...accumulated].flatMap(
    ([text, record]): TermCandidate[] => {
      if (record.count < minOccurrences) return [];
      const draft: TermCandidate = Object.freeze({
        text,
        language: input.language,
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
      const ranking =
        options.candidateRanker === undefined
          ? draft.ranking
          : options.candidateRanker(draft);
      if (
        !isRecord(ranking) ||
        typeof ranking.method !== "string" ||
        !ranking.method.trim() ||
        !Number.isFinite(ranking.score)
      )
        throw new TermContractError("input", [
          contractIssue(
            "invalid-candidate-ranking",
            "候选排序政策必须返回非空方法名称和有限分值。",
            ["candidates", text],
          ),
        ]);
      const candidate: TermCandidate = Object.freeze({
        ...draft,
        ranking: Object.freeze({
          method: ranking.method,
          maxWordCount: record.maxWordCount,
          score: ranking.score,
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
      entries: input.entries.length,
      distinctCandidates: accumulated.size,
      eligibleCandidates: candidates.length,
      omittedCandidates: Math.max(0, candidates.length - limit),
    }),
  });
}
