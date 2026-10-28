import { discoveryFunctionWords } from "./discovery-languages.ts";
import type { TermCandidateGenerator } from "./discovery.ts";
import type { TermRange } from "./input.ts";

/** 紧连的短横线和词间连接符可属于词组；句读与破折号仍终止词组。 */
function connectsWords(gap: string): boolean {
  return (
    /^\s*$/u.test(gap) || /^[-‐‑]$/u.test(gap) || /^\s*[/&·]\s*$/u.test(gap)
  );
}

export function createDefaultCandidateGenerator(
  language: string,
): TermCandidateGenerator {
  const functionWords = discoveryFunctionWords(language);
  return (input) => {
    const ranges: TermRange[] = [];
    const gaps = input.words.map((word, index) =>
      index === 0
        ? ""
        : input.text.slice(input.words[index - 1]!.end, word.start),
    );
    const connected = gaps.map(connectsWords);
    const compound = gaps.map((gap) => /^[-‐‑/&·]$/u.test(gap));
    const firstContent = input.words.map(({ text }, index) =>
      functionWords.has(text.toLowerCase()) ? Infinity : index,
    );
    const lastContent = firstContent.map((index) =>
      index === Infinity ? -1 : index,
    );
    // 复合词首尾的功能词借助同一紧连词内的实词成立，不能跨空白借词。
    for (let index = input.words.length - 2; index >= 0; index -= 1)
      if (firstContent[index] === Infinity && compound[index + 1])
        firstContent[index] = firstContent[index + 1]!;
    for (let index = 1; index < input.words.length; index += 1)
      if (lastContent[index] === -1 && compound[index])
        lastContent[index] = lastContent[index - 1]!;
    for (let start = 0; start < input.words.length; start += 1) {
      if (firstContent[start]! >= start + input.maxWords) continue;
      const first = input.words[start]!;
      for (
        let end = start;
        end < Math.min(input.words.length, start + input.maxWords);
        end += 1
      ) {
        const last = input.words[end]!;
        if (end > start && !connected[end]) break;
        if (
          input.protectedRanges.some(
            (range) => first.start < range.end && range.start < last.end,
          )
        )
          break;
        const text = input.text.slice(first.start, last.end);
        if (
          text.length > input.maxCharacters &&
          Array.from(text).length > input.maxCharacters
        )
          break;
        // 中间的功能词可以属于完整术语，不提前结束词组。
        if (firstContent[start]! <= end && lastContent[end]! >= start)
          ranges.push(Object.freeze({ start: first.start, end: last.end }));
      }
    }
    return Object.freeze(ranges);
  };
}
