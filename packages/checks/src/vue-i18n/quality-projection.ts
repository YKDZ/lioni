import type {
  QualityCheckInput,
  StandardSchemaV1,
  TranslationUnitInput,
} from "@lioni/core";
import { z } from "zod";

const sourceMessageSchema = z.discriminatedUnion("status", [
  z.looseObject({ status: z.literal("available"), text: z.string() }),
  z.looseObject({ status: z.literal("unavailable") }),
  z.looseObject({ status: z.literal("absent") }),
]);
const targetMessageSchema = z.discriminatedUnion("status", [
  z.looseObject({ status: z.literal("available"), text: z.string() }),
  z.looseObject({ status: z.literal("unavailable") }),
  z.looseObject({ status: z.literal("missing") }),
]);
const qualityLocationSchema = z
  .looseObject({
    language: z.string().nullable(),
    range: z.unknown(),
    key: z.string().optional(),
  })
  .refine((value) => Object.hasOwn(value, "range"), {
    path: ["range"],
    message: "Vue I18n 消息位置必须显式提供 range。",
  });
const projectionShape = z.looseObject({
  key: z.string(),
  language: z.string(),
  source: sourceMessageSchema,
  target: targetMessageSchema,
  locations: z.looseObject({
    source: qualityLocationSchema,
    target: qualityLocationSchema,
  }),
});

type MessageLocation = {
  readonly language: string | null;
  readonly range: unknown;
  readonly key?: string;
  readonly [key: string]: unknown;
};
export type VueI18nMessageProjection = {
  readonly key: string;
  readonly language: string;
  readonly source: (
    | { readonly status: "available"; readonly text: string }
    | { readonly status: "unavailable" }
    | { readonly status: "absent" }
  ) &
    Readonly<Record<string, unknown>>;
  readonly target: (
    | { readonly status: "available"; readonly text: string }
    | { readonly status: "unavailable" }
    | { readonly status: "missing" }
  ) &
    Readonly<Record<string, unknown>>;
  readonly locations: {
    readonly source: MessageLocation;
    readonly target: MessageLocation;
    readonly [key: string]: unknown;
  };
  readonly [key: string]: unknown;
};

/** Zod 负责结构验证；保留原投影，避免对象复制丢失位置上的特殊扩展键。 */
export const vueI18nMessageProjectionSchema: StandardSchemaV1<
  VueI18nMessageProjection,
  VueI18nMessageProjection
> = {
  "~standard": {
    version: 1,
    vendor: "lioni-vue-i18n",
    validate(value) {
      const result = projectionShape.safeParse(value);
      return result.success
        ? { value: value as VueI18nMessageProjection }
        : {
            issues: result.error.issues.map((issue) => ({
              message: issue.message,
              path: issue.path.map((key) =>
                typeof key === "symbol" ? String(key) : key,
              ),
            })),
          };
    },
  },
};

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
