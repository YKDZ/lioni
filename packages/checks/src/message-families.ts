import { snapshotJsonValue } from "@lioni/core";
import type { JsonValue, QualityLocation } from "@lioni/core";
import type { TemplateSignature, TextRange } from "@lioni/text-analysis";
import * as v from "valibot";

import { isRecord } from "./object-guards.ts";

const recordSchema = v.custom<Record<string, unknown>>(isRecord);
const jsonValueSchema: v.BaseSchema<
  unknown,
  JsonValue,
  v.BaseIssue<unknown>
> = v.custom<JsonValue>(isJsonValue);

const rangeSchema = v.pipe(
  recordSchema,
  v.object({
    start: v.pipe(v.number(), v.integer(), v.minValue(0)),
    end: v.pipe(v.number(), v.integer(), v.minValue(0)),
  }),
  v.check(({ start, end }) => end >= start),
  v.readonly(),
);

const messageFamilyIssueSchema = v.pipe(
  recordSchema,
  v.object({
    code: v.pipe(v.string(), v.minLength(1)),
    message: v.string(),
    language: v.optional(v.string()),
    sourceKey: v.optional(v.string()),
    ref: v.optional(jsonValueSchema),
    range: v.optional(rangeSchema),
  }),
  v.readonly(),
);

const messageFragmentSchema = v.pipe(
  recordSchema,
  v.object({
    ref: jsonValueSchema,
    text: v.string(),
    protectedRanges: v.optional(v.pipe(v.array(rangeSchema), v.readonly())),
  }),
  v.check(
    ({ text, protectedRanges }) =>
      protectedRanges === undefined ||
      protectedRanges.every((range) => isTextRange(text, range)),
  ),
  v.readonly(),
);

const messageTextSchema = v.pipe(
  recordSchema,
  v.object({
    language: v.pipe(v.string(), v.minLength(1)),
    fragments: v.pipe(v.array(messageFragmentSchema), v.readonly()),
    complete: v.optional(v.boolean()),
    issues: v.optional(v.pipe(v.array(messageFamilyIssueSchema), v.readonly())),
  }),
  v.readonly(),
);

const messageFamilyGroupSchema = v.pipe(
  recordSchema,
  v.object({
    ref: jsonValueSchema,
    /** 宿主明确声明可相互参照的业务范围。 */
    scope: v.pipe(v.string(), v.minLength(1)),
    source: messageTextSchema,
    target: messageTextSchema,
  }),
  v.readonly(),
);

const messageFamilyInputShapeSchema = v.pipe(
  recordSchema,
  v.object({
    groups: v.pipe(v.array(messageFamilyGroupSchema), v.readonly()),
    /** false 表示仍有未投影的消息组；已知 groups 继续参与检查。 */
    complete: v.optional(v.boolean()),
    issues: v.optional(v.pipe(v.array(messageFamilyIssueSchema), v.readonly())),
  }),
  v.readonly(),
);

export type MessageFamilyIssue = v.InferOutput<typeof messageFamilyIssueSchema>;
export type MessageFragment = v.InferOutput<typeof messageFragmentSchema>;
export type MessageText = v.InferOutput<typeof messageTextSchema>;
export type MessageFamilyGroup = v.InferOutput<typeof messageFamilyGroupSchema>;
export type MessageFamilyInput = v.InferOutput<
  typeof messageFamilyInputShapeSchema
>;

/** 保留投影原对象的全部属性；形状 schema 只承担字段与业务约束验证。 */
export const messageFamilyInputSchema = v.custom<MessageFamilyInput>(
  (value): value is MessageFamilyInput =>
    v.safeParse(messageFamilyInputShapeSchema, value).success,
  "消息族投影必须包含有效的 groups。",
);
export type MessageFamilySignature = {
  readonly familyKey: string;
  readonly targetKey: string;
};
export type MessageFamilyReference = MessageFamilySignature & {
  readonly translationIndex: number;
  readonly sourceKey: string;
  readonly group: MessageFamilyGroup;
  readonly sourceSignatures: readonly TemplateSignature[];
  readonly targetSignatures: readonly TemplateSignature[];
  readonly translationLocation?: QualityLocation;
};
export const messageFamilyLimitsSchema = v.pipe(
  v.custom<Record<string, unknown>>(isRecord, "消息族展示配置无效。"),
  v.object(
    {
      maxCategories: v.pipe(
        v.number("消息族展示上限必须为正整数。"),
        v.integer("消息族展示上限必须为正整数。"),
        v.minValue(1, "消息族展示上限必须为正整数。"),
      ),
      maxSourcesPerCategory: v.pipe(
        v.number("消息族展示上限必须为正整数。"),
        v.integer("消息族展示上限必须为正整数。"),
        v.minValue(1, "消息族展示上限必须为正整数。"),
      ),
    },
    "消息族展示上限必须为正整数。",
  ),
  v.readonly(),
);
export type MessageFamilyLimits = v.InferOutput<
  typeof messageFamilyLimitsSchema
