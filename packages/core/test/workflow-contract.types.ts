import {
  defineConfig,
  validateUpdatePlan,
  type FrameworkConfig,
  type SemanticEditCandidate,
  type StandardSchemaV1,
  type TranslationUnitInput,
  type TranslationWriteRequest,
  type TranslationWritebackAdapter,
  type UpdatePlan,
  type UpdatePolicy,
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
declare const unknownPlan: unknown;

validateUpdatePlan(unknownPlan);
if (unknownPlan.items[0]?.action === "write") {
  // @ts-expect-error JSON-only validation cannot restore the host body type.
  const untypedBody: Body = unknownPlan.items[0].request.content;
  void untypedBody;
}
// @ts-expect-error the saved-plan validator does not take host type parameters.
validateUpdatePlan<Unit, Translation, Body>(unknownPlan);

const candidate: SemanticEditCandidate<Body> = {
  sourceKey: "toolbar.save",
  language: "fr",
  content: { message: "Enregistrer", state: "draft" },
};
const candidateBody: Body = candidate.content;
void candidateBody;

const request: TranslationWriteRequest<Body, Unit> = {
  operation: "write",
  target: { sourceKey: "toolbar.save", language: "fr" },
  content: { message: "Enregistrer", state: "draft" },
  expectedSource: {
    presence: "present",
    key: "toolbar.save",
    range: "messages.json",
    unit: { source: "Save", context: { key: "toolbar.save" } },
    content: "Save",
  },
  expectedTarget: { status: "missing" },
};
void request;

const policy: UpdatePolicy<Unit, Translation, Body> = (input) => {
  const previousSource: string | undefined =
    input.previous?.source.units[0]?.unit.source;
  const currentSource: string | undefined =
    input.current.source.units[0]?.unit.source;
  void previousSource;
  void currentSource;
  // @ts-expect-error the policy sees source records validated by the source schema.
  const invalidSource: number | undefined =
    input.current.source.units[0]?.unit.source;
  void invalidSource;

  return [
    {
      action: "write",
      language: "fr",
      changes: { translations: [] },
      reason: "将原文投影为待译候选。",
      after: { content: { message: "Enregistrer", state: "reviewed" } },
      request: {
        operation: "write",
        target: { sourceKey: "toolbar.save", language: "fr" },
        content: { message: "Enregistrer", state: "reviewed" },
        expectedTarget: { status: "missing" },
      },
    },
  ];
};

const writeback: TranslationWritebackAdapter<Unit, Translation, Body> = {
  locateExistingTarget: ({ translation }) => ({
    status: "located",
    locator: translation.translation.id,
  }),
  locateNewTarget: ({ sourceKey }) => ({
    status: "located",
    locator: sourceKey,
  }),
  write({ request: writeRequest, currentTranslation }) {
    if (writeRequest.operation === "write") {
      const body: Body = writeRequest.content;
      const targetBody: Body | undefined =
        writeRequest.expectedTarget.status === "present"
          ? writeRequest.expectedTarget.content
          : undefined;
      void body;
      void targetBody;
    }
    if (currentTranslation?.bodyAvailability === "available") {
      const actualBody: Body = currentTranslation.content;
      void actualBody;
    }
  },
};

const config = defineConfig<
  Unit,
  typeof unitSchema,
  typeof translationSchema,
  never,
  typeof bodySchema
>({
  source: { schema: unitSchema, read: () => ({ scopes: [] }) },
  keyOf: (unit) => unit.context.key,
  sourceToContent: (source) => ({ message: source, state: "draft" }),
  translations: {
    languages: ["fr"],
    identityOf: (translation) => ({
      namespace: "fixture",
      key: translation.id,
    }),
    schema: translationSchema,
    contentSchema: bodySchema,
    contentOf: (translation) => translation.body,
    read: () => ({ scopes: [] }),
    matches: (unit, translation) => unit.context.key === translation.id,
  },
  translationWriteback: writeback,
  updatePolicy: policy,
});

const frameworkConfig: FrameworkConfig<Unit, Translation, Body> = config;
void frameworkConfig;

declare const typedPlan: UpdatePlan<Unit, Translation, Body>;
void typedPlan;

const invalidCandidate: SemanticEditCandidate<Body> = {
  sourceKey: "toolbar.save",
  language: "fr",
  content: {
    message: "Enregistrer",
    // @ts-expect-error the declared body contract only permits these states.
    state: "accepted",
  },
};
void invalidCandidate;

const translationUnitConstraint: TranslationUnitInput = {
  source: "Save",
  context: { key: "toolbar.save" },
};
void translationUnitConstraint;
