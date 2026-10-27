import {
  defineQualityCheck,
  type QualityCheckDefinition,
  type QualityCheckOutcome,
  type QualityFinding,
  type QualityObject,
  type StandardSchemaV1,
} from "@lioni/core";
import type { VueI18nPolicy } from "@lioni/vue-i18n";

import type { Body, Translation, Unit } from "./model.ts";

type PolicySnapshot = {
  readonly policies: readonly VueI18nPolicy[];
};

const configurationSchema: StandardSchemaV1<
  { readonly version: 1 },
  { readonly version: 1 }
> = {
  "~standard": {
    version: 1,
    vendor: "uptime-kuma-resource-contract",
    validate(value) {
      return isRecord(value) && value.version === 1
        ? { value: { version: 1 } }
        : { issues: [{ message: "Kuma 资源检查配置无效。" }] };
    },
  },
};

export function createResourceContractCheck(
  snapshot: PolicySnapshot,
): QualityCheckDefinition<Unit, Translation, QualityObject, Body, never> {
  const policies = new Map(
    snapshot.policies.map((policy) => [policy.targetLanguage, policy]),
  );

  return defineQualityCheck<
    Unit,
    Translation,
    typeof configurationSchema,
    QualityObject,
    Body,
    never
  >({
    id: "kuma/resource-contract",
    version: "kuma/resource-contract/v2",
    configurationSchema,
    configuration: { version: 1 },
    check(input): QualityCheckOutcome {
      const language = input.candidate.language;
      const policy = policies.get(language);
      if (policy === undefined) return notApplicable();

      const key = input.candidate.sourceKey;
      const source = input.sourceUnit?.unit.source.text ?? "";
      const target = input.candidate.content.text;
      const findings = resourceFindings(key, target, policy);
      const targetLocation = {
        language,
        range: policy.resources.target.range,
        key,
      };
      const sourceLocation = {
        language: policy.sourceLanguage,
        range: policy.resources.source.range,
        key,
      };
      const diagnostics: QualityFinding[] = findings.map((finding) => ({
        severity: finding.severity ?? "error",
        object: {
          kind: "translation-unit",
          key,
          language,
          code: finding.code,
        },
        location: targetLocation,
        message: finding.message,
        evidence: [
          {
            role: "source",
            object: { kind: "source", key },
            location: sourceLocation,
            value: source,
          },
          {
            role: "target",
            object: { kind: "translation", key, language },
            location: targetLocation,
            value: target,
          },
        ],
      }));
      return {
        status: "complete",
        diagnostics,
        issues: [],
        coverage: {
          selected: 1,
          evaluated: 1,
          notApplicable: 0,
          incomplete: 0,
          failed: 0,
        },
      };
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resourceFindings(
  key: string,
  target: string,
  policy: VueI18nPolicy,
): readonly {
  readonly code: string;
  readonly message: string;
  readonly severity?: "error" | "warning";
}[] {
  const hasSource = Object.hasOwn(policy.resources.source.messages, key);
  const hasTarget = Object.hasOwn(policy.resources.target.messages, key);
  if (!hasSource && !hasTarget)
    return [
      {
        code: "used-key-missing",
        severity: "warning",
        message:
          "调用点使用了资源中未定义的静态消息键，需确认是否有意使用原键回退。",
      },
    ];
  if (!hasSource)
    return [
      {
        code: "target-only-key",
        severity: "warning",
        message:
          "该目标语言键没有源文定义，需核对调用点与资源归属，不能直接删除。",
      },
    ];
  if (!hasTarget)
    return [
      {
        code: "missing-translation",
        severity: "warning",
        message: "目标资源缺少此键，需要核对应用的回退显示。",
      },
    ];
  if (!target.trim())
    return [{ code: "empty-translation", message: "目标资源值为空。" }];
  return [];
}

function notApplicable(): QualityCheckOutcome {
  return {
    status: "not-applicable",
    diagnostics: [],
    issues: [],
    coverage: {
      selected: 1,
      evaluated: 0,
      notApplicable: 1,
      incomplete: 0,
      failed: 0,
    },
  };
}
