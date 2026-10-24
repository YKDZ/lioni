import {
  defineConfig,
  validateUpdatePlan,
  validateUpdatePlanHistory,
} from "../src/index.ts";
import type {
  SemanticEditCandidate,
  StandardSchemaV1,
  TranslationUnitInput,
} from "../src/index.ts";

type Unit = {
  readonly source: string;
  readonly context: { readonly key: string };
};

type Translation = {
  readonly id: string;
  readonly body: Body;
};

type Body = {
  readonly message: string;
  readonly state: "draft" | "reviewed";
};

declare const unknownPlan: unknown;
validateUpdatePlan(unknownPlan);
if (unknownPlan.items[0]?.decision.action === "candidate") {
  // @ts-expect-error JSON结构校验不能恢复宿主正文类型。
  const unvalidatedBody: Body = unknownPlan.items[0].decision.candidate.content;
  void unvalidatedBody;
}
// @ts-expect-error 只有绑定配置契约的历史校验才能恢复业务类型。
validateUpdatePlan<Unit, Translation, Body>(unknownPlan);

declare const unitSchema: StandardSchemaV1<Unit, Unit>;
declare const translationSchema: StandardSchemaV1<Translation, Translation>;
declare const bodySchema: StandardSchemaV1<Body, Body>;

const candidate: SemanticEditCandidate<Body> = {
  sourceKey: "toolbar.save",
  language: "fr",
  content: { message: "Enregistrer", state: "draft" },
};
const candidateBody: Body = candidate.content;
void candidateBody;

const config = defineConfig({
  source: { schema: unitSchema, read: () => ({ scopes: [] }) },
  keyOf: (unit) => unit.context.key,
  translations: {
    languages: ["fr"],
    schema: translationSchema,
    contentSchema: bodySchema,
    read: () => ({ scopes: [] }),
    matches: () => true,
    contentOf: (translation) => translation.body,
  },
  translationWriteback: {
    locateExistingTarget: ({ translation }) => ({
      status: "located",
      locator: translation.translation.id,
    }),
    locateNewTarget: () => ({ status: "located", locator: "new-save" }),
    write({ edit, currentTranslation }) {
      if (edit.operation === "write") {
        const body: Body = edit.content;
        const message: string = edit.content.message;
        void body;
        void message;
        if (edit.expected.target.status === "present") {
          const previousBody: Body = edit.expected.target.content;
          void previousBody;
        }
      }
      if (currentTranslation?.bodyAvailability === "available") {
        const actualBody: Body = currentTranslation.content;
        void actualBody;
      }
    },
  },
  updatePolicy(input) {
    const previousSource: string | undefined = input.previous?.source.value;
    const currentSource: string | undefined = input.expectedInput?.source.value;
    void previousSource;
    void currentSource;
    // @ts-expect-error 历史原文正文应保留原文 schema 的字符串类型。
    const invalidPreviousSource: number | undefined =
      input.previous?.source.value;
    void invalidPreviousSource;
    return {
      action: "candidate",
      candidate: {
        sourceKey: "toolbar.save",
        language: "fr",
        content: { message: "Enregistrer", state: "reviewed" as const },
      },
    };
  },
});

void validateUpdatePlanHistory(unknownPlan, config).then((validatedPlan) => {
  const item = validatedPlan.items[0];
  if (item?.decision.action !== "candidate") return;
  const validatedBody: Body = item.decision.candidate.content;
  void validatedBody;
});

const configuredBody: Body = config.translations!.contentOf({
  id: "save",
  body: { message: "Enregistrer", state: "reviewed" },
});
void configuredBody;

defineConfig({
  source: { schema: unitSchema, read: () => ({ scopes: [] }) },
  keyOf: (unit) => unit.context.key,
  translations: {
    languages: ["fr"],
    schema: translationSchema,
    contentSchema: bodySchema,
    read: () => ({ scopes: [] }),
    matches: () => true,
    contentOf: (translation) => translation.body,
  },
  // @ts-expect-error 更新策略候选正文必须符合 contentSchema。
  updatePolicy: () => ({
    action: "candidate",
    candidate: {
      sourceKey: "toolbar.save",
      language: "fr",
      content: {
        message: "Enregistrer",
        state: "accepted" as const,
      },
    },
  }),
});

const invalidCandidate: SemanticEditCandidate<Body> = {
  sourceKey: "toolbar.save",
  language: "fr",
  content: {
    message: "Enregistrer",
    // @ts-expect-error 声明的正文只允许这两种状态。
    state: "accepted",
  },
};
void invalidCandidate;

const translationUnitConstraint: TranslationUnitInput = {
  source: "Save",
  context: { key: "toolbar.save" },
};
void translationUnitConstraint;
