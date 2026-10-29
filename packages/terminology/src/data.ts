import type { StandardSchemaV1 } from "@standard-schema/spec";
import { z } from "zod";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

// SDK 边界保持普通结构类型；内部 schema 通过 satisfies 对照公开契约。
export type TermUsage = "preferred" | "allowed" | "forbidden";
export type TermType =
  | "fullForm"
  | "abbreviation"
  | "acronym"
  | "shortForm"
  | "variant"
  | "phrase";

type TermMetadata = {
  readonly note?: string;
  readonly metadata?: JsonValue;
  readonly sourceRefs?: readonly JsonValue[];
};

export type TermExpressionData = TermMetadata & {
  readonly id: string;
  readonly text: string;
  readonly usage: TermUsage;
  readonly termType?: TermType;
};

export type TermLanguageData = TermMetadata & {
  readonly language: string;
  readonly definition?: {
    readonly text: string;
    readonly sourceRefs?: readonly JsonValue[];
  };
  readonly expressions: readonly TermExpressionData[];
};

export type TermConceptData = TermMetadata & {
  readonly id: string;
  readonly languages: readonly TermLanguageData[];
  readonly subjectFields?: readonly string[];
};

export type TermbaseData = TermMetadata & {
  readonly concepts: readonly TermConceptData[];
};

const jsonScalarSchema = z.union([
  z.string(),
  z.number().refine((value) => !Object.is(value, -0), "JSON 数值不能为负零。"),
  z.boolean(),
  z.null(),
]);
export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    jsonScalarSchema,
    z.array(jsonValueSchema),
    // record/object 会跳过 __proto__；按键值项验证以保留合法 JSON 身份。
    z
      .custom<Record<string, unknown>>(
        (value) =>
          value !== null &&
          typeof value === "object" &&
          !Array.isArray(value) &&
          (Object.getPrototypeOf(value) === Object.prototype ||
            Object.getPrototypeOf(value) === null),
      )
      .transform(Object.entries)
      .pipe(z.array(z.tuple([z.string(), jsonValueSchema])))
      .transform((entries) => Object.fromEntries(entries)),
  ]),
);
export const nonemptyTextSchema = z
  .string()
  .refine((value) => value.trim() !== "", "文本不得为空或仅有空白。");
const termUsageSchema = z.enum(["preferred", "allowed", "forbidden"]);
const termTypeSchema = z.enum([
  "fullForm",
  "abbreviation",
  "acronym",
  "shortForm",
  "variant",
  "phrase",
]);
const metadataShape = {
  note: z.string().exactOptional(),
  metadata: jsonValueSchema.exactOptional(),
  sourceRefs: z.array(jsonValueSchema).readonly().exactOptional(),
};
const expressionSchema = z
  .object({
    ...metadataShape,
    id: nonemptyTextSchema,
    text: nonemptyTextSchema,
    usage: termUsageSchema,
    termType: termTypeSchema.exactOptional(),
    variants: z.never().exactOptional(),
  })
  .readonly() satisfies z.ZodType<TermExpressionData>;
const languageSchema = z
  .object({
    ...metadataShape,
    language: nonemptyTextSchema,
    definition: z
      .object({ ...metadataShape, text: z.string() })
      .readonly()
      .exactOptional(),
    expressions: z.array(expressionSchema).min(1).readonly(),
  })
  .readonly() satisfies z.ZodType<TermLanguageData>;
const conceptSchema = z
  .object({
    ...metadataShape,
    id: nonemptyTextSchema,
    languages: z.array(languageSchema).min(1).readonly(),
    subjectFields: z.array(z.string()).readonly().exactOptional(),
  })
  .readonly() satisfies z.ZodType<TermConceptData>;
