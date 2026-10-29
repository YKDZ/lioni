import {
  TextAnalysisContractError,
  analysisError,
  textInputSchema,
  textRangeSchema,
} from "./types.ts";
import type { TextInput, TextRange } from "./types.ts";

export const emptyRanges: readonly TextRange[] = Object.freeze([]);

export function isCodePointBoundary(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) return true;
  const previous = text.charCodeAt(offset - 1);
  const next = text.charCodeAt(offset);
  return !(
    previous >= 0xd800 &&
    previous <= 0xdbff &&
    next >= 0xdc00 &&
    next <= 0xdfff
  );
}

export function validateInput(input: TextInput): void {
  if (!textInputSchema.validate(input))
    throw analysisError(
      "invalid-input",
      textInputSchema.safeParse(input).error!,
    );
}

export function validateRange(
  text: string,
  range: TextRange,
  allowEmpty = false,
): void {
  if (!textRangeSchema.validate(range))
    throw analysisError(
      "invalid-range",
      textRangeSchema.safeParse(range).error!,
    );
  validateRangeBounds(text, range, allowEmpty);
}

/** 在形状已经通过 schema 后，只检查区间与当前原文的关系。 */
export function validateRangeBounds(
  text: string,
  range: TextRange,
  allowEmpty = false,
): void {
  if (
    range.end > text.length ||
    (allowEmpty ? range.start > range.end : range.start >= range.end) ||
    !isCodePointBoundary(text, range.start) ||
    !isCodePointBoundary(text, range.end)
  )
    throw new TextAnalysisContractError(
      "invalid-range",
      "区间必须是原文内不切开代理对的 UTF-16 半开区间。",
    );
}

export function mergeRanges(
  text: string,
  ranges: readonly TextRange[],
): readonly TextRange[] {
  const sorted = ranges.map((range) => {
    validateRange(text, range);
    return { start: range.start, end: range.end };
  });
  sorted.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: { start: number; end: number }[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (previous !== undefined && range.start <= previous.end)
      previous.end = Math.max(previous.end, range.end);
    else merged.push(range);
  }
  return Object.freeze(merged.map((range) => Object.freeze(range)));
}

export function complementRanges(
  text: string,
  excluded: readonly TextRange[],
): readonly TextRange[] {
  const ranges: TextRange[] = [];
  let start = 0;
  for (const range of excluded) {
    if (start < range.start)
      ranges.push(Object.freeze({ start, end: range.start }));
    start = range.end;
  }
  if (start < text.length)
    ranges.push(Object.freeze({ start, end: text.length }));
  return Object.freeze(ranges);
}

export function fitsRange(
  range: TextRange,
  available: readonly TextRange[],
): boolean {
  return available.some(
    (gap) => gap.start <= range.start && range.end <= gap.end,
  );
}
