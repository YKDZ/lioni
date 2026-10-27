import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type {
  ActualTranslationFact,
  QualityCheckInput,
  QualityLocation,
  SemanticEditCandidate,
  SourceUnitFact,
} from "@lioni/core";
import type { TermbaseData } from "@lioni/terminology";
import { loadTermbaseYaml } from "@lioni/terminology/node";
import { prepareVueI18nQuality } from "@lioni/vue-i18n";
import type {
  VueI18nMessageProjection,
  VueI18nPolicy,
  VueI18nUsageIndex,
} from "@lioni/vue-i18n";

import { readKumaMessages, resourceRange, resourceUrl } from "./adapter.ts";
import type {
  Body,
  KumaFacts,
  KumaFiles,
  KumaProject,
  LanguageMetadata,
  MessagePolicy,
  Translation,
  Unit,
} from "./model.ts";
import { createResourceContractCheck } from "./resource-contract.ts";
import { loadKumaUsages } from "./source-files.ts";

type ProjectionInput = Omit<
  QualityCheckInput<Unit, Translation, unknown, Body, never>,
  "configuration"
>;

type Reference = {
  readonly sourceUnit: SourceUnitFact<Unit>;
  readonly sourceKey: string;
  readonly language: string;
  readonly translation: ActualTranslationFact<Translation, Body, never>;
};

type VueI18nBasis = {
  readonly policies: readonly VueI18nPolicy[];
  readonly terms: TermbaseData;
  readonly usages: VueI18nUsageIndex;
};

type ResourceTexts = {
  readonly messages: Record<string, string>;
  readonly range: string;
  readonly metadata: LanguageMetadata;
};

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function stringMap(value: unknown, language: string): Record<string, string> {
  if (
    !record(value) ||
    !Object.values(value).every((entry) => typeof entry === "string")
  )
    throw new Error(`${language} 的消息资源必须是字符串映射。`);
  return value as Record<string, string>;
}

function factResourceTexts(
  facts: KumaFacts,
  sourceLanguage: string,
  targetLanguages: readonly string[],
): Map<string, Record<string, string>> {
  const resources = new Map<string, Record<string, string>>();
  resources.set(
    sourceLanguage,
    Object.fromEntries(
      facts.source.units.map(({ key, unit }) => [key, unit.source.text]),
    ),
  );
  for (const language of targetLanguages) resources.set(language, {});
  for (const fact of facts.translations.records) {
    if (fact.bodyAvailability !== "available") continue;
    const messages = resources.get(fact.language);
    if (messages !== undefined)
      Object.defineProperty(messages, fact.translation.key, {
        configurable: true,
        enumerable: true,
        value: fact.content.text,
        writable: true,
      });
  }
  return resources;
}

/** 每次质量准备都基于本次 facts 重建资源与策略快照。 */
export async function loadKumaQaProject(
  files: KumaFiles,
  facts?: KumaFacts,
): Promise<KumaProject> {
  const root = fileURLToPath(files.root);
  const { source: sourceLanguage, targets: targetLanguages } = files.catalog;
  const factTexts =
    facts === undefined
      ? undefined
      : factResourceTexts(facts, sourceLanguage, targetLanguages);
  const resources = new Map<string, ResourceTexts>();

  for (const language of [sourceLanguage, ...targetLanguages]) {
    const url = resourceUrl(files.catalog, language);
    const value =
      factTexts?.get(language) ?? (await readKumaMessages(url, language));
    const metadataValue: unknown = JSON.parse(
      await readFile(new URL(`./${language}.json`, files.catalog.url), "utf8"),
    );
    if (!record(metadataValue))
      throw new Error(`${language} 的语言声明必须是对象。`);
    resources.set(language, {
      messages: stringMap(value, language),
      range: resourceRange(root, url),
      metadata: metadataValue as LanguageMetadata,
    });
  }

  const sharedValue: unknown = JSON.parse(
    await readFile(new URL("./messages.json", files.catalog.url), "utf8"),
  );
  if (
    !record(sharedValue) ||
    !record(sharedValue.literals) ||
    !Array.isArray(sharedValue.scopes) ||
    !Array.isArray(sharedValue.usageScopes)
  )
    throw new Error("消息策略必须声明技术字面值、消息范围和调用点范围。");
  const shared = sharedValue as MessagePolicy;
  const terms = (
    await loadTermbaseYaml(new URL("./termbase/", files.catalog.url))
  ).data;
  const usages = await loadKumaUsages(root);
  const source = resources.get(sourceLanguage)!;
  const policies: VueI18nPolicy[] = targetLanguages.map((targetLanguage) => {
    const target = resources.get(targetLanguage)!;
    return {
      sourceLanguage,
      targetLanguage,
      resources: {
        source: { messages: source.messages, range: source.range },
        target: { messages: target.messages, range: target.range },
      },
      quantities: {
        source: quantityPolicy(source.metadata),
        target: quantityPolicy(target.metadata),
      },
      protectedLiterals: shared.literals,
      messageFamilies: {
        scopes: shared.scopes,
        usageScopes: shared.usageScopes,
        targetEquivalences: target.metadata.equivalences ?? [],
      },
    };
  });

  return { policies, terms, usages };
}

