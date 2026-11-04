import { StandardSchemaContractError } from "@lioni/core";
import { z } from "zod";

import type {
  VueI18nLanguagePolicy,
  VueI18nPolicyData,
  VueI18nPolicy,
  VueI18nPolicyRequirement,
} from "./quality-types.ts";
import { createVueI18nTargetEquivalence } from "./scope.ts";

export type ResolvedVueI18nPolicies = {
  readonly policies: ReadonlyMap<string, VueI18nPolicy>;
  readonly targetEquivalences: ReadonlyMap<
    string,
    (signature: import("@lioni/text-analysis").TemplateSignature) => string
  >;
};

/** 将缺少必需读取器报告为宿主契约错误，且只在依赖它的检查项被选中时触发。 */
export function missingVueI18nData<TValue>(description: string): () => TValue {
  return () => {
    throw new StandardSchemaContractError(
      description,
      "schema-mismatch",
      `${description}未提供。`,
    );
  };
}

/** 按字典自有条目验证消息资源，避免对象键处理跳过 __proto__ 对应的值。 */
function dictionarySchema<TSchema extends z.ZodType>(valueSchema: TSchema) {
  return z.preprocess(
    (value) =>
      value !== null && typeof value === "object" && !Array.isArray(value)
        ? new Map(Object.entries(value))
        : value,
    z.map(z.string(), valueSchema),
  );
}

const languagePoliciesSchema = z
  .array(
    z.object({
      sourceLanguage: z.string(),
      targetLanguage: z.string(),
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
  });

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
const resourcesSchema = z.object({
  source: resourceSchema,
  target: resourceSchema,
});
const quantitiesSchema = z.object({
  source: quantityPolicySchema,
  target: quantityPolicySchema,
});
const protectedLiteralsSchema = dictionarySchema(z.array(z.string()));
const messageFamiliesSchema = z.object({
  scopes: z.array(
    z.object({
      scope: z.string(),
      keys: z.array(z.string()).optional(),
      keyPattern: z.string().optional(),
      flags: z.string().optional(),
    }),
  ),
  targetEquivalences: z.array(z.array(z.string())),
});

function validate<TSchema extends z.ZodType>(
  schema: TSchema,
  value: unknown,
  description: string,
  pathPrefix: readonly PropertyKey[] = [],
): z.output<TSchema> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.map((issue) => ({
    message: issue.message,
    path: [...pathPrefix, ...issue.path],
  }));
  const details = issues
    .map(({ path, message }) => `${path.join(".")}: ${message}`)
    .join("；");
  throw new StandardSchemaContractError(
    description,
    "schema-mismatch",
    `${description}格式无效：${details}`,
    issues,
  );
}

/** 语法、变量和术语只读取语言范围，不要求其余策略或术语容器。 */
export function readVueI18nLanguagePolicies(value: unknown) {
  const policies = validate(languagePoliciesSchema, value, "Vue I18n 语言策略");
  return new Map<string, VueI18nLanguagePolicy>(
    policies.map((policy) => [policy.targetLanguage, policy]),
  );
}

/** 校验策略公共身份和所选消费者声明的策略片段。 */
export function readVueI18nPolicies(
  value: unknown,
  requirements: readonly VueI18nPolicyRequirement[],
): ReadonlyMap<string, VueI18nPolicy> {
  validate(languagePoliciesSchema, value, "Vue I18n 策略语言范围");
  const policies = value as readonly VueI18nPolicyData[];
  policies.forEach((policy, index) => {
    const prefix = `Vue I18n 策略 ${index + 1}`;
    if (requirements.includes("resources"))
      validate(resourcesSchema, policy.resources, `${prefix} 消息资源`, [
        "resources",
      ]);
    if (requirements.includes("quantities") && policy.quantities !== undefined)
      validate(quantitiesSchema, policy.quantities, `${prefix} 数量策略`, [
        "quantities",
      ]);
    if (
      requirements.includes("protectedLiterals") &&
      policy.protectedLiterals !== undefined
    )
      validate(
        protectedLiteralsSchema,
        policy.protectedLiterals,
        `${prefix} 受保护字面值策略`,
        ["protectedLiterals"],
      );
    if (requirements.includes("messageFamilies"))
      validate(
        messageFamiliesSchema,
        policy.messageFamilies,
        `${prefix} 消息族策略`,
        ["messageFamilies"],
      );
  });
  return new Map(
    policies.map((policy) => [
      policy.targetLanguage,
      {
        ...policy,
        protectedLiterals: policy.protectedLiterals ?? {},
      } as VueI18nPolicy,
    ]),
  );
}

/** 只为消息族消费者构造目标等价索引。 */
export function readVueI18nFamilyPolicies(value: unknown) {
  const policies = readVueI18nPolicies(value, ["messageFamilies"]);
  const targetEquivalences = new Map<
    string,
    (signature: import("@lioni/text-analysis").TemplateSignature) => string
  >();
  for (const policy of policies.values())
    targetEquivalences.set(
      policy.targetLanguage,
      createVueI18nTargetEquivalence(
        policy.messageFamilies!.targetEquivalences,
      ),
    );
  return { policies, targetEquivalences } satisfies ResolvedVueI18nPolicies;
}
