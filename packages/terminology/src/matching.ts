import type { MemoScope } from "@lioni/memo";
import {
  createTextAnalysis,
  normalizeText,
  type NormalizedText,
  type TextAnalysis,
  type WordAnalysis,
} from "@lioni/text-analysis";

import {
  assertUsageConflicts,
  contractIssue,
  selectTerms,
  TermContractError,
  type Termbase,
  type TermExpression,
  type TermUsage,
  type JsonValue,
} from "./data.ts";
import {
  splitsSurrogatePair,
  validateTextInput,
  type TermRange,
  type TermTextInput,
} from "./input.ts";

export type TermBoundaryInput = {
  readonly text: string;
  readonly range: TermRange;
  readonly entry: TermExpression;
};

export type TermMatchingPolicy = {
  readonly id: string;
  readonly boundary:
    | "literal"
    | "word"
    | ((input: TermBoundaryInput) => boolean | PromiseLike<boolean>);
  readonly normalize?: (text: string) => NormalizedText;
  /** 额外识别形式，不修改规范资料中的表达或使用地位。 */
  readonly forms?: (entry: TermExpression) => readonly string[];
};

export type CompileTermsOptions = {
  readonly analysis?: TextAnalysis;
  readonly policy?: TermMatchingPolicy;
  readonly policyFor?: (
    entry: TermExpression,
  ) => TermMatchingPolicy | undefined;
};

type CompiledForm = {
  readonly entry: TermExpression;
  readonly form: string;
  readonly key: string;
  readonly policy: TermMatchingPolicy;
};

export type CompiledTerms = {
  readonly termbase: Termbase;
  readonly languages: readonly string[];
  readonly analysis: TextAnalysis;
};

export const basicTermTextAnalysis = createTextAnalysis();
const compiledIndexes = new WeakMap<CompiledTerms, readonly CompiledForm[]>();
const literalPolicy: TermMatchingPolicy = Object.freeze({
  id: "nfc-literal",
  boundary: "literal",
});
const englishPolicy: TermMatchingPolicy = Object.freeze({
  id: "nfc-english-word-boundary",
  boundary: "word",
});

export function defaultTermMatchingPolicy(
  language: string,
): TermMatchingPolicy | undefined {
  if (/^en(?:-|$)/iu.test(language)) return englishPolicy;
  if (/^(?:zh|ja)(?:-|$)/iu.test(language)) return literalPolicy;
  return undefined;
}

export function compileTerms(
  termbase: Termbase,
  options: CompileTermsOptions = {},
): CompiledTerms {
  const selected = selectTerms(termbase);
  const forms: CompiledForm[] = [];
  for (const entry of selected.expressions) {
    const selectedPolicy =
      options.policyFor?.(entry) ??
      options.policy ??
      defaultTermMatchingPolicy(entry.language);
    if (!selectedPolicy) continue;
    if (
      !selectedPolicy.id ||
      (selectedPolicy.boundary !== "literal" &&
        selectedPolicy.boundary !== "word" &&
        typeof selectedPolicy.boundary !== "function")
    )
      throw new TermContractError("compile", [
        contractIssue("invalid-policy", "匹配政策需要身份及有效边界政策。"),
      ]);
    const policy = Object.freeze({ ...selectedPolicy });
    const normalize = policy.normalize ?? normalizeText;
    const candidates = [
      entry.expression.text,
      ...(policy.forms?.(entry) ?? []),
    ];
    const seen = new Set<string>();
    for (const form of candidates) {
      if (typeof form !== "string" || form.trim() === "")
        throw new TermContractError("compile", [
          contractIssue("invalid-form", "额外识别形式不得为空。", [
            entry.conceptId,
            entry.expressionId,
          ]),
        ]);
      const normalized = normalize(form);
      validateNormalized(normalized, form, "compile");
      if (normalized.text === "")
        throw new TermContractError("compile", [
          contractIssue(
            "empty-normalized-form",
            "规范化后的识别形式不得为空。",
            [entry.conceptId, entry.expressionId],
          ),
        ]);
      if (seen.has(normalized.text)) continue;
      seen.add(normalized.text);
      forms.push(Object.freeze({ entry, form, key: normalized.text, policy }));
    }
  }
  assertUsageConflicts(
    forms.map(({ entry, key }) => ({ entry, key })),
    "compile",
  );
  const result: CompiledTerms = Object.freeze({
    termbase: selected,
    languages: Object.freeze([
      ...new Set(selected.expressions.map((entry) => entry.language)),
    ]),
    analysis: options.analysis ?? basicTermTextAnalysis,
  });
  compiledIndexes.set(result, Object.freeze(forms));
  return result;
}

