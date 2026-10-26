import type { Pair, Policy, Project, Finding } from "../model.ts";
import { textRule } from "./text-rule.ts";
export function literalContract(
  pair: Pair,
  policy: Policy,
): readonly Finding[] {
  return (policy.literals[pair.key] ?? [])
    .filter(
      (value) =>
        pair.source.includes(value) &&
        !new RegExp(
          `(?<![A-Za-z0-9_])${value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?![A-Za-z0-9_])`,
          "u",
        ).test(pair.target),
    )
    .map((value) => ({
      code: "protected-literal-missing",
      message: `译文没有保留技术字面值 ${value}。`,
    }));
}

export function createProtectedLiteralsCheck(project: Project) {
  return textRule("kuma/protected-literals", project, literalContract, {
    appliesTo: (pair, policy) => (policy.literals[pair.key]?.length ?? 0) > 0,
  });
}