export async function prepareKumaQuality(files: KumaFiles, facts: KumaFacts) {
  const project = await loadKumaQaProject(files, facts);
  const prepared = prepareVueI18nQuality<Unit, Translation, Body, never>({
    project: projectMessage,
    reference: (reference) => projectReference(reference, project.policies),
    policies: project.policies,
    terms: project.terms,
    usages: project.usages,
    identities: kumaCheckIdentities,
  });
  const basis = prepared.request.dependencies.vueI18n;
  return {
    checks: [createResourceContractCheck(basis), ...prepared.checks],
    request: {
      ...prepared.request,
      candidates: createKumaCandidates(basis, facts),
    },
  };
}

function quantityPolicy(metadata: LanguageMetadata) {
  const aliases = metadata.quantityUnitAliases ?? {};
  const defaults = metadata.quantityDefaultUnits ?? {};
  const ignored = metadata.quantityIgnoredLiterals ?? {};
  const keys = new Set([
    ...Object.keys(aliases),
    ...Object.keys(defaults),
    ...Object.keys(ignored),
  ]);
  const byKey: Record<
    string,
    {
      readonly aliases?: Readonly<Record<string, string>>;
      readonly defaultUnit?: string;
      readonly ignoredLiterals?: readonly string[];
    }
  > = {};
  for (const key of keys) {
    const options = {
      ...(aliases[key] === undefined ? {} : { aliases: aliases[key] }),
      ...(defaults[key] === undefined ? {} : { defaultUnit: defaults[key] }),
      ...(ignored[key] === undefined ? {} : { ignoredLiterals: ignored[key] }),
    };
    Object.defineProperty(byKey, key, {
      configurable: true,
      enumerable: true,
      value: options,
      writable: true,
    });
  }
  return {
    ...(metadata.quantityProfile === undefined
      ? {}
      : { profile: metadata.quantityProfile }),
    ...(keys.size === 0 ? {} : { byKey }),
  };
}

function projectMessage(input: ProjectionInput): VueI18nMessageProjection {
  const basis = (input.dependencies as { readonly vueI18n: VueI18nBasis })
    .vueI18n;
  const candidate = input.candidate;
  const policy = basis.policies.find(
    (item) => item.targetLanguage === candidate.language,
  );
  return {
    key: candidate.sourceKey,
    language: candidate.language,
    source:
      input.sourceUnit === null
        ? { status: "absent" }
        : input.sourceUnit.bodyAvailability === "available"
          ? { status: "available", text: input.sourceUnit.unit.source.text }
          : { status: "unavailable" },
    target:
      candidate.content.resourceStatus === "missing"
        ? { status: "missing" }
        : candidate.content.resourceStatus === "unavailable"
          ? { status: "unavailable" }
          : { status: "available", text: candidate.content.text },
    locations: messageLocations(
      policy,
      candidate.sourceKey,
      candidate.language,
    ),
  };
}

