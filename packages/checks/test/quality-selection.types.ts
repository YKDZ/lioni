import type {
  FrameworkConfig,
  QualityCheckOutcome,
  QualityObject,
  TranslationUnitInput,
} from "@lioni/core";
import { analyzeQuality, defineConfig } from "@lioni/core";
import { requireAllowedTranslation } from "@lioni/terminology";
import { z } from "zod";

import {
  createTermChecker,
  createVueI18nChecks,
  type VueI18nChecksOptions,
  type VueI18nMessageProjection,
} from "../src/index.ts";

type Unit = TranslationUnitInput & {
  readonly source: string;
  readonly context: { readonly key: string };
};
type Translation = { readonly id: string; readonly body: Body };
type UnavailableTranslation = { readonly id: string; readonly missing: true };
type Body = { readonly text: string; readonly state: "draft" | "reviewed" };
type Subject = { readonly sourceText: string };

const checkerOptions = {
  hostVersion: "host/v1",
  terms: () => {
    throw new Error("仅供静态类型检查使用。");
  },
  select(input: {
    readonly candidate: { readonly content: Body };
    readonly facts: {
      readonly source: { readonly units: readonly { readonly unit: Unit }[] };
    };
  }) {
    const sourceText: string | undefined =
      input.facts.source.units[0]?.unit.source;
    const candidate: Body = input.candidate.content;
    void candidate;
    return {
      status: "selected" as const,
      subject: { sourceText: sourceText ?? "Save" },
    };
  },
  project(input: { readonly subject: Subject }) {
    return {
      status: "ready" as const,
      value: {
        groups: [
          {
            source: {
              language: "en",
              fragments: [{ ref: "source", text: input.subject.sourceText }],
            },
            target: {
              language: "fr",
              fragments: [{ ref: "target", text: "Enregistrer" }],
            },
          },
        ],
      },
    };
  },
};

const derived = createTermChecker.withTypes<
  Unit,
  Translation,
  Subject,
  Body,
  UnavailableTranslation
>()({
  ...checkerOptions,
  rule: requireAllowedTranslation(),
});
const derivedId: "terminology/require-allowed-translation" = derived.id;
void derivedId;

const overridden = createTermChecker.withTypes<
  Unit,
  Translation,
  Subject,
  Body,
  UnavailableTranslation
>()({
  ...checkerOptions,
  id: "host/terms/allowed",
  rule: requireAllowedTranslation(),
});
const overriddenId: "host/terms/allowed" = overridden.id;
void overriddenId;

const allTermIds: readonly (
  | "terminology/require-allowed-translation"
  | "host/terms/allowed"
)[] = [derived.id, overridden.id];
void allTermIds;

function outcome(): QualityCheckOutcome<QualityObject> {
  return {
    status: "complete",
    diagnostics: [],
    issues: [],
    coverage: {
      selected: 1,
      evaluated: 1,
      notApplicable: 0,
      incomplete: 0,
      failed: 0,
    },
  };
}

void outcome;

const sourceSchema = z.object({
  source: z.string(),
  context: z.object({ key: z.string() }),
});
const translationBodySchema = z.object({
  text: z.string(),
  state: z.enum(["draft", "reviewed"]),
});
const translationSchema = z.object({
  id: z.string(),
  body: translationBodySchema,
});
type VueUnit = z.output<typeof sourceSchema>;
type VueBody = z.output<typeof translationBodySchema>;
type VueTranslation = z.output<typeof translationSchema>;

const vueProjection: VueI18nMessageProjection = {
  key: "save",
  language: "fr",
  source: { status: "available", text: "Save" },
  target: { status: "available", text: "Enregistrer" },
  locations: {
    source: { language: "en", range: "messages.json", key: "save" },
    target: { language: "fr", range: "messages.fr.json", key: "save" },
  },
};
const vueOptions: VueI18nChecksOptions<VueUnit, VueTranslation, VueBody> = {
  hostVersion: "type-plan/v1",
  project: () => vueProjection,
  reference: () => vueProjection,
};
const vueChecks = createVueI18nChecks<VueUnit, VueTranslation, VueBody>(
  vueOptions,
);
type VueCheckId =
  | "vue-i18n/source-syntax"
  | "vue-i18n/target-syntax"
  | "vue-i18n/variable-correspondence"
  | "vue-i18n/link-target-exists"
  | "vue-i18n/link-cycle"
  | "vue-i18n/protected-literals"
  | "vue-i18n/quantities"
  | "terminology/require-allowed-translation"
  | "terminology/reject-forbidden-translation"
  | "message-family-consistency";
const vueIds: readonly VueCheckId[] = vueChecks.map(({ id }) => id);
void vueIds;

const vueConfig = defineConfig.withTypes<
  VueUnit,
  typeof sourceSchema,
  typeof translationSchema,
  never,
  typeof translationBodySchema
>()({
  source: { schema: sourceSchema, read: () => ({ scopes: [] }) },
  keyOf: (unit) => unit.context.key,
  translations: {
    languages: ["fr"],
    keyOf: (translation) => ({ namespace: "messages", key: translation.id }),
    schema: translationSchema,
    contentSchema: translationBodySchema,
    contentOf: (translation) => translation.body,
    read: () => ({ scopes: [] }),
  },
  quality: {
    checks: vueChecks,
    groups: {
      syntax: ["vue-i18n/source-syntax", "vue-i18n/target-syntax"],
      terminology: [
        "terminology/require-allowed-translation",
        "terminology/reject-forbidden-translation",
      ],
    },
  },
});
const staticVueConfig: FrameworkConfig<
  VueUnit,
  VueTranslation,
  VueBody,
  never,
  VueCheckId,
  {
    readonly syntax: readonly [
      "vue-i18n/source-syntax",
      "vue-i18n/target-syntax",
    ];
  }
> = vueConfig;
void staticVueConfig;

const vueByGroup = analyzeQuality(vueConfig, { groups: ["syntax"] });
const vueById = analyzeQuality(vueConfig, {
  checkIds: ["vue-i18n/source-syntax", "message-family-consistency"],
});
void vueByGroup;
void vueById;

// @ts-expect-error Vue 集合 ID 联合拒绝拼写错误。
analyzeQuality(vueConfig, { checkIds: ["vue-i18n/source-syntaxx"] });
// @ts-expect-error Vue 分组名称必须来自宿主配置。
analyzeQuality(vueConfig, { groups: ["unconfigured"] });

function vueConfigWithInvalidGroup(): FrameworkConfig<
  VueUnit,
  VueTranslation,
  VueBody
> {
  return defineConfig.withTypes<
    VueUnit,
    typeof sourceSchema,
    typeof translationSchema,
    never,
    typeof translationBodySchema
  >()({
    source: { schema: sourceSchema, read: () => ({ scopes: [] }) },
    keyOf: (unit) => unit.context.key,
    translations: {
      languages: ["fr"],
      keyOf: (translation) => ({ namespace: "messages", key: translation.id }),
      schema: translationSchema,
      contentSchema: translationBodySchema,
      contentOf: (translation) => translation.body,
      read: () => ({ scopes: [] }),
    },
    quality: {
      checks: vueChecks,
      // @ts-expect-error 分组成员不能反向扩大 Vue 检查集合的 ID 联合。
      groups: { syntax: ["vue-i18n/source-syntax", "vue-i18n/unknown"] },
    },
  });
}
void vueConfigWithInvalidGroup;
