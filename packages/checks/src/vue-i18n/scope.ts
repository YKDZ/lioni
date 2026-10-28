import { createSignatureEquivalence, signatureKey } from "@lioni/text-analysis";
import type { TemplateSignature } from "@lioni/text-analysis";

import type { VueI18nPolicy } from "./quality-types.ts";

/** 按显式键或正则选择消息族；未声明的键各自单独成组。 */
export function createVueI18nScopeResolver(
  policy: VueI18nPolicy,
): (key: string) => string {
  const scopes = policy.messageFamilies.scopes.map((rule) => ({
    ...rule,
    pattern:
      rule.keyPattern === undefined
        ? undefined
        : new RegExp(rule.keyPattern, rule.flags),
  }));
  return (key) => {
    for (const rule of scopes)
      if (rule.keys?.includes(key) || rule.pattern?.test(key))
        return rule.scope;
    return `unclassified:${key}`;
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