export type TermRuntime = { readonly memo?: MemoScope };

export type TermAnalysisIssue = {
  readonly code: string;
  readonly message: string;
  readonly fragmentIndex?: number;
  readonly conceptId?: string;
  readonly expressionId?: string;
};

export type TermMatch = {
  readonly conceptId: string;
  readonly expressionId: string;
  readonly language: string;
  readonly usage: TermUsage;
  readonly fragmentIndex: number;
  readonly ref: JsonValue;
  readonly range: TermRange;
  readonly text: string;
  readonly expressionText: string;
  readonly form: string;
  readonly policyId: string;
  readonly entry: TermExpression;
};

export type TermAmbiguity = {
  readonly reason:
    | "same-span-concepts"
    | "crossing-overlap"
    | "conflicting-usage";
  readonly matches: readonly TermMatch[];
};

export type TermMatches = {
  readonly status: "complete" | "incomplete";
  readonly matches: readonly TermMatch[];
  readonly active: readonly TermMatch[];
  readonly certain: readonly TermMatch[];
  readonly suppressed: readonly {
    readonly match: TermMatch;
    readonly by: readonly TermMatch[];
  }[];
  readonly ambiguities: readonly TermAmbiguity[];
  readonly issues: readonly TermAnalysisIssue[];
};

export type FindTermsOptions = TermRuntime & {
  readonly conceptIds?: readonly string[];
};

function validateNormalized(
  value: NormalizedText,
  original: string,
  stage: "compile" | "input",
) {
  if (
    value.original !== original ||
    typeof value.text !== "string" ||
    typeof value.mapRange !== "function"
  )
    throw new TermContractError(stage, [
      contractIssue(
        "invalid-normalization",
        "规范化策略必须保留原文并提供区间回映。",
      ),
    ]);
}

function intersects(left: TermRange, right: TermRange): boolean {
  return left.start < right.end && right.start < left.end;
}

function contains(outer: TermRange, inner: TermRange): boolean {
  return (
    outer.start <= inner.start &&
    outer.end >= inner.end &&
    (outer.start < inner.start || outer.end > inner.end)
  );
}

function appendWordIssues(
  target: TermAnalysisIssue[],
  words: WordAnalysis,
  fragmentIndex: number,
): void {
  for (const issue of words.issues) {
    if (
      !target.some(
        (existing) =>
          existing.fragmentIndex === fragmentIndex &&
          existing.code === issue.code &&
          existing.message === issue.message,
      )
    )
      target.push({ ...issue, fragmentIndex });
  }
  if (
    !words.complete &&
    words.issues.length === 0 &&
    !target.some(
      (issue) =>
        issue.fragmentIndex === fragmentIndex &&
        issue.code === "incomplete-word-boundaries",
    )
  )
    target.push({
      code: "incomplete-word-boundaries",
      message: "词界分析未完整处理片段。",
      fragmentIndex,
    });
}

