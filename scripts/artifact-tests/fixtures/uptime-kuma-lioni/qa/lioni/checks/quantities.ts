import { parseVueI18nMessage } from "@lioni/checks";
import type { VueI18nMessage } from "@lioni/checks";

import type { Pair, Policy, Finding, Project } from "../model.ts";
import { quantityProfile } from "../quantities/index.ts";
import type { QuantityProfile, QuantityOptions } from "../quantities/index.ts";
import { textRule } from "./text-rule.ts";

export function quantityCapability(policy: Policy): string | undefined {
  if (!quantityProfile(policy.sourceQuantityProfile, policy.sourceLanguage))
    return `源语言 ${policy.sourceLanguage} 没有已声明的数值分析能力。`;
  if (!quantityProfile(policy.targetQuantityProfile, policy.targetLanguage))
    return `目标语言 ${policy.targetLanguage} 没有已声明的数值分析能力。`;
  return undefined;
}

function branchFacts(
  profile: QuantityProfile,
  message: VueI18nMessage,
  text: string,
  branch: VueI18nMessage["branches"][number],
  options: QuantityOptions,
): Set<string> {
  const values = profile.facts(branch.text, options);
  for (const token of message.tokens) {
    if (token.start < branch.range.start || token.end > branch.range.end)
      continue;
    const unit = profile.unitAfter(text.slice(token.end), options);
    if (!unit) continue;
    values.add(`变量单位:${token.identity}:${unit}`);
  }
  return values;
}

/** 语言算法提供数值事实，检查器只比较分支与变量的语义。 */
export function quantityContract(
  pair: Pair,
  policy: Policy,
): readonly Finding[] {
  const sourceProfile = quantityProfile(
    policy.sourceQuantityProfile,
    policy.sourceLanguage,
  );
  const targetProfile = quantityProfile(
    policy.targetQuantityProfile,
    policy.targetLanguage,
  );
  if (!sourceProfile || !targetProfile)
    throw new Error(quantityCapability(policy));
  const source = parseVueI18nMessage(pair.source),
    target = parseVueI18nMessage(pair.target);
  if (source.errors.length || target.errors.length) return [];
  const sourceOptions: QuantityOptions = {
    aliases: policy.quantityUnitAliases?.[pair.key] ?? {},
    ignoredLiterals: policy.sourceQuantityIgnoredLiterals?.[pair.key] ?? [],
    ...(policy.quantityDefaultUnits?.[pair.key] === undefined
      ? {}
      : { defaultUnit: policy.quantityDefaultUnits[pair.key] }),
  };
  const targetOptions: QuantityOptions = {
    aliases: policy.targetQuantityUnitAliases?.[pair.key] ?? {},
    ignoredLiterals: policy.targetQuantityIgnoredLiterals?.[pair.key] ?? [],
    ...(policy.targetQuantityDefaultUnits?.[pair.key] === undefined
      ? {}
      : { defaultUnit: policy.targetQuantityDefaultUnits[pair.key] }),
  };
  const sourceFacts = source.branches.map((branch) =>
    branchFacts(sourceProfile, source, pair.source, branch, sourceOptions),
  );
  const findings: Finding[] = [];
  for (const [index, branch] of target.branches.entries()) {
    const targetFacts = branchFacts(
      targetProfile,
      target,
      pair.target,
      branch,
      targetOptions,
    );
    const candidates = sourceFacts.map((facts) => ({
      missing: [...facts].filter((value) => !targetFacts.has(value)),
      extra: facts.size
        ? [...targetFacts].filter((value) => !facts.has(value))
        : [],
    }));
    if (
      candidates.some(
        (candidate) => !candidate.missing.length && !candidate.extra.length,
      )
    )
      continue;
    const best = candidates.toSorted(
      (a, b) =>
        a.missing.length + a.extra.length - b.missing.length - b.extra.length,
    )[0]!;
    if (best.missing.length || best.extra.length)
      findings.push({
        code: "quantity-mismatch",
        message: `译文分支 ${index + 1} 的数值或时间单位与原文不对应。`,
        details: best,
      });
  }
  return findings;
}

export function createQuantityCheck(project: Project) {
  return textRule("kuma/quantities", project, quantityContract, {
    version: `kuma/quantities/v2+@intlify/message-compiler@11.2.8`,
    capability: quantityCapability,
  });
}
