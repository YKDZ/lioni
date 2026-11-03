import {
  analyzeQuality,
  bindQualityCheck,
  defineConfig,
  defineQualityCheck,
  type QualityCheckInput,
  type QualityCheckOutcome,
  type QualityObject,
} from "../src/index.ts";
import {
  schemaFromExamples,
  sourceSchemaFromExamples,
} from "./source-schema.ts";

type Unit = {
  readonly source: string;
  readonly context: { readonly line: number };
};
type Translation = {
  readonly id: string;
  readonly body: Body;
};
type UnavailableTranslation = { readonly id: string; readonly missing: true };
type Body = { readonly text: string; readonly state: "draft" | "reviewed" };
type Settings = { readonly minimum: number };

const sourceSchema = sourceSchemaFromExamples<Unit>({
  source: "Save",
  context: { line: 3 },
});
const translationSchema = schemaFromExamples<Translation>({
  id: "save-fr",
  body: { text: "Enregistrer", state: "draft" },
});
const unavailableSchema = schemaFromExamples<UnavailableTranslation>({
  id: "save-de",
  missing: true,
});
const bodySchema = schemaFromExamples<Body>({
  text: "Enregistrer",
  state: "draft",
});
const settingsSchema = schemaFromExamples<Settings>({ minimum: 1 });
const projectedSchema = schemaFromExamples<{ readonly text: string }>({
  text: "Save",
});

const explicitCheck = defineQualityCheck.withTypes<
  Unit,
  Translation,
  typeof settingsSchema,
  QualityObject,
  Body,
  UnavailableTranslation
>()({
  id: "custom/explicit",
  version: "1",
  configurationSchema: settingsSchema,
  configuration: { minimum: 1 },
  check(input) {
    const source: string | undefined = input.facts.source.units[0]?.unit.source;
    const translationId: string | undefined =
      input.facts.translations.records[0]?.translation.id;
    const candidateBody: Body = input.candidate.content;
    const minimum: number = input.configuration.minimum;
    void source;
    void translationId;
    void candidateBody;
    void minimum;
    // @ts-expect-error 原文正文仍是字符串。
    const invalidSource: number | undefined =
      input.facts.source.units[0]?.unit.source;
    // @ts-expect-error 候选正文仍保留宿主声明类型。
    const invalidBody: string = input.candidate.content;
    void invalidSource;
    void invalidBody;
    return completeOutcome();
  },
});
const explicitId: "custom/explicit" = explicitCheck.id;
void explicitId;

const inferredCheckFunction: (
  input: QualityCheckInput<
    Unit,
    Translation,
    Settings,
    Body,
    UnavailableTranslation
  >,
) => QualityCheckOutcome = () => completeOutcome();
const inferredCheck = defineQualityCheck({
  id: "custom/inferred",
  version: "1",
  configurationSchema: settingsSchema,
  configuration: { minimum: 1 },
  check: inferredCheckFunction,
});
const inferredId: "custom/inferred" = inferredCheck.id;
void inferredId;

const projectionCheck = bindQualityCheck<
  Unit,
  Translation,
  typeof settingsSchema,
  typeof projectedSchema,
  { readonly sourceText: string },
  QualityObject,
  Body,
  UnavailableTranslation,
  "custom/projection"
>({
  id: "custom/projection",
  version: "1",
  configurationSchema: settingsSchema,
  configuration: { minimum: 1 },
  inputSchema: projectedSchema,
  select(input) {
    const source: string | undefined = input.facts.source.units[0]?.unit.source;
    const candidateBody: Body = input.candidate.content;
    void source;
    void candidateBody;
    return { status: "selected", subject: { sourceText: "Save" } };
  },
  project({ subject }) {
    const sourceText: string = subject.sourceText;
    return { status: "ready", value: { text: sourceText } };
  },
  check(input) {
    const projectedText: string = input.projected.text;
    // @ts-expect-error 投影结果仍是所声明的 schema 输出类型。
    const invalidProjectedText: number = input.projected.text;
    void projectedText;
    void invalidProjectedText;
    return completeOutcome();
  },
});
const projectionId: "custom/projection" = projectionCheck.id;
void projectionId;

const config = defineConfig.withTypes<
  Unit,
  typeof sourceSchema,
  typeof translationSchema,
  typeof unavailableSchema,
  typeof bodySchema
>()({
  source: {
    schema: sourceSchema,
    read: () => ({
      scopes: [
        {
          range: "messages.json",
          enumeration: "complete" as const,
          records: [
            {
              value: { source: "Save", context: { line: 3 } },
              bodyAvailability: "available" as const,
            },
          ],
        },
      ],
    }),
  },
  keyOf: (unit) => String(unit.context.line),
  translations: {
    languages: ["fr", "de"],
    keyOf: (translation) => ({ namespace: "messages", key: translation.id }),
    schema: translationSchema,
    unavailableSchema,
    contentSchema: bodySchema,
    contentOf: (translation) => translation.body,
    read: () => ({ scopes: [] }),
  },
  quality: {
    checks: [explicitCheck, inferredCheck, projectionCheck],
    groups: {
      daily: ["custom/explicit"],
      allCustom: ["custom/inferred", "custom/explicit", "custom/projection"],
    },
  },
});

const passedById = analyzeQuality(config, {
  checkIds: ["custom/explicit", "custom/inferred", "custom/projection"],
});
const passedByGroup = analyzeQuality(config, { groups: ["daily"] });
void passedById;
void passedByGroup;

// @ts-expect-error 未声明的检查项不能通过运行选项反向扩大 ID 联合。
void analyzeQuality(config, { checkIds: ["custom/typo"] });
// @ts-expect-error 分组名称来自静态配置。
void analyzeQuality(config, { groups: ["nightly"] });
void analyzeQuality(config, {
  checkIds: ["custom/explicit"],
  // @ts-expect-error 同次运行只能指定 ID 或分组。
  groups: ["daily"],
});

const invalidGroupConfig = defineConfig.withTypes<
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
    keyOf: (translation) => ({ namespace: "messages", key: translation.id }),
    schema: translationSchema,
    unavailableSchema,
    contentSchema: bodySchema,
    contentOf: (translation) => translation.body,
    read: () => ({ scopes: [] }),
  },
  quality: {
    checks: [explicitCheck],
    groups: {
      // @ts-expect-error 组成员不能扩张由 checks 推断的 ID 联合。
      daily: ["custom/explicit", "custom/typo"],
    },
  },
});
void invalidGroupConfig;

function completeOutcome(): QualityCheckOutcome {
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
