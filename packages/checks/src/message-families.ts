import type { JsonValue } from "@lioni/core";
import type { TemplateSignature, TextRange } from "@lioni/text-analysis";

export type MessageFragment = {
  readonly ref: JsonValue;
  readonly text: string;
  readonly protectedRanges?: readonly TextRange[];
};
export type MessageText = {
  readonly language: string;
  readonly fragments: readonly MessageFragment[];
  readonly complete?: boolean;
};
export type MessageFamilyGroup = {
  readonly ref: JsonValue;
  /** 宿主明确声明可相互参照的业务范围。 */
  readonly scope: string;
  readonly source: MessageText;
  readonly target: MessageText;
};
export type MessageFamilyInput = {
  readonly groups: readonly MessageFamilyGroup[];
};
export type MessageFamilyEvidenceInput = {
  readonly complete: boolean;
  readonly records: readonly {
    readonly translationIndex: number;
    readonly sourceKey: string;
    readonly groups: readonly MessageFamilyGroup[];
  }[];
};
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
};
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
  if (
    !Number.isInteger(limits.maxCategories) ||
    limits.maxCategories < 1 ||
    !Number.isInteger(limits.maxSourcesPerCategory) ||
    limits.maxSourcesPerCategory < 1
  )
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
