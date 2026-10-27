import {
  analyzeQuality,
  defineConfig,
  type QualityCheckInput,
  type SemanticEditCandidate,
  type SourceUnitFact,
  type StandardSchemaV1,
} from "@lioni/core";
import type { TermbaseData } from "@lioni/terminology";
import {
  prepareVueI18nQuality,
  type VueI18nCheckIdentities,
  type VueI18nMessageProjection,
  type VueI18nPolicy,
  type VueI18nQualityOptions,
  type VueI18nUsageIndex,
} from "@lioni/vue-i18n";

export type Unit = {
  readonly key: string;
  readonly source: { readonly text: string };
};

export type Translation = {
  readonly key: string;
  readonly text: string;
  readonly language: string;
};

export type Body = {
  readonly text: string;
  readonly resourceStatus?: "missing" | "unavailable";
};

export const checkIds = {
  sourceSyntax: "vue-i18n/source-syntax",
  targetSyntax: "vue-i18n/target-syntax",
  variableCorrespondence: "vue-i18n/variable-correspondence",
  callArguments: "kuma/vue-message-call-arguments",
  linkTargetExists: "kuma/vue-message-link-target-exists",
  linkCycle: "kuma/vue-message-link-cycle",
  protectedLiterals: "kuma/protected-literals",
  quantities: "kuma/quantities",
  allowedTerminology: "terminology/require-allowed-translation",
  forbiddenTerminology: "terminology/reject-forbidden-translation",
  messageFamilyConsistency: "message-family-consistency",
} as const;

const testIdentity = (id: string) => ({
  id,
  hostVersion: "vue-i18n-quality-test-v1",
});
const identities = {
  sourceSyntax: testIdentity(checkIds.sourceSyntax),
  targetSyntax: testIdentity(checkIds.targetSyntax),
  variableCorrespondence: testIdentity(checkIds.variableCorrespondence),
  callArguments: testIdentity(checkIds.callArguments),
  linkTargetExists: testIdentity(checkIds.linkTargetExists),
  linkCycle: testIdentity(checkIds.linkCycle),
  protectedLiterals: testIdentity(checkIds.protectedLiterals),
  quantities: testIdentity(checkIds.quantities),
  allowedTerminology: testIdentity(checkIds.allowedTerminology),
  forbiddenTerminology: testIdentity(checkIds.forbiddenTerminology),
  messageFamilyConsistency: testIdentity(checkIds.messageFamilyConsistency),
} satisfies VueI18nCheckIdentities;

const usageIndex: VueI18nUsageIndex = {
  entries: [],
  unresolved: [],
  errors: [],
};

export function policyFor(
  input: {
    readonly sourceMessages?: Readonly<Record<string, string>>;
    readonly targetMessages?: Readonly<Record<string, string>>;
    readonly sourceLanguage?: string;
    readonly targetLanguage?: string;
    readonly sourceRange?: string;
    readonly targetRange?: string;
    readonly sourceQuantities?: VueI18nPolicy["quantities"] extends infer T
      ? T extends { readonly source: infer S }
        ? S
        : never
      : never;
    readonly targetQuantities?: VueI18nPolicy["quantities"] extends infer T
      ? T extends { readonly target: infer S }
        ? S
        : never
      : never;
    readonly protectedLiterals?: Readonly<Record<string, readonly string[]>>;
    readonly scopes?: VueI18nPolicy["messageFamilies"]["scopes"];
    readonly usageScopes?: VueI18nPolicy["messageFamilies"]["usageScopes"];
    readonly targetEquivalences?: VueI18nPolicy["messageFamilies"]["targetEquivalences"];
  } = {},
): VueI18nPolicy {
  const sourceLanguage = input.sourceLanguage ?? "en";
  const targetLanguage = input.targetLanguage ?? "zh-CN";
  return {
    sourceLanguage,
    targetLanguage,
    resources: {
      source: {
        messages: input.sourceMessages ?? {},
        range: input.sourceRange ?? "source/en.json",
      },
      target: {
        messages: input.targetMessages ?? {},
        range: input.targetRange ?? `translations/${targetLanguage}.json`,
      },
    },
    quantities: {
      source: input.sourceQuantities ?? { profile: "en" },
      target: input.targetQuantities ?? { profile: targetLanguage },
    },
    protectedLiterals: input.protectedLiterals ?? {},
    messageFamilies: {
      scopes: input.scopes ?? [],
      usageScopes: input.usageScopes ?? [],
      targetEquivalences: input.targetEquivalences ?? [],
    },
  };
}

