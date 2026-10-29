import { snapshotJsonValue } from "@lioni/core";
import type {
  JsonValue,
  QualityLocation,
  TranslationIdentity,
} from "@lioni/core";
import type { TemplateSignature, TextRange } from "@lioni/text-analysis";
import { z } from "zod";

// 引用沿用核心无损 JSON 契约；z.json() 会跳过自有 __proto__，遗漏其中的非法值。
const referenceSchema = z.custom<JsonValue>((value) => {
  try {
    snapshotJsonValue(value, "消息族投影引用");
    return true;
  } catch {
    return false;
  }
}, "消息族投影引用必须是无损 JSON 值。");

const rangeSchema = z
  .object({
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
  })
  .refine(({ start, end }) => end >= start, "范围终点不得早于起点。")
  .readonly();

const messageFamilyIssueSchema = z
  .object({
    code: z.string().min(1),
    message: z.string(),
    language: z.string().optional(),
    sourceKey: z.string().optional(),
    ref: referenceSchema.optional(),
    range: rangeSchema.optional(),
  })
  .readonly();

const messageFragmentSchema = z
  .object({
    ref: referenceSchema,
    text: z.string(),
    protectedRanges: z.array(rangeSchema).readonly().optional(),
  })
  .refine(
    ({ text, protectedRanges }) =>
      protectedRanges === undefined ||
      protectedRanges.every((range) => isTextRange(text, range)),
    "保护范围必须落在文本中的完整 Unicode 字符边界上。",
  )
  .readonly();

const messageTextSchema = z
  .object({
    language: z.string().min(1),
    fragments: z.array(messageFragmentSchema).readonly(),
    complete: z.boolean().optional(),
    issues: z.array(messageFamilyIssueSchema).readonly().optional(),
  })
  .readonly();

const messageFamilyGroupSchema = z
  .object({
    ref: referenceSchema,
    /** 宿主明确声明可相互参照的业务范围。 */
    scope: z.string().min(1),
    source: messageTextSchema,
    target: messageTextSchema,
  })
  .readonly();

const messageFamilyInputShapeSchema = z
  .object({
    groups: z.array(messageFamilyGroupSchema).readonly(),
    /** false 表示仍有未投影的消息组；单个目标正文缺失由 target.complete 表达。 */
    complete: z.boolean().optional(),
    issues: z.array(messageFamilyIssueSchema).readonly().optional(),
  })
  .readonly() satisfies z.ZodType<MessageFamilyInput>;

export type MessageFamilyIssue = {
  readonly code: string;
  readonly message: string;
  readonly language?: string | undefined;
  readonly sourceKey?: string | undefined;
  readonly ref?: JsonValue | undefined;
  readonly range?: TextRange | undefined;
};
export type MessageFragment = {
  readonly ref: JsonValue;
  readonly text: string;
  readonly protectedRanges?: readonly TextRange[] | undefined;
};
export type MessageText = {
  readonly language: string;
  readonly fragments: readonly MessageFragment[];
  readonly complete?: boolean | undefined;
  readonly issues?: readonly MessageFamilyIssue[] | undefined;
};
export type MessageFamilyGroup = {
  readonly ref: JsonValue;
  readonly scope: string;
  readonly source: MessageText;
  readonly target: MessageText;
};
export type MessageFamilyInput = {
  readonly groups: readonly MessageFamilyGroup[];
  readonly complete?: boolean | undefined;
  readonly issues?: readonly MessageFamilyIssue[] | undefined;
};

/** 投影包含宿主引用与扩展属性；验证契约后保留原值，不让对象解析裁剪它们。 */
export const messageFamilyInputSchema = z
  .unknown()
  .transform((value, context) => {
    const parsed = messageFamilyInputShapeSchema.safeParse(value);
    if (!parsed.success) {
      for (const issue of parsed.error.issues)
        context.issues.push({
          code: "custom",
          message: issue.message,
          path: issue.path,
          input: value,
        });
      return z.NEVER;
    }
    return value as MessageFamilyInput;
  });
export type MessageFamilySignature = {
  readonly familyKey: string;
  readonly targetKey: string;
};
export type MessageFamilyReference = MessageFamilySignature & {
  readonly translationIndex: number;
  readonly translationIdentity: TranslationIdentity;
  readonly sourceKey: string;
  readonly group: MessageFamilyGroup;
  readonly sourceSignatures: readonly TemplateSignature[];
  readonly targetSignatures: readonly TemplateSignature[];
  readonly translationLocation?: QualityLocation;
};
export const messageFamilyLimitsSchema = z
  .object({
    maxCategories: z.number().int().positive(),
    maxSourcesPerCategory: z.number().int().positive(),
  })
  .readonly();
export type MessageFamilyLimits = {
  readonly maxCategories: number;
  readonly maxSourcesPerCategory: number;
};
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
  // 同一物理记录可能映射出多个等价组；完整证据决定代表，不能让排序平局依赖宿主遍历顺序。
  const ordered = references
    .map((reference) => ({
      reference,
      key: messageFamilyEvidenceKey([
        reference.targetKey,
        reference.translationIdentity,
        reference.sourceKey,
        reference.group.ref,
        reference.group.scope,
        reference.group.source,
        reference.group.target,
        reference.sourceSignatures.map(messageFamilySignatureEvidence),
        reference.targetSignatures.map(messageFamilySignatureEvidence),
        reference.translationLocation ?? null,
      ]),
    }))
    .sort((left, right) =>
      left.key < right.key ? -1 : left.key > right.key ? 1 : 0,
    )
    .map(({ reference }) => reference);
  for (const reference of ordered) {
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
  if (!messageFamilyLimitsSchema.safeParse(limits).success)
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

/** 指纹准备、代表选择和报告共同使用的签名证据，省略识别器私有值。 */
export function messageFamilySignatureEvidence(signature: TemplateSignature) {
  return {
    parts: signature.parts,
    slots: signature.slots.map(({ start, end, kind, identity, raw }) => ({
      start,
      end,
      kind,
      identity,
      raw,
    })),
  };
}

/** JSON 对象属性顺序不参与消息族证据排序，数组顺序仍表达业务内容。 */
export function messageFamilyEvidenceKey(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item !== null && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([left], [right]) =>
            left < right ? -1 : left > right ? 1 : 0,
          ),
        )
      : item,
  );
}
