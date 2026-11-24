import { isRecord } from "../object-guards.ts";
import { assertJsonValue } from "../standard-schema.ts";
import type { QualityFinding, QualityObject } from "./qa.ts";

export type CachedQualityFindings<
  TObject extends QualityObject = QualityObject,
> = readonly QualityFinding<TObject>[];

/** 缓存成功执行的原始诊断。空数组可复用，豁免按本次配置重新应用。 */
export type QualityCheckResultCache<
  TObject extends QualityObject = QualityObject,
> = {
  get(key: string): Promise<CachedQualityFindings<TObject> | undefined>;
  set(key: string, findings: CachedQualityFindings<TObject>): Promise<void>;
};

export function isCachedQualityFindings(
  value: unknown,
): value is CachedQualityFindings {
  if (!Array.isArray(value) || !value.every(isQualityFinding)) return false;
  try {
    assertJsonValue(value, "QA 原始诊断");
    return true;
  } catch {
    return false;
  }
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
    typeof value.key === "string" &&
    (value.language === undefined || typeof value.language === "string")
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