>;
type Category = {
  readonly key: string;
  readonly references: Map<number, MessageFamilyReference>;
};
type Family = {
  readonly categories: Map<string, Category>;
  readonly categoriesByRecord: Map<number, Set<string>>;
  referenceCount: number;
};
export type MessageFamilyIndex = {
  readonly families: ReadonlyMap<string, Family>;
};
export type MessageFamilyComparison = {
  readonly status: "no-comparison" | "consistent" | "different";
  /** 保存证据中的表达类别，不将候选重复计入。 */
  readonly categoryCount: number;
  readonly referenceCount: number;
  readonly omittedCategories: number;
  readonly omittedReferences: number;
  readonly categories: readonly {
    readonly key: string;
    readonly referenceCount: number;
    readonly references: readonly MessageFamilyReference[];
  }[];
};

function isJsonValue(value: unknown): value is JsonValue {
  try {
    snapshotJsonValue(value, "消息族投影引用");
    return true;
  } catch {
    return false;
  }
}

function isTextRange(text: string, range: TextRange): boolean {
  if (range.end > text.length) return false;
  return (
    isCodePointBoundary(text, range.start) &&
    isCodePointBoundary(text, range.end)
  );
}

function isCodePointBoundary(text: string, index: number): boolean {
  if (index === 0 || index === text.length) return true;
  const before = text.charCodeAt(index - 1);
  const after = text.charCodeAt(index);
  return !(
    before >= 0xd800 &&
    before <= 0xdbff &&
    after >= 0xdc00 &&
    after <= 0xdfff
  );
}

/** 固定证据只索引一次；同一物理记录在同一类别中的别名不重复计数。 */
export function indexMessageFamilies(
  references: readonly MessageFamilyReference[],
): MessageFamilyIndex {
  const families = new Map<string, Family>();
  for (const reference of references) {
    let family = families.get(reference.familyKey);
    if (family === undefined) {
      family = {
        categories: new Map(),
        categoriesByRecord: new Map(),
        referenceCount: 0,
      };
      families.set(reference.familyKey, family);
    }
    let category = family.categories.get(reference.targetKey);
    if (category === undefined) {
      category = { key: reference.targetKey, references: new Map() };
      family.categories.set(reference.targetKey, category);
    }
    if (category.references.has(reference.translationIndex)) continue;
    category.references.set(reference.translationIndex, reference);
    family.referenceCount++;
    let keys = family.categoriesByRecord.get(reference.translationIndex);
    if (keys === undefined) {
      keys = new Set();
      family.categoriesByRecord.set(reference.translationIndex, keys);
    }
    keys.add(reference.targetKey);
  }
  return { families };
}

/** 按候选替代的物理索引减去旧值；判断使用全量统计，输出只取有界代表。 */
export function compareMessageFamily(
  index: MessageFamilyIndex,
  candidate: MessageFamilySignature,
  excludedRecordIndexes: ReadonlySet<number>,
  limits: MessageFamilyLimits,
): MessageFamilyComparison {
  if (!v.safeParse(messageFamilyLimitsSchema, limits).success)
    throw new TypeError("消息族展示上限必须为正整数。");
  const family = index.families.get(candidate.familyKey);
  if (family === undefined)
    return {
      status: "no-comparison",
      categoryCount: 0,
      referenceCount: 0,
      omittedCategories: 0,
      omittedReferences: 0,
      categories: [],
    };
  const removed = new Map<string, number>();
  let referenceCount = family.referenceCount;
  let categoryCount = family.categories.size;
  for (const recordIndex of excludedRecordIndexes) {
    for (const key of family.categoriesByRecord.get(recordIndex) ?? []) {
      removed.set(key, (removed.get(key) ?? 0) + 1);
      referenceCount--;
    }
  }
  for (const [key, count] of removed) {
    if (family.categories.get(key)!.references.size === count) categoryCount--;
  }
  const ownCategory = family.categories.get(candidate.targetKey);
  const ownCount =
    (ownCategory?.references.size ?? 0) -
    (removed.get(candidate.targetKey) ?? 0);
  const different = referenceCount > ownCount;
  const categories: MessageFamilyComparison["categories"][number][] = [];
  let shownReferences = 0;
  // 优先展示与候选不同的类别，保证即使展示上限为 1 也保留差异依据。
  const append = (category: Category) => {
    const count = category.references.size - (removed.get(category.key) ?? 0);
    if (count === 0 || categories.length >= limits.maxCategories) return;
    const references: MessageFamilyReference[] = [];
    for (const [recordIndex, reference] of category.references) {
      if (excludedRecordIndexes.has(recordIndex)) continue;
      references.push(reference);
      if (references.length >= limits.maxSourcesPerCategory) break;
    }
    shownReferences += references.length;
    categories.push({ key: category.key, referenceCount: count, references });
  };
  if (different) {
    for (const category of family.categories.values()) {
      if (category.key !== candidate.targetKey) append(category);
      if (categories.length >= limits.maxCategories) break;
    }
  }
  if (ownCategory !== undefined) append(ownCategory);
  return {
    status:
      referenceCount === 0
        ? "no-comparison"
        : different
          ? "different"
          : "consistent",
    categoryCount,
    referenceCount,
    omittedCategories: categoryCount - categories.length,
    omittedReferences: referenceCount - shownReferences,
    categories,
  };
}
