import {
  complementRanges,
  emptyRanges,
  mergeRanges,
  validateInput,
} from "./ranges.ts";
import type { TextInput, WordAnalysis, WordToken } from "./types.ts";

/** 基础词界只承诺 en/zh/ja；其他语言由调用方明确替换。 */
export function segmentWords(input: TextInput): WordAnalysis {
  validateInput(input);
  const protectedRanges = mergeRanges(
    input.text,
    input.protectedRanges ?? emptyRanges,
  );
  let language: string | undefined;
  try {
    language = new Intl.Locale(input.language).language;
  } catch {
    language = undefined;
  }
  if (language === undefined || !["en", "zh", "ja"].includes(language))
    return Object.freeze({
      words: Object.freeze([]),
      boundaries: Object.freeze([]),
      complete: false,
      issues: Object.freeze([
        Object.freeze({
          code: "unsupported-language",
          message: `内置分词不支持语言 ${input.language}。`,
        }),
      ]),
    });

  const segmenter = new Intl.Segmenter(input.language, { granularity: "word" });
  const words: WordToken[] = [];
  const boundaries = new Set<number>();
  for (const range of complementRanges(input.text, protectedRanges)) {
    boundaries.add(range.start);
    boundaries.add(range.end);
    for (const segment of segmenter.segment(
      input.text.slice(range.start, range.end),
    )) {
      const start = range.start + segment.index;
      const end = start + segment.segment.length;
      boundaries.add(start);
      boundaries.add(end);
      if (segment.isWordLike)
        words.push(Object.freeze({ start, end, text: segment.segment }));
    }
  }
  return Object.freeze({
    words: Object.freeze(words),
    boundaries: Object.freeze([...boundaries].sort((a, b) => a - b)),
    complete: true,
    issues: Object.freeze([]),
  });
}
