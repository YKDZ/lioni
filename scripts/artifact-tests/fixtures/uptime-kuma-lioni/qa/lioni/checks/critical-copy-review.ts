import type { Pair, Policy, Project, Finding } from "../model.ts";
import { textRule } from "./text-rule.ts";
export function criticalReview(pair: Pair, policy: Policy): readonly Finding[] {
  const baseline = policy.reviews[pair.key];
  if (!baseline) return [];
  if (pair.source !== baseline.source)
    return [
      {
        code: "critical-source-changed",
        severity: "warning",
        message: "高风险源文已变化，需要重新审定目标语言基线。",
        details: { reason: baseline.reason },
      },
    ];
  if (baseline.approvedTargets.includes(pair.target)) return [];
  return [
    {
      code: "critical-review-required",
      severity: "warning",
      message: "高风险译文尚未符合本轮审定基线，需要人工复核。",
      details: {
        reason: baseline.reason,
        approvedTargets: baseline.approvedTargets,
      },
    },
  ];
}

export function createCriticalCopyReviewCheck(project: Project) {
  return textRule("kuma/critical-copy-review", project, criticalReview, {
    appliesTo: (pair, policy) => Object.hasOwn(policy.reviews, pair.key),
  });
}