export const termbaseContract = z
  .object({
    ...metadataShape,
    concepts: z.array(conceptSchema).readonly(),
  })
  .superRefine((data, context) => {
    const conceptIds = new Set<string>();
    for (const [ci, concept] of data.concepts.entries()) {
      if (conceptIds.has(concept.id))
        context.addIssue({
          code: "custom",
          message: "概念身份重复。",
          path: ["concepts", ci, "id"],
        });
      conceptIds.add(concept.id);
      const languages = new Set<string>();
      const expressions = new Set<string>();
      for (const [li, language] of concept.languages.entries()) {
        const path = ["concepts", ci, "languages", li];
        if (languages.has(language.language))
          context.addIssue({
            code: "custom",
            message: "概念内语言段重复。",
            path: [...path, "language"],
          });
        languages.add(language.language);
        for (const [ei, expression] of language.expressions.entries()) {
          if (expressions.has(expression.id))
            context.addIssue({
              code: "custom",
              message: "概念内表达身份重复。",
              path: [...path, "expressions", ei, "id"],
            });
          expressions.add(expression.id);
        }
      }
    }
  })
  .readonly() satisfies z.ZodType<TermbaseData>;

/** 查询用的平面视图；规范资料仍保留概念、语言和表达三层。 */
export type TermExpression = {
  readonly conceptId: string;
  readonly expressionId: string;
  readonly language: string;
  readonly concept: TermConceptData;
  readonly languageData: TermLanguageData;
  readonly expression: TermExpressionData;
};

export type Termbase = {
  readonly data: TermbaseData;
  readonly concepts: readonly TermConceptData[];
  readonly expressions: readonly TermExpression[];
  readonly getConcept: (id: string) => TermConceptData | undefined;
  readonly getExpression: (
    conceptId: string,
    expressionId: string,
  ) => TermExpression | undefined;
};

export type TermContractIssue = {
  readonly code: string;
  readonly message: string;
  readonly path: readonly (string | number)[];
  readonly conceptId?: string;
  readonly expressionId?: string;
};

export class TermContractError extends TypeError {
  readonly stage: "create" | "select" | "compile" | "input";
  readonly issues: readonly TermContractIssue[];

  constructor(
    stage: TermContractError["stage"],
    issues: readonly TermContractIssue[],
  ) {
    super(issues.map((issue) => issue.message).join("；"));
    this.name = "TermContractError";
    this.stage = stage;
    this.issues = Object.freeze([...issues]);
  }
}

export function contractIssue(
  code: string,
  message: string,
  path: readonly (string | number)[] = [],
): TermContractIssue {
  return { code, message, path };
}

/** 输入异常只公开字段位置与原因，调用方无需识别具体验证库。 */
export function contractIssues(
  error: z.ZodError,
): readonly TermContractIssue[] {
  return error.issues.map((issue) => ({
    code: "invalid-input",
    message: issue.message,
    path: issue.path.map((part) =>
      typeof part === "symbol" ? String(part) : part,
    ),
  }));
}

/** 先复制再验证，保留特殊键；Zod 的对象输出不作为领域快照。 */
export function copyJson(
  value: unknown,
  stage: TermContractError["stage"],
): JsonValue {
  const active = new Set<object>();
  function copy(current: unknown, path: readonly (string | number)[]): unknown {
    if (current === null || typeof current !== "object") {
      const result = jsonScalarSchema.safeParse(current);
      if (!result.success)
        throw new TermContractError(
          stage,
          contractIssues(result.error).map((issue) => ({
            ...issue,
            path: [...path, ...issue.path],
          })),
        );
      return result.data;
    }
    const prototype = Object.getPrototypeOf(current);
    if (
      active.has(current) ||
      (prototype !== Object.prototype &&
        prototype !== Array.prototype &&
        prototype !== null)
    )
      throw new TermContractError(stage, [
        contractIssue("invalid-json", "资料必须可无损保存为 JSON。", path),
      ]);
    active.add(current);
    try {
      const result = Array.isArray(current)
        ? Array.from(current, (item, index) => copy(item, [...path, index]))
        : Object.fromEntries(
            Object.entries(current).map(([key, item]) => [
              key,
              copy(item, [...path, key]),
            ]),
          );
      return Object.freeze(result);
    } finally {
      active.delete(current);
    }
  }
  const snapshot = copy(value, []);
  return snapshot as JsonValue;
}

