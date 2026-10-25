export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

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

/** 与 Standard Schema v1 结构兼容，不依赖 core。 */
export type TermSchema<T> = {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly types?: { readonly input: T; readonly output: T };
    readonly validate: (
      value: unknown,
    ) =>
      | { readonly value: T; readonly issues?: undefined }
      | { readonly issues: readonly TermContractIssue[] };
  };
};

export function contractIssue(
  code: string,
  message: string,
  path: readonly (string | number)[] = [],
): TermContractIssue {
  return { code, message, path };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 拒绝 JSON 会静默丢失的值，且不执行 getter。 */
export function copyJson(
  value: unknown,
  stage: TermContractError["stage"],
): JsonValue {
  const active = new Set<object>();
  function visit(
    current: unknown,
    path: readonly (string | number)[],
  ): JsonValue {
    const fail = (): never => {
      throw new TermContractError(stage, [
        contractIssue("invalid-json", "资料必须可无损保存为 JSON。", path),
      ]);
    };
    if (
      current === null ||
      typeof current === "boolean" ||
      typeof current === "string"
    )
      return current;
    if (typeof current === "number")
      return Number.isFinite(current) && !Object.is(current, -0)
        ? current
        : fail();
    if (typeof current !== "object" || active.has(current)) return fail();
    const array = Array.isArray(current);
    const prototype = Object.getPrototypeOf(current);
    if (
      array
        ? prototype !== Array.prototype
        : prototype !== Object.prototype && prototype !== null
    )
      return fail();
    active.add(current);
    try {
      const result: Record<string, JsonValue> = {};
      for (const key of Reflect.ownKeys(current)) {
        if (array && key === "length") continue;
        if (typeof key !== "string") return fail();
        const descriptor = Object.getOwnPropertyDescriptor(current, key)!;
        if (!descriptor.enumerable || !("value" in descriptor)) return fail();
        if (
          array &&
          (!Number.isInteger(Number(key)) ||
            Number(key) < 0 ||
            String(Number(key)) !== key ||
            Number(key) >= current.length)
        )
          return fail();
        Object.defineProperty(result, key, {
          value: visit(descriptor.value, [...path, array ? Number(key) : key]),
          enumerable: true,
        });
      }
      if (array) {
        const items: JsonValue[] = [];
        for (let index = 0; index < current.length; index += 1) {
          if (!Object.hasOwn(result, index)) return fail();
          items.push(result[String(index)]!);
        }
        return Object.freeze(items);
      }
      return Object.freeze(result);
    } finally {
      active.delete(current);
    }
  }
  return visit(value, []);
}

const usages = new Set(["preferred", "allowed", "forbidden"]);
const termTypes = new Set([
  "fullForm",
  "abbreviation",
  "acronym",
  "shortForm",
  "variant",
  "phrase",
]);

function validateData(value: unknown): readonly TermContractIssue[] {
  const issues: TermContractIssue[] = [];
  const add = (
    code: string,
    message: string,
    path: readonly (string | number)[],
  ) => issues.push(contractIssue(code, message, path));
  const nonempty = (item: unknown) =>
    typeof item === "string" && item.trim() !== "";
  function metadata(
    item: Record<string, unknown>,
    path: readonly (string | number)[],
  ) {
    if (item.note !== undefined && typeof item.note !== "string")
      add("invalid-note", "说明必须是文本。", [...path, "note"]);
    if (item.sourceRefs !== undefined && !Array.isArray(item.sourceRefs))
      add("invalid-sources", "来源引用必须是数组。", [...path, "sourceRefs"]);
  }
  if (!isRecord(value) || !Array.isArray(value.concepts))
    return [
      contractIssue("invalid-termbase", "术语库必须包含 concepts 数组。", [
        "concepts",
      ]),
    ];
  metadata(value, []);
  const conceptIds = new Set<string>();
  value.concepts.forEach((concept: unknown, ci: number) => {
    const path = ["concepts", ci];
    if (!isRecord(concept)) {
      add("invalid-concept", "概念必须是对象。", path);
      return;
    }
    metadata(concept, path);
    if (!nonempty(concept.id))
      add("invalid-id", "概念身份必须非空。", [...path, "id"]);
    else if (conceptIds.has(concept.id as string))
      add("duplicate-concept-id", "概念身份重复。", [...path, "id"]);
    else conceptIds.add(concept.id as string);
    if (
      concept.subjectFields !== undefined &&
      (!Array.isArray(concept.subjectFields) ||
        concept.subjectFields.some((item: unknown) => typeof item !== "string"))
    )
      add("invalid-subject-fields", "领域标签必须是文本数组。", [
        ...path,
        "subjectFields",
      ]);
    if (!Array.isArray(concept.languages) || concept.languages.length === 0) {
      add("invalid-languages", "概念至少需要一个语言段。", [
        ...path,
        "languages",
      ]);
      return;
    }
    const languages = new Set<string>();
    const expressionIds = new Set<string>();
    concept.languages.forEach((language: unknown, li: number) => {
      const lp = [...path, "languages", li];
      if (!isRecord(language)) {
        add("invalid-language", "语言段必须是对象。", lp);
        return;
      }
      metadata(language, lp);
      if (!nonempty(language.language))
        add("invalid-language", "语言标识必须非空。", [...lp, "language"]);
      else if (languages.has(language.language as string))
        add("duplicate-language", "概念内语言段重复。", [...lp, "language"]);
      else languages.add(language.language as string);
      if (language.definition !== undefined) {
        if (
          !isRecord(language.definition) ||
          typeof language.definition.text !== "string"
        )
          add("invalid-definition", "定义必须包含文本。", [
            ...lp,
            "definition",
          ]);
        else metadata(language.definition, [...lp, "definition"]);
      }
      if (
        !Array.isArray(language.expressions) ||
        language.expressions.length === 0
      ) {
        add("invalid-expressions", "语言段至少需要一个表达。", [
          ...lp,
          "expressions",
        ]);
        return;
      }
      language.expressions.forEach((expression: unknown, ei: number) => {
        const ep = [...lp, "expressions", ei];
        if (!isRecord(expression)) {
          add("invalid-expression", "表达必须是对象。", ep);
          return;
        }
        metadata(expression, ep);
        if (!nonempty(expression.id))
          add("invalid-id", "表达身份必须非空。", [...ep, "id"]);
        else if (expressionIds.has(expression.id as string))
          add("duplicate-expression-id", "概念内表达身份重复。", [...ep, "id"]);
        else expressionIds.add(expression.id as string);
        if (!nonempty(expression.text))
          add("invalid-text", "术语表达不得为空或仅有空白。", [...ep, "text"]);
        if (
          typeof expression.usage !== "string" ||
          !usages.has(expression.usage)
        )
          add(
            "invalid-usage",
            "表达必须指定 preferred、allowed 或 forbidden。",
            [...ep, "usage"],
          );
        if (
          expression.termType !== undefined &&
          (typeof expression.termType !== "string" ||
            !termTypes.has(expression.termType))
        )
          add("invalid-term-type", "表达类型无效。", [...ep, "termType"]);
        if (Object.hasOwn(expression, "variants"))
          add("unsupported-variants", "资料变体必须独立登记为表达。", [
            ...ep,
            "variants",
          ]);
      });
    });
  });
  return issues;
}

export const termbaseDataSchema: TermSchema<TermbaseData> = {
  "~standard": {
    version: 1,
    vendor: "lioni-terminology",
    validate(value) {
      try {
        const snapshot = copyJson(value, "create");
        const issues = validateData(snapshot);
        return issues.length ? { issues } : { value: snapshot as TermbaseData };
      } catch (error) {
        if (error instanceof TermContractError) return { issues: error.issues };
        throw error;
      }
    },
  },
};

/** 创建独立、不可改写的资料快照；使用地位冲突在有效选择之后检查。 */
export function createTermbase(value: unknown): Termbase {
  const result = termbaseDataSchema["~standard"].validate(value);
  if (result.issues !== undefined)
    throw new TermContractError("create", result.issues);
  const data = result.value;
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
