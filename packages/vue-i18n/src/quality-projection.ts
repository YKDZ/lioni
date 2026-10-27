import type {
  QualityCheckInput,
  StandardSchemaV1,
  TranslationUnitInput,
} from "@lioni/core";

import type {
  VueI18nMessageProjection,
  VueI18nProjectionInput,
  VueI18nProjector,
} from "./quality-types.ts";

export const vueI18nMessageProjectionSchema: StandardSchemaV1<
  VueI18nMessageProjection,
  VueI18nMessageProjection
> = {
  "~standard": {
    version: 1,
    vendor: "lioni-vue-i18n-message-projection",
    validate(value) {
      return isMessageProjection(value)
        ? { value }
        : { issues: [{ message: "Vue I18n 消息投影结构无效。" }] };
    },
  },
};

const projectionKey = <
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  input: VueI18nProjectionInput<TUnit, TTranslation, TBody, TUnavailable>,
) => [
  input.facts,
  input.candidate,
  input.sourceUnit,
  input.dependencies,
  input.relationships,
];

/** 为一组检查建立共用投影入口，排除不同检查各自的 configuration。 */
export function memoizedVueI18nProjection<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  input: QualityCheckInput<TUnit, TTranslation, unknown, TBody, TUnavailable>,
  projector: VueI18nProjector<TUnit, TTranslation, TBody, TUnavailable>,
): VueI18nMessageProjection | Promise<VueI18nMessageProjection> {
  const { configuration: _configuration, ...projectionInput } = input;
  const memoized = input.memo.memo(projector, {
    key: projectionKey,
  });
  return memoized(projectionInput);
}

export function isMessageProjection(
  value: unknown,
): value is VueI18nMessageProjection {
  if (!isRecord(value)) return false;
  return (
    typeof value.key === "string" &&
    typeof value.language === "string" &&
    isSourceMessage(value.source) &&
    isTargetMessage(value.target) &&
    isRecord(value.locations) &&
    isQualityLocation(value.locations.source) &&
    isQualityLocation(value.locations.target)
  );
}

function isSourceMessage(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.status === "available") return typeof value.text === "string";
  return value.status === "unavailable" || value.status === "absent";
}

function isTargetMessage(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.status === "available") return typeof value.text === "string";
  return value.status === "unavailable" || value.status === "missing";
}

function isQualityLocation(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.language === null || typeof value.language === "string") &&
    Object.hasOwn(value, "range")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
