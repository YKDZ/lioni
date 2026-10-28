import type { MemoScope } from "@lioni/memo";
import type { TemplateSignature } from "@lioni/text-analysis";

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

function readDependencies(value: unknown): ResolvedVueI18nDependencies {
  const root = record(value);
  const vueI18n = record(root?.vueI18n);
  const policies = vueI18n?.policies;
  const terms = record(vueI18n?.terms);
  if (!Array.isArray(policies) || terms === undefined)
    throw new TypeError(
      "quality.loadDependencies 必须返回 vueI18n.policies 和 vueI18n.terms。",
    );

  const byLanguage = new Map<string, VueI18nPolicy>();
  const targetEquivalences = new Map<
    string,
    (signature: TemplateSignature) => string
  >();
  for (const policyValue of policies) {
    const policy = record(policyValue);
    if (policy === undefined || typeof policy.targetLanguage !== "string")
      throw new TypeError("Vue I18n 检查策略必须包含 targetLanguage。");
    if (byLanguage.has(policy.targetLanguage))
      throw new TypeError("Vue I18n 策略的目标语言必须唯一。");
    byLanguage.set(policy.targetLanguage, policyValue as VueI18nPolicy);
    targetEquivalences.set(
      policy.targetLanguage,
      createVueI18nTargetEquivalence(
        (policyValue as VueI18nPolicy).messageFamilies.targetEquivalences,
      ),
    );
  }

  return {
    policies: byLanguage,
    terms: vueI18n!.terms as VueI18nCheckData["terms"],
    targetEquivalences,
  };
}

/** 在同次质量运行内共享已校验的 Vue 规则索引。 */
export function vueI18nDependencies(input: VueI18nInput) {
  const resolve = input.memo.memo(readDependencies);
  return resolve(input.dependencies);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