export const termbaseDataSchema: StandardSchemaV1<TermbaseData> = {
  "~standard": {
    version: 1,
    vendor: "lioni-terminology",
    validate(value) {
      try {
        const snapshot = copyJson(value, "create");
        const result = termbaseContract.safeParse(snapshot);
        return result.success
          ? { value: snapshot as unknown as TermbaseData }
          : { issues: contractIssues(result.error) };
      } catch (error) {
        if (error instanceof TermContractError) return { issues: error.issues };
        throw error;
      }
    },
  },
};

/** 创建独立、不可改写的资料快照；使用地位冲突在有效选择之后检查。 */
export function createTermbase(value: unknown): Termbase {
  const snapshot = copyJson(value, "create");
  const result = termbaseContract.safeParse(snapshot);
  if (!result.success)
    throw new TermContractError("create", contractIssues(result.error));
  const data = snapshot as unknown as TermbaseData;
  const expressions = Object.freeze(
    data.concepts.flatMap((concept) =>
      concept.languages.flatMap((languageData) =>
        languageData.expressions.map((expression) =>
          Object.freeze({
            conceptId: concept.id,
            expressionId: expression.id,
            language: languageData.language,
            concept,
            languageData,
            expression,
          }),
        ),
      ),
    ),
  );
  const concepts = new Map(
    data.concepts.map((concept) => [concept.id, concept]),
  );
  const byConcept = new Map<string, Map<string, TermExpression>>();
  for (const entry of expressions) {
    let entries = byConcept.get(entry.conceptId);
    if (!entries) {
      entries = new Map();
      byConcept.set(entry.conceptId, entries);
    }
    entries.set(entry.expressionId, entry);
  }
  return Object.freeze({
    data,
    concepts: data.concepts,
    expressions,
    getConcept: (id: string) => concepts.get(id),
    getExpression: (conceptId: string, expressionId: string) =>
      byConcept.get(conceptId)?.get(expressionId),
  });
}

export type TermSelection = {
  readonly concept?: (concept: TermConceptData) => boolean;
  readonly expression?: (expression: TermExpression) => boolean;
};

export function selectTerms(
  termbase: Termbase,
  selection: TermSelection = {},
): Termbase {
  const concepts = termbase.concepts
    .filter((concept) => selection.concept?.(concept) ?? true)
    .map((concept) => ({
      ...concept,
      languages: concept.languages
        .map((language) => ({
          ...language,
          expressions: language.expressions.filter(
            (expression) =>
              selection.expression?.(
                termbase.getExpression(concept.id, expression.id)!,
              ) ?? true,
          ),
        }))
        .filter((language) => language.expressions.length > 0),
    }))
    .filter((concept) => concept.languages.length > 0);
  const selected = createTermbase({ ...termbase.data, concepts });
  assertUsageConflicts(
    selected.expressions.map((entry) => ({
      entry,
      key: entry.expression.text,
    })),
    "select",
  );
  return selected;
}

export function assertUsageConflicts(
  entries: readonly { readonly entry: TermExpression; readonly key: string }[],
  stage: "select" | "compile",
): void {
  const seen = new Map<string, TermExpression>();
  const issues: TermContractIssue[] = [];
  for (const { entry, key } of entries) {
    const identity = JSON.stringify([entry.conceptId, entry.language, key]);
    const previous = seen.get(identity);
    if (
      previous &&
      (previous.expression.usage === "forbidden") !==
        (entry.expression.usage === "forbidden")
    )
      issues.push({
        code: "usage-conflict",
        message: "同一概念的有效表达同时允许和禁用。",
        path: ["concepts", entry.conceptId, "expressions", entry.expressionId],
        conceptId: entry.conceptId,
        expressionId: entry.expressionId,
      });
    else seen.set(identity, entry);
  }
  if (issues.length) throw new TermContractError(stage, issues);
}
