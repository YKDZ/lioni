import {
  createSignatureEquivalence,
  signatureKey,
  type TemplateSignature,
} from "@lioni/text-analysis";

import type { Policy } from "../model.ts";

/** 业务归属来自项目声明；无法明确判断的消息单独成组。 */
export function createScopeResolver(policy: Policy) {
  const scopes = policy.scopes.map((rule) => ({
    ...rule,
    pattern:
      rule.keyPattern === undefined
        ? undefined
        : new RegExp(rule.keyPattern, rule.flags),
  }));
  const usageScopes = policy.usageScopes.map((rule) => ({
    scope: rule.scope,
    pattern: new RegExp(rule.filePattern, "u"),
  }));
  return (key: string): string => {
    for (const rule of scopes)
      if (rule.keys?.includes(key) || rule.pattern?.test(key))
        return rule.scope;
    const domains = new Set(
      policy.usages.entries
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

/** 只规范化声明过的完整纯文本签名，原始消息文本仍保留为证据。 */
export function createTargetSignatureEquivalence(
  groups: readonly (readonly string[])[],
) {
  const signatures = groups.map((group) =>
    group.map((text): TemplateSignature => ({
      parts: [{ type: "text", text }],
      slots: [],
    })),
  );
  const equivalentKey = createSignatureEquivalence(signatures);
  const byKey = new Map(
    signatures.flat().map((signature) => [signatureKey(signature), signature]),
  );
  return (signature: TemplateSignature): TemplateSignature => {
    if (!signature.parts.every((part) => part.type === "text"))
      return signature;
    const canonical = byKey.get(equivalentKey(signature));
    return canonical === undefined
      ? signature
      : { ...signature, parts: canonical.parts.map((part) => ({ ...part })) };
  };
}