export function createQualityFixture(input: {
  readonly policies: readonly VueI18nPolicy[];
  readonly terms?: TermbaseData;
  readonly usages?: VueI18nUsageIndex;
  readonly unavailableSourceKeys?: readonly string[];
  readonly onProject?: () => void;
}) {
  const policies = input.policies;
  const byLanguage = new Map(
    policies.map((policy) => [policy.targetLanguage, policy]),
  );
  const sourcePolicy = policies[0];
  if (!sourcePolicy) throw new Error("至少需要一个目标语言策略。");
  const unavailableSourceKeys = new Set(input.unavailableSourceKeys ?? []);

  const project = (
    qualityInput: Omit<
      QualityCheckInput<Unit, Translation, unknown, Body>,
      "configuration"
    >,
  ): VueI18nMessageProjection => {
    input.onProject?.();
    const candidate = qualityInput.candidate;
    const policy = byLanguage.get(candidate.language);
    if (!policy) throw new Error(`缺少目标语言策略：${candidate.language}。`);
    return projection({
      key: candidate.sourceKey,
      language: candidate.language,
      sourceUnit: qualityInput.sourceUnit,
      sourceRange:
        qualityInput.facts.source.read.scopes[
          qualityInput.sourceUnit?.scopeIndex ?? 0
        ]?.range ?? policy.resources.source.range,
      targetRange: policy.resources.target.range,
      target:
        candidate.content.resourceStatus === "missing"
          ? { status: "missing" }
          : candidate.content.resourceStatus === "unavailable"
            ? { status: "unavailable" }
            : { status: "available", text: candidate.content.text },
    });
  };

  const reference = (
    value: Parameters<
      VueI18nQualityOptions<Unit, Translation, Body>["reference"]
    >[0],
  ): VueI18nMessageProjection => {
    const policy = byLanguage.get(value.language);
    if (!policy) throw new Error(`缺少目标语言策略：${value.language}。`);
    return projection({
      key: value.sourceKey,
      language: value.language,
      sourceUnit: value.sourceUnit as SourceUnitFact<Unit>,
      sourceRange:
        value.sourceUnit.scopeIndex >= 0
          ? sourcePolicy.resources.source.range
          : policy.resources.source.range,
      targetRange: value.translation.range,
      target:
        value.translation.bodyAvailability === "available"
          ? { status: "available", text: value.translation.content.text }
          : { status: "unavailable" },
    });
  };

  const qualityOptions = {
    project,
    reference,
    policies,
    terms: input.terms ?? { concepts: [] },
    usages: input.usages ?? usageIndex,
    identities,
  };

  const sourceSchema = schema<Unit>(
    (value): value is Unit =>
      isRecord(value) &&
      typeof value.key === "string" &&
      isRecord(value.source) &&
      typeof value.source.text === "string",
  );
  const translationSchema = schema<Translation>(
    (value): value is Translation =>
      isRecord(value) &&
      typeof value.key === "string" &&
      typeof value.text === "string" &&
      typeof value.language === "string",
  );
  const bodySchema = schema<Body>(
    (value): value is Body =>
      isRecord(value) &&
      typeof value.text === "string" &&
      (value.resourceStatus === undefined ||
        value.resourceStatus === "missing" ||
        value.resourceStatus === "unavailable"),
  );

  const config = defineConfig({
    source: {
      schema: sourceSchema,
      read: () => ({
        scopes: [
          {
            range: sourcePolicy.resources.source.range,
            enumeration: "complete" as const,
            records: Object.entries(sourcePolicy.resources.source.messages).map(
              ([key, text]) => ({
                value: { key, source: { text } },
                bodyAvailability: unavailableSourceKeys.has(key)
                  ? ("unavailable" as const)
                  : ("available" as const),
              }),
            ),
          },
        ],
      }),
    },
    keyOf: ({ key }) => key,
    translations: {
      languages: policies.map(({ targetLanguage }) => targetLanguage),
      schema: translationSchema,
      contentSchema: bodySchema,
      contentOf: (translation) => ({ text: translation.text }),
      identityOf: (translation) => ({
        namespace: "messages",
        key: translation.key,
      }),
      matches: (unit, translation) => unit.key === translation.key,
      read: (language, sourceUnits) => {
        const policy = byLanguage.get(language);
        if (!policy) throw new Error(`缺少目标语言策略：${language}。`);
        return {
          scopes: [
            {
              range: policy.resources.target.range,
              covers: sourceUnits.map((unit) => unit.key),
              enumeration: "complete" as const,
              records: Object.entries(policy.resources.target.messages).map(
                ([key, text]) => ({
                  value: { key, text, language },
                  bodyAvailability: "available" as const,
                }),
              ),
            },
          ],
        };
      },
    },
    quality: {
      prepare: () =>
        prepareVueI18nQuality<Unit, Translation, Body>(qualityOptions),
    },
  });

  return {
    run(candidates: readonly SemanticEditCandidate<Body>[]) {
      return analyzeQuality(config, { candidates });
    },
  };
}

function projection(input: {
  readonly key: string;
  readonly language: string;
  readonly sourceUnit: SourceUnitFact<Unit> | null;
  readonly sourceRange: unknown;
  readonly targetRange: unknown;
  readonly target:
    | { readonly status: "available"; readonly text: string }
    | { readonly status: "unavailable" }
    | { readonly status: "missing" };
}): VueI18nMessageProjection {
  return {
    key: input.key,
    language: input.language,
    source:
      input.sourceUnit === null
        ? { status: "absent" }
        : input.sourceUnit.bodyAvailability === "available"
          ? { status: "available", text: input.sourceUnit.unit.source.text }
          : { status: "unavailable" },
    target: input.target,
    locations: {
      source: { language: null, range: input.sourceRange, key: input.key },
      target: {
        language: input.language,
        range: input.targetRange,
        key: input.key,
      },
    },
  };
}

function schema<T>(
  validate: (value: unknown) => value is T,
): StandardSchemaV1<T, T> {
  return {
    "~standard": {
      version: 1,
      vendor: "vue-i18n-quality-fixture",
      validate: (value) =>
        validate(value)
          ? { value }
          : { issues: [{ message: "测试资料结构无效。" }] },
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