export function resolveTermMatches(
  matches: readonly TermMatch[],
  issues: readonly TermAnalysisIssue[] = [],
): TermMatches {
  const suppressed: { match: TermMatch; by: readonly TermMatch[] }[] = [];
  const active = matches.filter((match) => {
    const by = matches.filter(
      (other) =>
        other.fragmentIndex === match.fragmentIndex &&
        contains(other.range, match.range),
    );
    if (by.length)
      suppressed.push(Object.freeze({ match, by: Object.freeze(by) }));
    return by.length === 0;
  });
  const ambiguities: TermAmbiguity[] = [];
  const ambiguous = new Set<TermMatch>();
  for (let li = 0; li < active.length; li += 1) {
    const left = active[li]!;
    for (let ri = li + 1; ri < active.length; ri += 1) {
      const right = active[ri]!;
      if (
        left.fragmentIndex !== right.fragmentIndex ||
        !intersects(left.range, right.range)
      )
        continue;
      const equal =
        left.range.start === right.range.start &&
        left.range.end === right.range.end;
      const usageConflict =
        equal &&
        left.conceptId === right.conceptId &&
        (left.usage === "forbidden") !== (right.usage === "forbidden");
      if (equal && left.conceptId === right.conceptId && !usageConflict)
        continue;
      ambiguous.add(left);
      ambiguous.add(right);
      ambiguities.push(
        Object.freeze({
          reason: usageConflict
            ? "conflicting-usage"
            : equal
              ? "same-span-concepts"
              : "crossing-overlap",
          matches: Object.freeze([left, right]),
        }),
      );
    }
  }
  return Object.freeze({
    status: issues.length || ambiguities.length ? "incomplete" : "complete",
    matches: Object.freeze([...matches]),
    active: Object.freeze(active),
    certain: Object.freeze(active.filter((match) => !ambiguous.has(match))),
    suppressed: Object.freeze(suppressed),
    ambiguities: Object.freeze(ambiguities),
    issues: Object.freeze([...issues]),
  });
}

