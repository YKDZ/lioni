import type {
  CheckerPrepareInput,
  FrameworkConfig,
  QualityCheckOutcome,
  QualityObject,
  TranslationUnitInput,
} from "@lioni/core";
import { analyzeQuality, defineConfig } from "@lioni/core";
import {
  requireAllowedTranslation,
  type CompiledTerms,
  type TermComparisonInput,
} from "@lioni/terminology";
import { z } from "zod";

import {
  createNumberChecker,
  createTermChecker,
  createVueI18nChecks,
<<<<<<< HEAD
  createVueI18nSourceSyntaxChecker,
  createVueI18nTargetSyntaxChecker,
  createVueI18nVariableCorrespondenceChecker,
  type TermCheckerLoaded,
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
  terms: (): CompiledTerms => {
    throw new Error("仅供静态类型检查使用。");
  },
  prepare(
    input: CheckerPrepareInput<
      Unit,
      Translation,
      Body,
      UnavailableTranslation,
      TermCheckerLoaded<undefined>
    >,
  ) {
    const sourceText: string = input.sourceUnit.unit.source;
    const candidate: Body = input.candidate.content;
    void candidate;
    return {
      status: "ready" as const,
      subject: { sourceText: sourceText ?? "Save" },
      comparison: {
        groups: [
          {
            source: {
              language: "en",
              fragments: [{ ref: "source", text: sourceText }],
            },
            target: {
              language: "fr",
              fragments: [{ ref: "target", text: "Enregistrer" }],
            },
          },
        ],
      } satisfies TermComparisonInput,
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
const vueChecks = [
  ...createVueI18nChecks<VueUnit, VueTranslation, VueBody>(vueOptions),
  createNumberChecker(),
] as const;
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
  | "message-family-consistency"
  | "number-correspondence";
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
    keyOf: (translation) => translation.id,
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

const mismatchedNumberChecker = createNumberChecker.withTypes<
  VueUnit,
  { readonly id: number },
  VueBody,
  never
>()();
function configWithMismatchedNumberChecker() {
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
      keyOf: (translation) => translation.id,
      schema: translationSchema,
      contentSchema: translationBodySchema,
      contentOf: (translation) => translation.body,
      read: () => ({ scopes: [] }),
    },
    quality: {
      // @ts-expect-error 检查器不得改变宿主配置声明的译文类型。
      checks: [mismatchedNumberChecker],
    },
  });
}
void configWithMismatchedNumberChecker;

function verifyVueSelectionTypes() {
  void analyzeQuality(vueConfig, { groups: ["syntax"] });
  void analyzeQuality(vueConfig, {
    checkIds: [
      "vue-i18n/source-syntax",
      "message-family-consistency",
      "number-correspondence",
    ],
  });

  // @ts-expect-error Vue 集合 ID 联合拒绝拼写错误。
  void analyzeQuality(vueConfig, { checkIds: ["vue-i18n/source-syntaxx"] });
  // @ts-expect-error 内置数字检查 ID 保留精确字面量。
  void analyzeQuality(vueConfig, { checkIds: ["number-correspondance"] });
  // @ts-expect-error Vue 分组名称必须来自宿主配置。
  void analyzeQuality(vueConfig, { groups: ["unconfigured"] });
}
void verifyVueSelectionTypes;

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
      keyOf: (translation) => translation.id,
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

const defaultSourceId: "vue-i18n/source-syntax" =
  createVueI18nSourceSyntaxChecker().id;
const defaultTargetId: "vue-i18n/target-syntax" =
  createVueI18nTargetSyntaxChecker().id;
const defaultVariableId: "vue-i18n/variable-correspondence" =
  createVueI18nVariableCorrespondenceChecker().id;
const customSourceId: "custom-source" = createVueI18nSourceSyntaxChecker({
  id: "custom-source",
}).id;
const customTargetId: "custom-target" = createVueI18nTargetSyntaxChecker({
  id: "custom-target",
}).id;
const customVariableId: "custom-variable" =
  createVueI18nVariableCorrespondenceChecker({ id: "custom-variable" }).id;
const typedSourceId: "vue-i18n/source-syntax" =
  createVueI18nSourceSyntaxChecker<Unit, Translation, Body>().id;
const typedTargetId: "vue-i18n/target-syntax" =
  createVueI18nTargetSyntaxChecker<Unit, Translation, Body>().id;
const typedVariableId: "vue-i18n/variable-correspondence" =
  createVueI18nVariableCorrespondenceChecker<Unit, Translation, Body>().id;
const explicitTargetId: "target-foo" = createVueI18nTargetSyntaxChecker<
  Unit,
  Translation,
  Body,
  never,
  "target-foo"
>({ id: "target-foo" }).id;
const explicitVariableId: "variable-foo" =
  createVueI18nVariableCorrespondenceChecker<
    Unit,
    Translation,
    Body,
    never,
    "variable-foo"
  >({ id: "variable-foo" }).id;
void [typedTargetId, typedVariableId, explicitTargetId, explicitVariableId];
const explicitCustomId: "foo" = createVueI18nSourceSyntaxChecker<
  Unit,
  Translation,
  Body,
  never,
  "foo"
>({ id: "foo" }).id;
void [
  defaultSourceId,
  defaultTargetId,
  defaultVariableId,
  customSourceId,
  customTargetId,
  customVariableId,
  typedSourceId,
  explicitCustomId,
];

// @ts-expect-error 自定义 ID 必须显式提供，不能把默认 ID 声称为 foo。
createVueI18nSourceSyntaxChecker<Unit, Translation, Body, never, "foo">();
// @ts-expect-error 目标语法自定义 ID 不能省略参数。
createVueI18nTargetSyntaxChecker<Unit, Translation, Body, never, "foo">();
// @ts-expect-error 变量检查自定义 ID 不能省略参数。
createVueI18nVariableCorrespondenceChecker<
  Unit,
  Translation,
  Body,
  never,
  "foo"
>();
// @ts-expect-error 显式选项必须提供 ID。
createVueI18nSourceSyntaxChecker({});
// @ts-expect-error 显式目标语法选项必须提供 ID。
createVueI18nTargetSyntaxChecker({});
// @ts-expect-error 显式变量检查选项必须提供 ID。
createVueI18nVariableCorrespondenceChecker({});
createVueI18nSourceSyntaxChecker<Unit, Translation, Body, never, "foo">({
  // @ts-expect-error 显式 ID 必须与泛型中的身份一致。
  id: "bar",
});

createVueI18nTargetSyntaxChecker<Unit, Translation, Body, never, "foo">({
  // @ts-expect-error 目标语法的显式 ID 必须与泛型一致。
  id: "bar",
});
createVueI18nVariableCorrespondenceChecker<
  Unit,
  Translation,
  Body,
  never,
  "foo"
>({
  // @ts-expect-error 变量检查的显式 ID 必须与泛型一致。
  id: "bar",
});
