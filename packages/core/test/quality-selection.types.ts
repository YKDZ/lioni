import { analyzeQuality, defineChecker, defineConfig } from "../src/index.ts";
import {
  schemaFromExamples,
  sourceSchemaFromExamples,
} from "./source-schema.ts";

type Unit = {
  readonly source: string;
  readonly context: { readonly line: number };
};
type Translation = { readonly id: string; readonly body: Body };
type Body = { readonly text: string; readonly state: "draft" | "reviewed" };
type Unavailable = { readonly id: string; readonly missing: true };
type PreparedInput = {
  readonly sourceText: string;
  readonly candidateText: Body;
  readonly minimum: number;
};

const sourceSchema = sourceSchemaFromExamples<Unit>({
  source: "Save",
  context: { line: 3 },
});
const translationSchema = schemaFromExamples<Translation>({
  id: "save-fr",
  body: { text: "Enregistrer", state: "draft" },
});
const unavailableSchema = schemaFromExamples<Unavailable>({
  id: "save-de",
  missing: true,
});
const bodySchema = schemaFromExamples<Body>({
  text: "Enregistrer",
  state: "draft",
});
const stringBodySchema = schemaFromExamples("");
const preparedSchema = schemaFromExamples<PreparedInput>({
  sourceText: "Save",
  candidateText: { text: "Enregistrer", state: "draft" },
  minimum: 1,
});

const checker = defineChecker.withTypes<Unit, Translation, Body, Unavailable>()(
  {
    id: "custom/explicit",
    version: "1",
    inputSchema: preparedSchema,
    load({ candidates }) {
      return new Map(candidates.map(({ sourceKey }) => [sourceKey, 1]));
    },
    prepare({ candidate, sourceUnit, translation, association, loaded }) {
      const sourceText: string = sourceUnit.unit.source;
      const translationId: string | undefined = translation?.translation.id;
      const candidateBody: Body = candidate.content;
      const associationStatus: string = association.status;
      const minimum: number = loaded.get(candidate.sourceKey) ?? 0;
      void translationId;
      void associationStatus;
      return {
        status: "ready",
        input: { sourceText, candidateText: candidateBody, minimum },
      };
    },
    check(input) {
      const candidateText: Body = input.candidateText;
      const minimum: number = input.minimum;
      void candidateText;
      void minimum;
      // @ts-expect-error 检查器只接收已验证的业务输入。
      void input.candidate;
      // @ts-expect-error 候选正文保留宿主声明的类型。
      const invalidBody: string = input.candidateText;
      void invalidBody;
      return completeOutcome();
    },
  },
);
const explicitId: "custom/explicit" = checker.id;
void explicitId;

function completeOutcome() {
  return {
    status: "complete" as const,
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

const config = defineConfig.withTypes<
  Unit,
  typeof sourceSchema,
  typeof translationSchema,
  typeof unavailableSchema,
  typeof bodySchema
>()({
  source: {
    schema: sourceSchema,
    read: () => ({ scopes: [] }),
  },
  keyOf: (unit) => String(unit.context.line),
  translations: {
    languages: ["fr", "de"],
    keyOf: (translation) => translation.id,
    schema: translationSchema,
    unavailableSchema,
    contentSchema: bodySchema,
    contentOf: (translation) => translation.body,
    read: () => ({ scopes: [] }),
  },
  quality: {
    checks: [checker],
    groups: { daily: ["custom/explicit"] },
  },
});

function verifySelectionTypes() {
  void analyzeQuality(config, { groups: ["daily"] });
  void analyzeQuality(config, { checkIds: ["custom/explicit"] });

  // @ts-expect-error SDK 消费者获得配置中的精确检查项 ID。
  void analyzeQuality(config, { checkIds: ["custom/explict"] });
  // @ts-expect-error SDK 消费者获得配置中的分组名联合类型。
  void analyzeQuality(config, { groups: ["nightly"] });
}
void verifySelectionTypes;

type NarrowUnit = {
  readonly source: string;
  readonly context: { readonly key: string };
};
type WideUnit = { readonly source: string };
const wideSourceSchema = sourceSchemaFromExamples<WideUnit>({ source: "Save" });
const narrowChecker = defineChecker.withTypes<NarrowUnit, unknown, string>()({
  id: "context-dependent",
  version: "1",
  inputSchema: schemaFromExamples(""),
  prepare({ sourceUnit }) {
    return { status: "ready", input: sourceUnit.unit.context.key };
  },
  check: completeOutcome,
});

defineConfig.withTypes<
  WideUnit,
  typeof wideSourceSchema,
  never,
  never,
  typeof stringBodySchema
>()({
  source: { schema: wideSourceSchema, read: () => ({ scopes: [] }) },
  keyOf: (unit) => unit.source,
  quality: {
    // @ts-expect-error 需要上下文的检查器不能在缺少该上下文的宿主中运行。
    checks: [narrowChecker],
  },
});