function projectReference(
  reference: Reference,
  policies: readonly VueI18nPolicy[],
): VueI18nMessageProjection {
  const policy = policies.find(
    (item) => item.targetLanguage === reference.language,
  );
  const translation = reference.translation;
  return {
    key: reference.sourceKey,
    language: reference.language,
    source:
      reference.sourceUnit.bodyAvailability === "available"
        ? { status: "available", text: reference.sourceUnit.unit.source.text }
        : { status: "unavailable" },
    target:
      translation.bodyAvailability === "available"
        ? { status: "available", text: translation.content.text }
        : { status: "unavailable" },
    locations: messageLocations(
      policy,
      reference.sourceKey,
      reference.language,
    ),
  };
}

function messageLocations(
  policy: VueI18nPolicy | undefined,
  key: string,
  language: string,
): VueI18nMessageProjection["locations"] {
  const source: QualityLocation = {
    language: null,
    range: policy?.resources.source.range ?? null,
    key,
  };
  const target: QualityLocation = {
    language,
    range: policy?.resources.target.range ?? null,
    key,
  };
  return { source, target };
}

function createKumaCandidates(
  basis: VueI18nBasis,
  facts: KumaFacts,
): readonly SemanticEditCandidate<Body>[] {
  const sourceKeys = facts.source.units.map(({ key }) => key);
  const translations = new Map<
    string,
    { text: string; status: "available" | "unavailable" }
  >();
  for (const fact of facts.translations.records) {
    const identity = JSON.stringify([fact.language, fact.translation.key]);
    if (fact.bodyAvailability === "available")
      translations.set(identity, {
        text: fact.content.text,
        status: "available",
      });
    else translations.set(identity, { text: "", status: "unavailable" });
  }

  return basis.policies.flatMap((policy) => {
    const keys = new Set([
      ...sourceKeys,
      ...Object.keys(policy.resources.target.messages),
      ...basis.usages.entries.map(({ key }) => key),
    ]);
    return [...keys].map((key) => {
      const translation = translations.get(
        JSON.stringify([policy.targetLanguage, key]),
      );
      return {
        sourceKey: key,
        language: policy.targetLanguage,
        content: {
          text: translation?.text ?? "",
          ...(translation === undefined
            ? { resourceStatus: "missing" as const }
            : translation.status === "unavailable"
              ? { resourceStatus: "unavailable" as const }
              : {}),
        },
      };
    });
  });
}

const kumaCheckIdentities = {
  sourceSyntax: {
    id: "vue-i18n/source-syntax",
    hostVersion: "kuma-source-syntax-v1",
  },
  targetSyntax: {
    id: "vue-i18n/target-syntax",
    hostVersion: "kuma-target-syntax-v1",
  },
  variableCorrespondence: {
    id: "vue-i18n/variable-correspondence",
    hostVersion: "kuma-variable-correspondence-v1",
  },
  callArguments: {
    id: "kuma/vue-message-call-arguments",
    hostVersion: "usage-scan-v1",
  },
  linkTargetExists: {
    id: "kuma/vue-message-link-target-exists",
    hostVersion: "kuma-link-target-v1",
  },
  linkCycle: {
    id: "kuma/vue-message-link-cycle",
    hostVersion: "kuma-link-cycle-v1",
  },
  protectedLiterals: {
    id: "kuma/protected-literals",
    hostVersion: "kuma-protected-literals-v1",
  },
  quantities: {
    id: "kuma/quantities",
    hostVersion: "kuma-quantity-policy-v1",
  },
  allowedTerminology: {
    id: "terminology/require-allowed-translation",
    hostVersion: "kuma-terminology/v2",
  },
  forbiddenTerminology: {
    id: "terminology/reject-forbidden-translation",
    hostVersion: "kuma-terminology/v2",
  },
  messageFamilyConsistency: {
    id: "message-family-consistency",
    hostVersion: "kuma-message-family/v2",
  },
} as const;
