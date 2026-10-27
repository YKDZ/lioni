import { createSignatureEquivalence, signatureKey } from "@lioni/text-analysis";
import type { TemplateSignature } from "@lioni/text-analysis";

import type { VueI18nPolicy } from "./quality-types.ts";
import type { VueI18nUsageIndex } from "./usage-types.ts";

/** 按显式键、正则或调用点归属选择消息族；无法唯一归属时单独成组。 */
export function createVueI18nScopeResolver(
  policy: VueI18nPolicy,
  usages: VueI18nUsageIndex,
): (key: string) => string {
  const scopes = policy.messageFamilies.scopes.map((rule) => ({
    ...rule,
    pattern:
      rule.keyPattern === undefined
        ? undefined
        : new RegExp(rule.keyPattern, rule.flags),
  }));
  const usageScopes = policy.messageFamilies.usageScopes.map((rule) => ({
    scope: rule.scope,
    pattern: new RegExp(rule.filePattern, "u"),
  }));

  return (key) => {
    for (const rule of scopes)
      if (rule.keys?.includes(key) || rule.pattern?.test(key))
        return rule.scope;
    const domains = new Set(
      usages.entries
        .filter((usage) => usage.key === key)
        .map(
          (usage) =>
            usageScopes.find((rule) => rule.pattern.test(usage.file))?.scope,
        )
        .filter((scope) => scope !== undefined),
    );
    return domains.size === 1 ? [...domains][0]! : `unclassified:${key}`;
  };
}

/** 仅将声明的完整纯文本签名折叠到同一等价键。 */
export function createVueI18nTargetEquivalence(
  groups: readonly (readonly string[])[],
): (signature: TemplateSignature) => string {
  const signatures = groups.map((group) =>
    group.map((text): TemplateSignature => ({
      parts: [{ type: "text", text }],
      slots: [],
    })),
  );
  const equivalentKey = createSignatureEquivalence(signatures);

  return (signature) =>
    signature.parts.every((part) => part.type === "text")
      ? equivalentKey(signature)
      : signatureKey(signature);
}
