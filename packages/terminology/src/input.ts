import {
  copyJson,
  contractIssue,
  isRecord,
  TermContractError,
  type JsonValue,
  type TermContractIssue,
  type TermSchema,
} from "./data.ts";

export type TermRange = { readonly start: number; readonly end: number };

export type TermFragment = {
  readonly ref: JsonValue;
  readonly text: string;
  readonly protectedRanges?: readonly TermRange[];
};

export type TermTextInput = {
  readonly language: string;
  readonly fragments: readonly TermFragment[];
  /** 省略表示宿主已提供此侧完整的比较范围。 */
  readonly complete?: boolean;
};

export type TermComparisonGroup = {
  readonly ref?: JsonValue;
  readonly source: TermTextInput;
  readonly target: TermTextInput;
};

export type TermComparisonInput = {
  readonly groups: readonly TermComparisonGroup[];
};

export function textInputIssues(
  value: unknown,
  path: readonly (string | number)[] = [],
): readonly TermContractIssue[] {
  const issues: TermContractIssue[] = [];
  const add = (
    code: string,
    message: string,
    suffix: readonly (string | number)[] = [],
  ) => issues.push(contractIssue(code, message, [...path, ...suffix]));
  if (!isRecord(value))
    return [contractIssue("invalid-text-input", "文本输入必须是对象。", path)];
  if (typeof value.language !== "string" || value.language.trim() === "")
    add("invalid-language", "文本语言必须非空。", ["language"]);
  if (value.complete !== undefined && typeof value.complete !== "boolean")
    add("invalid-completeness", "范围完整性必须是布尔值。", ["complete"]);
  if (!Array.isArray(value.fragments)) {
    add("invalid-fragments", "文本输入需要 fragments 数组。", ["fragments"]);
    return issues;
  }
  value.fragments.forEach((fragment: unknown, index: number) => {
    const fp = ["fragments", index];
    if (
      !isRecord(fragment) ||
      !Object.hasOwn(fragment, "ref") ||
      typeof fragment.text !== "string"
    ) {
      add("invalid-fragment", "片段必须包含 ref 与 text。", fp);
      return;
    }
    if (fragment.protectedRanges !== undefined) {
      if (!Array.isArray(fragment.protectedRanges)) {
        add("invalid-range", "保护区间必须是数组。", [
          ...fp,
          "protectedRanges",
        ]);
        return;
      }
      fragment.protectedRanges.forEach((range: unknown, ri: number) => {
        if (
          !isRecord(range) ||
          typeof range.start !== "number" ||
          typeof range.end !== "number" ||
          !Number.isInteger(range.start) ||
          !Number.isInteger(range.end) ||
          range.start < 0 ||
          range.end <= range.start ||
          range.end > (fragment.text as string).length
        )
          add("invalid-range", "保护区间必须是正文内非空的 UTF-16 半开区间。", [
            ...fp,
            "protectedRanges",
            ri,
          ]);
      });
    }
  });
  return issues;
}

export function validateTextInput(value: TermTextInput): void {
  const issues = textInputIssues(value);
  if (issues.length) throw new TermContractError("input", issues);
}

export const termComparisonInputSchema: TermSchema<TermComparisonInput> = {
  "~standard": {
    version: 1,
    vendor: "lioni-terminology",
    validate(value) {
      try {
        const snapshot = copyJson(value, "input");
        if (!isRecord(snapshot) || !Array.isArray(snapshot.groups))
          return {
            issues: [
              contractIssue(
                "invalid-comparison",
                "比较输入需要 groups 数组。",
                ["groups"],
              ),
            ],
          };
        const issues: TermContractIssue[] = [];
        snapshot.groups.forEach((group: unknown, index: number) => {
          if (!isRecord(group)) {
            issues.push(
              contractIssue("invalid-group", "比较组必须是对象。", [
                "groups",
                index,
              ]),
            );
            return;
          }
          issues.push(
            ...textInputIssues(group.source, ["groups", index, "source"]),
          );
          issues.push(
            ...textInputIssues(group.target, ["groups", index, "target"]),
          );
        });
        return issues.length
          ? { issues }
          : { value: snapshot as TermComparisonInput };
      } catch (error) {
        if (error instanceof TermContractError) return { issues: error.issues };
        throw error;
      }
    },
  },
};

export function comparisonSnapshot(
  value: TermComparisonInput,
): TermComparisonInput {
  const result = termComparisonInputSchema["~standard"].validate(value);
  if (result.issues !== undefined)
    throw new TermContractError("input", result.issues);
  return result.value;
}

export function sameJson(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (
    typeof left !== "object" ||
    left === null ||
    typeof right !== "object" ||
    right === null
  )
    return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) =>
        Object.hasOwn(right, key) &&
        sameJson(
          (left as Record<string, unknown>)[key],
          (right as Record<string, unknown>)[key],
        ),
    )
  );
}
