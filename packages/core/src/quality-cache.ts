import type { QualityCheckOutcome, QualityObject } from "./qa.ts";
import { assertJsonValue } from "./standard-schema.ts";

export type CacheableQualityCheckOutcome<
  TObject extends QualityObject = QualityObject,
> = Omit<QualityCheckOutcome<TObject>, "status"> & {
  readonly status: "complete" | "not-applicable";
};

/** 原始检查结果缓存；异常处理和本次执行关联由缓存消费者在读取后完成。 */
export type QualityCheckResultCache<
  TObject extends QualityObject = QualityObject,
> = {
  get(key: string): Promise<CacheableQualityCheckOutcome<TObject> | undefined>;
  set(
    key: string,
    outcome: CacheableQualityCheckOutcome<TObject>,
  ): Promise<void>;
};

/** 校验缓存边界上的原始结果，损坏数据只会造成一次重新计算。 */
export function isCacheableQualityCheckOutcome(
  value: unknown,
): value is CacheableQualityCheckOutcome {
  if (
    !isRecord(value) ||
    (value.status !== "complete" && value.status !== "not-applicable") ||
    !Array.isArray(value.diagnostics) ||
    !value.diagnostics.every(isQualityFinding) ||
    !Array.isArray(value.issues) ||
    !value.issues.every(isQualityIssue) ||
    !isRecord(value.coverage)
  )
    return false;

  for (const key of [
    "selected",
    "evaluated",
    "notApplicable",
    "incomplete",
    "failed",
  ]) {
    const count = value.coverage[key];
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)
      return false;
  }

  try {
    assertJsonValue(value, "QA 原始检查结果");
  } catch {
    return false;
  }
  return true;
}

function isQualityFinding(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.severity === "error" ||
      value.severity === "warning" ||
      value.severity === "info") &&
    isQualityObject(value.object) &&
    isQualityLocation(value.location) &&
    typeof value.message === "string" &&
    Array.isArray(value.evidence) &&
    value.evidence.every(isQualityEvidence)
  );
}

function isQualityIssue(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.code === "string" &&
    typeof value.message === "string" &&
    (value.object === undefined || isQualityObject(value.object)) &&
    (value.location === undefined || isQualityLocation(value.location)) &&
    (value.evidence === undefined ||
      (Array.isArray(value.evidence) &&
        value.evidence.every(isQualityEvidence)))
  );
}

function isQualityEvidence(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.role === "string" &&
    isQualityObject(value.object) &&
    isQualityLocation(value.location) &&
    Object.hasOwn(value, "value")
  );
}

function isQualityObject(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.kind === "string" &&
    typeof value.key === "string"
  );
}

function isQualityLocation(value: unknown): boolean {
  return (
    isRecord(value) &&
    (typeof value.language === "string" || value.language === null) &&
    Object.hasOwn(value, "range") &&
    (value.key === undefined || typeof value.key === "string")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
