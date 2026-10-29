import type { MemoScope } from "@lioni/memo";
import type { TemplateSignature } from "@lioni/text-analysis";
import { z } from "zod";

import type { VueI18nCheckData, VueI18nPolicy } from "./quality-types.ts";
import { createVueI18nTargetEquivalence } from "./scope.ts";

type VueI18nInput = {
  readonly dependencies: unknown;
  readonly memo: MemoScope;
};

export type ResolvedVueI18nDependencies = {
  readonly policies: ReadonlyMap<string, VueI18nPolicy>;
  readonly terms: VueI18nCheckData["terms"];
  readonly targetEquivalences: ReadonlyMap<
    string,
    (signature: TemplateSignature) => string
  >;
};

/** 按自有条目验证字典，避免对象键处理跳过 __proto__ 对应的值。 */
function dictionarySchema<TSchema extends z.ZodType>(valueSchema: TSchema) {
  return z.preprocess(
    (value) =>
      value !== null && typeof value === "object" && !Array.isArray(value)
        ? new Map(Object.entries(value))
        : value,
    z.map(z.string(), valueSchema),
  );
}

const quantityOptionsSchema = z.object({
  aliases: dictionarySchema(z.string()).optional(),
  defaultUnit: z.string().optional(),
  ignoredLiterals: z.array(z.string()).optional(),
});
const quantityPolicySchema = quantityOptionsSchema.extend({
  profile: z.string().optional(),
  byKey: dictionarySchema(quantityOptionsSchema).optional(),
});
const resourceSchema = z.object({
  messages: dictionarySchema(z.string()),
  range: z.unknown(),
});
const dependenciesSchema = z.object({
  vueI18n: z.object({
    policies: z
      .array(
        z.object({
          sourceLanguage: z.string(),
          targetLanguage: z.string(),
          resources: z.object({
            source: resourceSchema,
            target: resourceSchema,
          }),
          quantities: z
            .object({
              source: quantityPolicySchema,
              target: quantityPolicySchema,
            })
            .optional(),
          protectedLiterals: dictionarySchema(z.array(z.string())),
          messageFamilies: z.object({
            scopes: z.array(
              z.object({
                scope: z.string(),
                keys: z.array(z.string()).optional(),
                keyPattern: z.string().optional(),
                flags: z.string().optional(),
              }),
            ),
            targetEquivalences: z.array(z.array(z.string())),
          }),
        }),
      )
      .superRefine((policies, context) => {
        const languages = new Set<string>();
        policies.forEach((policy, index) => {
          if (languages.has(policy.targetLanguage))
            context.addIssue({
              code: "custom",
              path: [index, "targetLanguage"],
              message: "Vue I18n 策略的目标语言必须唯一。",
            });
          languages.add(policy.targetLanguage);
        });
      }),
    // 术语领域结构由 createTermbase 正式入口校验，依赖层仅负责容器形状。
    terms: z.looseObject({ concepts: z.array(z.unknown()) }),
  }),
});

function readDependencies(value: unknown): ResolvedVueI18nDependencies {
  const parsed = dependenciesSchema.safeParse(value);
  if (!parsed.success)
    throw new TypeError(
      parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("；"),
    );
  // 使用原数据保留资源字典的特殊键和宿主扩展字段。
  const { vueI18n } = value as { readonly vueI18n: VueI18nCheckData };
  const { policies } = vueI18n;

  const byLanguage = new Map<string, VueI18nPolicy>();
  const targetEquivalences = new Map<
    string,
    (signature: TemplateSignature) => string
  >();
  for (const policy of policies) {
    byLanguage.set(policy.targetLanguage, policy);
    targetEquivalences.set(
      policy.targetLanguage,
      createVueI18nTargetEquivalence(policy.messageFamilies.targetEquivalences),
    );
  }

  return {
    policies: byLanguage,
    terms: vueI18n.terms,
    targetEquivalences,
  };
}

/** 在同次质量运行内共享已校验的 Vue 规则索引。 */
export function vueI18nDependencies(input: VueI18nInput) {
  const resolve = input.memo.memo(readDependencies);
  return resolve(input.dependencies);
}
