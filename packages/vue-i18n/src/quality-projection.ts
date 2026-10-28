import type { QualityCheckInput, TranslationUnitInput } from "@lioni/core";
import * as v from "valibot";

const recordSchema = v.custom<Record<string, unknown>>(
  (value) =>
    value !== null && typeof value === "object" && !Array.isArray(value),
);

const sourceMessageSchema = v.pipe(
  recordSchema,
  v.variant("status", [
    v.looseObject({ status: v.literal("available"), text: v.string() }),
    v.looseObject({ status: v.literal("unavailable") }),
    v.looseObject({ status: v.literal("absent") }),
  ]),
);

const targetMessageSchema = v.pipe(
  recordSchema,
  v.variant("status", [
    v.looseObject({ status: v.literal("available"), text: v.string() }),
    v.looseObject({ status: v.literal("unavailable") }),
    v.looseObject({ status: v.literal("missing") }),
  ]),
);

const qualityLocationSchema = v.pipe(
  recordSchema,
  v.check(
    (value) => Object.hasOwn(value, "range"),
    "Vue I18n 消息位置必须显式提供 range。",
  ),
  v.looseObject({
    language: v.nullable(v.string()),
    range: v.unknown(),
    key: v.exactOptional(v.string()),
  }),
);

const locationsSchema = v.pipe(
  recordSchema,
  v.looseObject({
    source: qualityLocationSchema,
    target: qualityLocationSchema,
  }),
);

const vueI18nMessageProjectionShapeSchema = v.pipe(
  recordSchema,
  v.looseObject({
    key: v.string(),
    language: v.string(),
    source: sourceMessageSchema,
    target: targetMessageSchema,
    locations: locationsSchema,
  }),
);

export type VueI18nMessageProjection = v.InferOutput<
  typeof vueI18nMessageProjectionShapeSchema
>;

/** 验证投影形状但返回原值，避免宽松对象复制时丢弃宿主扩展键。 */
export const vueI18nMessageProjectionSchema =
  v.custom<VueI18nMessageProjection>(
    (value) => v.safeParse(vueI18nMessageProjectionShapeSchema, value).success,
    "Vue I18n 消息投影结构无效。",
  );

export type VueI18nSourceMessage = VueI18nMessageProjection["source"];
export type VueI18nTargetMessage = VueI18nMessageProjection["target"];

/** 共用投影只依赖 QA 事实、候选及关系，不读取检查专属配置。 */
export type VueI18nProjectionInput<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable = never,
> = Omit<
  QualityCheckInput<TUnit, TTranslation, unknown, TBody, TUnavailable>,
  "configuration"
>;

export type VueI18nProjector<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable = never,
> = (
  input: VueI18nProjectionInput<TUnit, TTranslation, TBody, TUnavailable>,
) => VueI18nMessageProjection;

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