/** 分片查找；严格包含只在全部边界和保护政策通过后处理。 */
export async function findTerms(
  terms: CompiledTerms,
  input: TermTextInput,
  options: FindTermsOptions = {},
): Promise<TermMatches> {
  validateTextInput(input);
  const index = compiledIndexes.get(terms);
  if (!index)
    throw new TermContractError("input", [
      contractIssue("uncompiled-terms", "必须使用 compileTerms 创建的匹配器。"),
    ]);
  const applicable =
    options.conceptIds === undefined ? undefined : new Set(options.conceptIds);
  const entries = terms.termbase.expressions.filter(
    (entry) =>
      entry.language === input.language &&
      (!applicable || applicable.has(entry.conceptId)),
  );
  const forms = index.filter(
    ({ entry }) =>
      entry.language === input.language &&
      (!applicable || applicable.has(entry.conceptId)),
  );
  const issues: TermAnalysisIssue[] = [];
  const matches: TermMatch[] = [];
  if (input.complete === false)
    issues.push({
      code: "incomplete-scope",
      message: "文本输入范围不完整，可能仍有未提供的片段。",
    });
  if (
    !input.fragments.length ||
    applicable?.size === 0 ||
    terms.termbase.expressions.length === 0
  )
    return resolveTermMatches(matches, issues);
  const available = new Set(forms.map(({ entry }) => entry));
  for (const entry of entries)
    if (!available.has(entry))
      issues.push({
        code: "unsupported-language",
        message: `未声明 ${input.language} 的术语匹配能力。`,
        conceptId: entry.conceptId,
        expressionId: entry.expressionId,
      });
  if (!entries.length && applicable === undefined)
    issues.push({
      code: "missing-language-data",
      message: `有效术语库没有 ${input.language} 的表达资料。`,
    });
  for (const [fragmentIndex, fragment] of input.fragments.entries()) {
    if (!forms.length) continue;
    const textInput = {
      text: fragment.text,
      language: input.language,
      ...(fragment.protectedRanges === undefined
        ? {}
        : { protectedRanges: fragment.protectedRanges }),
    };
    const structure = await terms.analysis.structures(textInput, options);
    if (!structure.complete) {
      issues.push(
        ...structure.issues.map((issue) => ({
          code: issue.code,
          message: issue.message,
          fragmentIndex,
        })),
      );
      if (!structure.issues.length)
        issues.push({
          code: "incomplete-structure",
          message: "结构分析未完整处理片段。",
          fragmentIndex,
        });
    }
    const normalizedCache = new Map<
      (text: string) => NormalizedText,
      NormalizedText
    >();
    let words: WordAnalysis | undefined;
    let boundaries: ReadonlySet<number> | undefined;
    const seen = new Set<string>();
    for (const { entry, form, key, policy } of forms) {
      const normalizer = policy.normalize ?? normalizeText;
      let normalized = normalizedCache.get(normalizer);
      if (!normalized) {
        normalized = options.memo
          ? options.memo.memo(normalizer)(fragment.text)
          : normalizer(fragment.text);
        validateNormalized(normalized, fragment.text, "input");
        normalizedCache.set(normalizer, normalized);
      }
      for (
        let position = normalized.text.indexOf(key);
        position !== -1;
        position = normalized.text.indexOf(key, position + 1)
      ) {
        const range = normalized.mapRange({
          start: position,
          end: position + key.length,
        });
        if (!range) {
          issues.push({
            code: "unmappable-match",
            message: "命中无法精确回映到原文区间。",
            fragmentIndex,
            conceptId: entry.conceptId,
            expressionId: entry.expressionId,
          });
          continue;
        }
        if (
          !Number.isInteger(range.start) ||
          !Number.isInteger(range.end) ||
          range.start < 0 ||
          range.end <= range.start ||
          range.end > fragment.text.length
        )
          throw new TermContractError("input", [
            contractIssue(
              "invalid-mapped-range",
              "规范化策略返回了无效原文区间。",
            ),
          ]);
        if (
          splitsSurrogatePair(fragment.text, range.start) ||
          splitsSurrogatePair(fragment.text, range.end)
        )
          throw new TermContractError("input", [
            contractIssue(
              "split-surrogate-range",
              "规范化策略不能将原文区间映射到代理对内部。",
            ),
          ]);
        if (
          structure.protectedRanges.some((protectedRange) =>
            intersects(range, protectedRange),
          )
        )
          continue;
        if (policy.boundary === "word") {
          words ??= await terms.analysis.words(textInput, options);
          appendWordIssues(issues, words, fragmentIndex);
          boundaries ??= new Set(words.boundaries);
          if (!boundaries.has(range.start) || !boundaries.has(range.end))
            continue;
        } else if (typeof policy.boundary === "function") {
          const accepted = await policy.boundary({
            text: fragment.text,
            range,
            entry,
          });
          if (typeof accepted !== "boolean")
            throw new TermContractError("input", [
              contractIssue(
                "invalid-boundary-result",
                "自定义词界政策必须返回布尔值。",
              ),
            ]);
          if (!accepted) continue;
        }
        const identity = JSON.stringify([
          entry.conceptId,
          entry.expressionId,
          range.start,
          range.end,
        ]);
        if (seen.has(identity)) continue;
        seen.add(identity);
        matches.push(
          Object.freeze({
            conceptId: entry.conceptId,
            expressionId: entry.expressionId,
            language: input.language,
            usage: entry.expression.usage,
            fragmentIndex,
            ref: fragment.ref,
            range: Object.freeze({ ...range }),
            text: fragment.text.slice(range.start, range.end),
            expressionText: entry.expression.text,
            form,
            policyId: policy.id,
            entry,
          }),
        );
      }
    }
  }
  matches.sort(
    (left, right) =>
      left.fragmentIndex - right.fragmentIndex ||
      left.range.start - right.range.start ||
      right.range.end - left.range.end ||
      left.conceptId.localeCompare(right.conceptId) ||
      left.expressionId.localeCompare(right.expressionId),
  );
  return resolveTermMatches(matches, issues);
}
