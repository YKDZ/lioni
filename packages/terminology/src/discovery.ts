import {
  normalizeText,
  type TextAnalysis,
  type WordToken,
} from "@lioni/text-analysis";
import { z } from "zod";

import {
  contractIssue,
  copyJson,
  contractIssues,
  jsonValueSchema,
  nonemptyTextSchema,
  TermContractError,
  type JsonValue,
} from "./data.ts";
import { createDefaultCandidateGenerator } from "./discovery-generation.ts";
import {
  termFragmentSchema,
  termRangeSchema,
  validTermRange,
  type TermRange,
  type TermFragment,
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

const corpusEntrySchema = z.object({
  ref: jsonValueSchema,
  fragments: z.array(termFragmentSchema),
});
export const discoveryCorpusSchema = z.compile(
  z.object({
    language: nonemptyTextSchema,
    entries: z.array(corpusEntrySchema),
    complete: z.boolean().exactOptional(),
  }),
) satisfies z.ZodType<TermDiscoveryCorpus>;
export const discoveryParametersSchema = z.compile(
  z.object({
    maxWords: z.int().min(1).max(8).default(3),
    maxCharacters: z.int().positive().default(80),
    minOccurrences: z.int().positive().default(1),
    limit: z.int().nonnegative().default(100),
    maxExamples: z.int().positive().default(3),
  }),
);
const candidateRangesSchema = z.compile(z.array(termRangeSchema));
const candidateRankSchema = z.compile(
  z.object({
    method: nonemptyTextSchema,
    score: z.number(),
  }),
);

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
  /** 替换默认词组生成，包括语言相关的首尾过滤；词界与预算验证仍由发现入口执行。 */
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

export function discoverySnapshot(value: unknown): TermDiscoveryCorpus {
  const snapshot = copyJson(value, "input");
  if (!discoveryCorpusSchema.validate(snapshot))
    throw new TermContractError(
      "input",
      contractIssues(discoveryCorpusSchema.safeParse(snapshot).error!),
    );
  return snapshot as unknown as TermDiscoveryCorpus;
}

function intersects(left: TermRange, right: TermRange): boolean {
  return left.start < right.end && right.start < left.end;
}

/**
 * 有界词组发现，默认允许词间连接符并按语言过滤功能词首尾。
 * 低频候选仍由 minOccurrences 决定，排名只表示审阅顺序，不证明候选是术语。
 */
export async function discoverTerms(
  corpus: TermDiscoveryCorpus,
  options: DiscoverTermsOptions = {},
): Promise<TermDiscovery> {
  const input = discoverySnapshot(corpus);
  const parameters = discoveryParametersSchema.safeParse(options);
  if (!parameters.success)
    throw new TermContractError("input", contractIssues(parameters.error));
  const { maxWords, maxCharacters, minOccurrences, limit, maxExamples } =
    parameters.data;
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
  const generateCandidates =
    options.candidateGenerator ??
    createDefaultCandidateGenerator(input.language);
  for (const [entryIndex, entry] of input.entries.entries()) {
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
      if (!candidateRangesSchema.validate(analysis.words))
        throw new TermContractError(
          "input",
          contractIssues(
            candidateRangesSchema.safeParse(analysis.words).error!,
          ),
        );
      const words = Object.freeze(
        analysis.words.map((word) => Object.freeze({ ...word })),
      );
      let previousEnd = 0;
      for (const word of words) {
        if (
          word.start < previousEnd ||
          !validTermRange(fragment.text, word) ||
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
      const generatedRanges = generateCandidates(generationInput);
      if (!candidateRangesSchema.validate(generatedRanges))
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
        if (!validTermRange(fragment.text, candidateRange))
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
      if (!candidateRankSchema.validate(ranking))
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
