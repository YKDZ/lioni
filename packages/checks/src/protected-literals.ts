export type ProtectedLiteralIssue = {
  readonly literal: string;
};

const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** 原文实际含有的字面值必须在译文中按 ASCII 标识符边界保留。 */
export function compareProtectedLiterals(input: {
  readonly source: string;
  readonly target: string;
  readonly literals: readonly string[];
}): readonly ProtectedLiteralIssue[] {
  return input.literals
    .filter(
      (literal) =>
        input.source.includes(literal) &&
        !new RegExp(
          `(?<![A-Za-z0-9_])${escapeRegExp(literal)}(?![A-Za-z0-9_])`,
          "u",
        ).test(input.target),
    )
    .map((literal) => ({ literal }));
}
