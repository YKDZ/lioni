import type { CoverageStatus, EnumerationCompleteness } from "./index.ts";

/** 汇总已枚举的范围；空范围表示本次未读取。 */
export function readStatus(
  scopes: readonly { readonly enumeration: EnumerationCompleteness }[],
  error?: string,
): CoverageStatus {
  if (
    error !== undefined ||
    scopes.some(({ enumeration }) => enumeration === "failed")
  )
    return "failed";
  if (scopes.length === 0) return "notRead";
  return scopes.every(({ enumeration }) => enumeration === "complete")
    ? "complete"
    : "incomplete";
}
