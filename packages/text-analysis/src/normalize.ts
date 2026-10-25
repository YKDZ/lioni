import { isCodePointBoundary, validateRange } from "./ranges.ts";
import type { TextRange } from "./types.ts";

export type NormalizedText = {
  readonly original: string;
  readonly text: string;
  /** 无法由连续原文精确表示时返回 null，不扩大区间冒充精确命中。 */
  readonly mapRange: (range: TextRange) => TextRange | null;
};

type Origin = TextRange;
type Unit = TextRange & { readonly origins: readonly Origin[] };

/** NFC 比较视图；分解字符保留来源，再验证选中原文的规范化结果。 */
export function normalizeText(original: string): NormalizedText {
  const text = original.normalize("NFC");
  if (text === original)
    return Object.freeze({
      original,
      text,
      mapRange: (range: TextRange): TextRange => {
        validateRange(text, range, true);
        return Object.freeze({ start: range.start, end: range.end });
      },
    });

  const origins = new Map<string, { values: Origin[]; next: number }>();
  let offset = 0;
  for (const character of original) {
    const range = { start: offset, end: offset + character.length };
    for (const decomposed of character.normalize("NFD")) {
      let queue = origins.get(decomposed);
      if (queue === undefined) {
        queue = { values: [], next: 0 };
        origins.set(decomposed, queue);
      }
      queue.values.push(range);
    }
    offset = range.end;
  }

  const units: Unit[] = [];
  const unitIndexes = new Map<number, number>();
  offset = 0;
  for (const character of text) {
    const source: Origin[] = [];
    for (const decomposed of character.normalize("NFD")) {
      const queue = origins.get(decomposed);
      const origin = queue?.values[queue.next];
      if (queue === undefined || origin === undefined)
        throw new Error("NFC 分解的来源映射不完整。");
      queue.next += 1;
      source.push(origin);
    }
    unitIndexes.set(offset, units.length);
    units.push({
      start: offset,
      end: offset + character.length,
      origins: source,
    });
    offset += character.length;
  }

  return Object.freeze({
    original,
    text,
    mapRange: (range: TextRange): TextRange | null => {
      validateRange(text, range, true);
      if (range.start === range.end) {
        if (range.start === 0) return Object.freeze({ start: 0, end: 0 });
        if (range.end === text.length)
          return Object.freeze({
            start: original.length,
            end: original.length,
          });
        const index = unitIndexes.get(range.start);
        const left = index === undefined ? undefined : units[index - 1];
        const right = index === undefined ? undefined : units[index];
        const end = Math.max(
          ...(left?.origins.map((origin) => origin.end) ?? []),
        );
        const start = Math.min(
          ...(right?.origins.map((origin) => origin.start) ?? []),
        );
        return start === end ? Object.freeze({ start, end }) : null;
      }
      let start = original.length;
      let end = 0;
      const first = unitIndexes.get(range.start);
      if (first === undefined) return null;
      for (let index = first; index < units.length; index += 1) {
        const unit = units[index];
        if (unit === undefined || unit.start >= range.end) break;
        for (const origin of unit.origins) {
          start = Math.min(start, origin.start);
          end = Math.max(end, origin.end);
        }
      }
      if (
        !isCodePointBoundary(original, start) ||
        !isCodePointBoundary(original, end) ||
        original.slice(start, end).normalize("NFC") !==
          text.slice(range.start, range.end)
      )
        return null;
      return Object.freeze({ start, end });
    },
  });
}
