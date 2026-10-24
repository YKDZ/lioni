import { defineConfig } from "../src/index.ts";
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
  updatePolicy: () => ({
    action: "candidate",
    candidate: {
      sourceKey: "toolbar.save",
      language: "fr",
      content: { message: "Enregistrer", state: "reviewed" as const },
    },
  }),
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
  // @ts-expect-error Update policies must return a body accepted by contentSchema.
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
    // @ts-expect-error The declared body has only these two states.
    state: "accepted",
  },
};
void invalidCandidate;

const translationUnitConstraint: TranslationUnitInput = {
  source: "Save",
  context: { key: "toolbar.save" },
};
void translationUnitConstraint;
