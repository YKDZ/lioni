import type {
  CheckerPrepareInput,
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

const projectionKey = <
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  input: VueI18nPrepareInput<TUnit, TTranslation, TBody, TUnavailable>,
) => [input.facts, input.candidate, input.sourceUnit, input.relationships];

/** 准备适配保留原始源译单元，但不暴露检查专属加载资料。 */
export type VueI18nPrepareInput<
  TUnit extends TranslationUnitInput = TranslationUnitInput,
  TTranslation = unknown,
  TBody = unknown,
  TUnavailable = never,
> = Omit<
  CheckerPrepareInput<TUnit, TTranslation, TBody, TUnavailable, unknown>,
  "loaded"
>;

export type VueI18nPreparer<
  TUnit extends TranslationUnitInput = TranslationUnitInput,
  TTranslation = unknown,
  TBody = unknown,
  TUnavailable = never,
> = (
  input: VueI18nPrepareInput<TUnit, TTranslation, TBody, TUnavailable>,
) => import("@lioni/core").Awaitable<
  import("@lioni/core").CheckerPreparation<VueI18nMessageProjection>
>;

/** 默认只提取字符串；各项检查自行判断所需一侧的正文可用性。 */
export function prepareVueI18nMessage<
  TUnit extends TranslationUnitInput,
  TTranslation,
  TBody,
  TUnavailable,
>(
  input: VueI18nPrepareInput<TUnit, TTranslation, TBody, TUnavailable>,
  adapter?: VueI18nPreparer<TUnit, TTranslation, TBody, TUnavailable>,
): import("@lioni/core").Awaitable<
  import("@lioni/core").CheckerPreparation<VueI18nMessageProjection>
> {
  if (adapter) {
    // Omit 仅影响静态类型；运行时仍需移除通用检查器交接的加载资料。
    const { loaded: _loaded, ...context } = input as typeof input & {
      readonly loaded?: unknown;
    };
    return (async () => {
      const prepared = await input.memo.memo(adapter, { key: projectionKey })(
        context,
      );
      if (
        prepared.status === "ready" &&
        (prepared.input.key !== input.candidate.sourceKey ||
          prepared.input.language !== input.candidate.language)
      )
        return {
          status: "incomplete" as const,
          issue: {
            code: "messageProjectionIdentityMismatch",
            message: "消息准备结果的键或语言与本次候选不一致。",
          },
        };
      return prepared;
    })();
  }
  const source = input.sourceUnit.unit.source;
  return {
    status: "ready",
    input: {
      key: input.candidate.sourceKey,
      language: input.candidate.language,
      source:
        input.sourceUnit.bodyAvailability === "available" &&
        typeof source === "string"
          ? { status: "available", text: source }
          : { status: "unavailable" },
      target:
        typeof input.candidate.content === "string"
          ? { status: "available", text: input.candidate.content }
          : { status: "unavailable" },
      locations: {
        source: {
          language: null,
          key: input.candidate.sourceKey,
          range:
            input.facts.source.read.scopes[input.sourceUnit.scopeIndex]
              ?.range ?? null,
        },
        target: {
          language: input.candidate.language,
          key: input.candidate.sourceKey,
          range: input.translation?.range ?? null,
        },
      },
    },
  };
}

/** 普通参数在装配时校验，检查项筛选不能推迟这些错误。 */
export function assertVueI18nPreparer(adapter: unknown): void {
  if (adapter !== undefined && typeof adapter !== "function")
    throw new TypeError("Vue I18n 准备适配必须是函数。");
}
