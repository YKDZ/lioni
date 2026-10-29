import type { StandardSchemaV1 } from "@standard-schema/spec";
import { z } from "zod";

import {
  copyJson,
  contractIssues,
  jsonValueSchema,
  nonemptyTextSchema,
  TermContractError,
  type JsonValue,
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

export const termRangeSchema = z.compile(
  z.object({
    start: z.int().nonnegative(),
    end: z.int().nonnegative(),
  }),
);

export function splitsSurrogatePair(text: string, boundary: number): boolean {
  if (boundary <= 0 || boundary >= text.length) return false;
  const before = text.charCodeAt(boundary - 1);
  const after = text.charCodeAt(boundary);
  return (
    before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff
  );
}

export function validTermRange(text: string, range: TermRange): boolean {
  return (
    range.end > range.start &&
    range.end <= text.length &&
    !splitsSurrogatePair(text, range.start) &&
    !splitsSurrogatePair(text, range.end)
  );
}

export const termFragmentSchema = z
  .object({
    ref: jsonValueSchema,
    text: z.string(),
    protectedRanges: z.array(termRangeSchema).exactOptional(),
  })
  .superRefine((fragment, context) => {
    fragment.protectedRanges?.forEach((range, index) => {
      if (!validTermRange(fragment.text, range))
        context.addIssue({
          code: "custom",
          message: "保护区间必须是正文内非空的 UTF-16 半开区间。",
          path: ["protectedRanges", index],
        });
    });
  }) satisfies z.ZodType<TermFragment>;
export const termTextInputSchema = z.compile(
  z.object({
    language: nonemptyTextSchema,
    fragments: z.array(termFragmentSchema),
    /** 省略表示宿主已提供此侧完整的比较范围。 */
    complete: z.boolean().exactOptional(),
  }),
) satisfies z.ZodType<TermTextInput>;
const comparisonGroupSchema = z.object({
  ref: jsonValueSchema.exactOptional(),
  source: termTextInputSchema,
  target: termTextInputSchema,
});
export const comparisonContract = z.compile(
  z.object({
    groups: z.array(comparisonGroupSchema),
  }),
) satisfies z.ZodType<TermComparisonInput>;

export function validateTextInput(value: TermTextInput): void {
  if (!termTextInputSchema.validate(value))
    throw new TermContractError(
      "input",
      contractIssues(termTextInputSchema.safeParse(value).error!),
    );
}

export const termComparisonInputSchema: StandardSchemaV1<TermComparisonInput> =
  {
    "~standard": {
      version: 1,
      vendor: "lioni-terminology",
      validate(value) {
        try {
          const snapshot = copyJson(value, "input");
          return comparisonContract.validate(snapshot)
            ? { value: snapshot as TermComparisonInput }
            : {
                issues: contractIssues(
                  comparisonContract.safeParse(snapshot).error!,
                ),
              };
        } catch (error) {
          if (error instanceof TermContractError)
            return { issues: error.issues };
          throw error;
        }
      },
    },
  };

export function comparisonSnapshot(value: unknown): TermComparisonInput {
  const snapshot = copyJson(value, "input");
  if (!comparisonContract.validate(snapshot))
    throw new TermContractError(
      "input",
      contractIssues(comparisonContract.safeParse(snapshot).error!),
    );
  return snapshot as TermComparisonInput;
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
