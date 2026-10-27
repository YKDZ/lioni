import type { Pair, Policy, Project, Finding } from "../model.ts";
import { textRule } from "./text-rule.ts";
export function resourceContract(
  pair: Pair,
  policy: Policy,
): readonly Finding[] {
  if (!(pair.key in policy.source) && !(pair.key in policy.target))
    return [
      {
        code: "used-key-missing",
        severity: "warning",
        message:
          "调用点使用了资源中未定义的静态消息键，需确认是否有意使用原键回退。",
      },
    ];
  if (!(pair.key in policy.source))
    return [
      {
        code: "target-only-key",
        severity: "warning",
        message:
          "该目标语言键没有源文定义，需核对调用点与资源归属，不能直接删除。",
      },
    ];
  if (!(pair.key in policy.target))
    return [
      {
        code: "missing-translation",
        severity: "warning",
        message: "目标资源缺少此键，需要核对应用的回退显示。",
      },
    ];
  if (!pair.target.trim())
    return [{ code: "empty-translation", message: "目标资源值为空。" }];
  return [];
}

export function createResourceContractCheck(project: Project) {
  return textRule("kuma/resource-contract", project, resourceContract, {
    version: "kuma/resource-contract/v1",
    inventory: true,
  });
}
