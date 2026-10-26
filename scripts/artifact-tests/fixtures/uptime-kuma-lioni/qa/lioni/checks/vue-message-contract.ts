import { parseMessage } from "../message.ts";
import type { Pair, Policy, Project, Finding } from "../model.ts";
import { textRule } from "./text-rule.ts";
export function messageContract(
  pair: Pair,
  policy: Policy,
): readonly Finding[] {
  if (!(pair.key in policy.target) || !pair.target.trim()) return [];
  const source = parseMessage(pair.source),
    target = parseMessage(pair.target);
  if (target.errors.length)
    return [
      {
        code: "message-syntax",
        message: "译文不能由项目的 Vue I18n 编译器解析。",
        severity: pair.key in policy.source ? "error" : "warning",
        details: target.errors,
      },
    ];
  if (!(pair.key in policy.source)) return [];
  if (source.errors.length)
    return [
      {
        code: "source-message-syntax",
        severity: "warning",
        message: "源文消息语法有误，无法据此可靠核对译文变量。",
        details: source.errors,
      },
    ];
  const allowed = new Set(source.branches.flatMap((b) => b.variables));
  const plural = source.branches.length > 1;
  const normalizedVariable = (v: string) =>
    plural && ["named:n", "named:count"].includes(v) ? "plural-value" : v;
  const required = [
    ...new Set((source.branches[0]?.variables ?? []).map(normalizedVariable)),
  ].filter((v) =>
    source.branches.every((b) =>
      b.variables.some((x) => normalizedVariable(x) === v),
    ),
  );
  if (plural) {
    allowed.add("named:n");
    allowed.add("named:count");
  }
  const usages = policy.usages.entries.filter((u) => u.key === pair.key);
  const findings: Finding[] = [];
  for (const [index, branch] of target.branches.entries()) {
    const vars = new Set(branch.variables);
    for (const variable of required) {
      if (
        vars.has(variable) ||
        (plural &&
          ["named:n", "named:count", "plural-value"].includes(variable) &&
          ["named:n", "named:count"].some((v) => vars.has(v)))
      )
        continue;
      findings.push({
        code: "missing-message-variable",
        message: `译文分支 ${index + 1} 缺少变量 ${variable}。`,
      });
    }
    for (const variable of vars) {
      const availableInCalls =
        usages.some(
          (u) => u.parametersKnown && u.supplied.includes(variable),
        ) &&
        usages.every(
          (u) => !u.parametersKnown || u.supplied.includes(variable),
        );
      if (!allowed.has(variable) && !availableInCalls)
        findings.push({
          code: "unexpected-message-variable",
          message: `译文使用了无对应输入的变量 ${variable}。`,
        });
      for (const usage of usages) {
        if (
          usage.parametersKnown &&
          !usage.supplied.includes(variable) &&
          !(
            plural &&
            ["named:n", "named:count"].includes(variable) &&
            usage.supplied.includes("plural")
          )
        ) {
          findings.push({
            code: "call-argument-missing",
            message: `调用点 ${usage.file} 没有提供译文所需变量 ${variable}。`,
            details: usage,
          });
        }
      }
    }
  }
  for (const key of target.links)
    if (!(key in policy.source) && !(key in policy.target))
      findings.push({
        code: "missing-linked-message",
        message: `关联消息 ${key} 不存在。`,
      });
  const active = new Set<string>();
  const done = new Set<string>();
  function cycle(key: string): boolean {
    if (active.has(key)) return true;
    if (done.has(key)) return false;
    active.add(key);
    const text =
      key === pair.key
        ? pair.target
        : (policy.target[key] ?? policy.source[key]);
    if (text !== undefined)
      for (const linked of parseMessage(text).links)
        if (cycle(linked)) return true;
    active.delete(key);
    done.add(key);
    return false;
  }
  if (cycle(pair.key))
    findings.push({
      code: "linked-message-cycle",
      message: "关联消息形成循环引用。",
    });
  return [
    ...new Map(findings.map((f) => [`${f.code}:${f.message}`, f])).values(),
  ];
}

export function createMessageContractCheck(project: Project) {
  return textRule("kuma/vue-message-contract", project, messageContract, {
    inventory: true,
  });
}
