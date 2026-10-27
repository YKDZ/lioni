import { bindQualityCheck } from "@lioni/core";
import type {
  QualityFinding,
  QualityCheckDefinition,
  StandardSchemaV1,
} from "@lioni/core";

import type {
  Unit,
  Translation,
  Body,
  Pair,
  Policy,
  Project,
  Finding,
} from "../model.ts";
const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
function schema<T>(validate: (v: unknown) => v is T): StandardSchemaV1<T, T> {
  return {
    "~standard": {
      version: 1,
      vendor: "kuma-localization",
      validate: (v) =>
        validate(v)
          ? { value: v }
          : { issues: [{ message: "Kuma 检查输入结构无效。" }] },
    },
  };
}
const pairSchema = schema<Pair>(
  (v): v is Pair =>
    record(v) &&
    typeof v.key === "string" &&
    typeof v.source === "string" &&
    typeof v.target === "string" &&
    typeof v.language === "string",
);
const configSchema = schema<{ version: 1 }>(
  (v): v is { version: 1 } => record(v) && v.version === 1,
);
export function textRule(
  id: string,
  project: Project,
  evaluate: (pair: Pair, policy: Policy) => readonly Finding[],
  options: {
    version: string;
    inventory?: boolean;
    appliesTo?: (pair: Pair, policy: Policy) => boolean;
    capability?: (policy: Policy) => string | undefined;
  },
): QualityCheckDefinition<
  Unit,
  Translation,
  import("@lioni/core").QualityObject,
  Body,
  never
> {
  const policies = new Map(
    project.policies.map((policy) => [policy.targetLanguage, policy]),
  );
  return bindQualityCheck({
    id,
    version: options.version,
    configurationSchema: configSchema,
    configuration: { version: 1 },
    inputSchema: pairSchema,
    select: (input) => {
      const policy = policies.get(input.candidate.language);
      if (
        !policy ||
        (!options.inventory &&
          (input.sourceUnit === null || !input.candidate.content.text.trim()))
      )
        return { status: "not-applicable" };
      const subject: Pair = {
        key: input.candidate.sourceKey,
        source: input.sourceUnit?.unit.source.text ?? "",
        target: input.candidate.content.text,
        language: input.candidate.language,
      };
      return options.appliesTo && !options.appliesTo(subject, policy)
        ? { status: "not-applicable" }
        : { status: "selected", subject };
    },
    project: (input) => {
      const policy = policies.get(input.subject.language)!;
      const reason = options.capability?.(policy);
      return reason === undefined
        ? { status: "ready", value: input.subject }
        : {
            status: "incomplete",
            issue: {
              code: "unsupported-language-profile",
              message: reason,
              object: {
                kind: "translation-unit",
                key: input.subject.key,
                language: policy.targetLanguage,
                sourceLanguage: policy.sourceLanguage,
                targetLanguage: policy.targetLanguage,
              },
              location: {
                language: policy.targetLanguage,
                range: policy.targetRange,
                key: input.subject.key,
              },
            },
          };
    },
    check: (input) => {
      const policy = policies.get(input.projected.language)!;
      return {
        status: "complete",
        issues: [],
        coverage: {
          selected: 1,
          evaluated: 1,
          notApplicable: 0,
          incomplete: 0,
          failed: 0,
        },
        diagnostics: evaluate(input.projected, policy).map(
          (finding): QualityFinding => ({
            severity: finding.severity ?? "error",
            object: {
              kind: "translation-unit",
              key: input.projected.key,
              language: policy.targetLanguage,
              code: finding.code,
            },
            location: {
              language: policy.targetLanguage,
              range: policy.targetRange,
              key: input.projected.key,
            },
            message: finding.message,
            evidence: [
              {
                role: "source",
                object: { kind: "source", key: input.projected.key },
                location: {
                  language: policy.sourceLanguage,
                  range: policy.sourceRange,
                  key: input.projected.key,
                },
                value: input.projected.source,
              },
              {
                role: "target",
                object: {
                  kind: "translation",
                  key: input.projected.key,
                  language: policy.targetLanguage,
                },
                location: {
                  language: policy.targetLanguage,
                  range: policy.targetRange,
                  key: input.projected.key,
                },
                value: input.projected.target,
              },
              ...(finding.details === undefined
                ? []
                : [
                    {
                      role: "policy-detail",
                      object: { kind: "translation", key: input.projected.key },
                      location: {
                        language: policy.targetLanguage,
                        range: null,
                        key: input.projected.key,
                      },
                      value: finding.details,
                    },
                  ]),
            ],
          }),
        ),
      };
    },
  });
}
