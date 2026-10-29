import { z } from "zod";

import { TextAnalysisContractError } from "./types.ts";
import type { TextRecognizer, TextToken } from "./types.ts";

export type RegexTokenOptions = {
  readonly kind: string;
  readonly pattern: RegExp;
  readonly identity?: (match: RegExpExecArray) => string;
  readonly value?: (match: RegExpExecArray) => unknown;
  readonly protect?: boolean;
};

const tokenKindSchema = z.string().min(1);
const markersSchema = z.array(z.string().min(1));

/** 每个可用原文区间独立扫描，不共享 RegExp.lastIndex。 */
export function regexTokens(options: RegexTokenOptions): TextRecognizer {
  const { kind, identity, value, protect } = options;
  if (!tokenKindSchema.safeParse(kind).success)
    throw new TextAnalysisContractError("invalid-kind", "token 种类必须非空。");
  const source = options.pattern.source;
  const flags = options.pattern.flags.includes("g")
    ? options.pattern.flags
    : `${options.pattern.flags}g`;
  return (input) => {
    const tokens: TextToken[] = [];
    for (const range of input.availableRanges) {
      const pattern = new RegExp(source, flags);
      const fragment = input.text.slice(range.start, range.end);
      for (const match of fragment.matchAll(pattern)) {
        if (match[0].length === 0)
          throw new TextAnalysisContractError(
            "empty-token",
            "识别器不能返回空匹配。",
          );
        const start = range.start + match.index;
        tokens.push({
          kind,
          start,
          end: start + match[0].length,
          ...(identity === undefined ? {} : { identity: identity(match) }),
          ...(value === undefined ? {} : { value: value(match) }),
          ...(protect === undefined ? {} : { protect }),
        });
      }
    }
    return tokens;
  };
}

/** ASCII 整数与小数，保留符号、前导零及全部原始数字，不解析为浮点数。 */
export function asciiNumbers(): TextRecognizer {
  return regexTokens({
    kind: "number",
    pattern: /[+-]?[0-9]+(?:\.[0-9]+)?/gu,
    value: (match) => match[0],
  });
}

/** 仅为显式选择的示例语法；不包含数字索引、嵌套或字面转义。 */
export function braceVariables(
  options: { readonly protect?: boolean } = {},
): TextRecognizer {
  return regexTokens({
    kind: "variable",
    pattern: /\{([A-Za-z_][A-Za-z0-9_]*)\}/gu,
    identity: (match) => match[1] as string,
    value: (match) => match[1],
    ...(options.protect === undefined ? {} : { protect: options.protect }),
  });
}

export function literalMarkers(
  markers: readonly string[],
  options: { readonly kind?: string; readonly protect?: boolean } = {},
): TextRecognizer {
  if (!markersSchema.safeParse(markers).success)
    throw new TextAnalysisContractError("empty-marker", "字面标记不能是空串。");
  const literals = [...new Set(markers)].sort(
    (a, b) => b.length - a.length || a.localeCompare(b),
  );
  const { kind = "marker", protect } = options;
  return (input) => {
    const tokens: TextToken[] = [];
    for (const range of input.availableRanges) {
      let offset = range.start;
      while (offset < range.end) {
        const marker = literals.find(
          (literal) =>
            offset + literal.length <= range.end &&
            input.text.startsWith(literal, offset),
        );
        if (marker !== undefined) {
          tokens.push({
            start: offset,
            end: offset + marker.length,
            kind,
            identity: marker,
            value: marker,
            ...(protect === undefined ? {} : { protect }),
          });
          offset += marker.length;
        } else {
          const point = input.text.codePointAt(offset);
          offset += point !== undefined && point > 0xffff ? 2 : 1;
        }
      }
    }
    return tokens;
  };
}
