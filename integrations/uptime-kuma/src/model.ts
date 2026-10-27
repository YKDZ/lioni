import type { FrameworkFacts } from "@lioni/core";
import type { TermbaseData } from "@lioni/terminology";
import type { VueI18nPolicy, VueI18nUsageIndex } from "@lioni/vue-i18n";

export type KumaCatalog = {
  readonly url: URL;
  readonly source: string;
  readonly targets: readonly string[];
};

export type KumaFiles = {
  readonly root: URL;
  readonly catalog: KumaCatalog;
};

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

export type KumaFacts = FrameworkFacts<Unit, Translation, Body, never>;

export type LanguageMetadata = {
  readonly quantityProfile?: string;
  readonly equivalences?: readonly (readonly string[])[];
  readonly quantityUnitAliases?: Readonly<
    Record<string, Readonly<Record<string, string>>>
  >;
  readonly quantityDefaultUnits?: Readonly<Record<string, string>>;
  readonly quantityIgnoredLiterals?: Readonly<
    Record<string, readonly string[]>
  >;
};

export type MessagePolicy = {
  readonly literals: Readonly<Record<string, readonly string[]>>;
  readonly scopes: VueI18nPolicy["messageFamilies"]["scopes"];
  readonly usageScopes: VueI18nPolicy["messageFamilies"]["usageScopes"];
};

export type KumaProject = {
  readonly policies: readonly VueI18nPolicy[];
  readonly terms: TermbaseData;
  readonly usages: VueI18nUsageIndex;
};
