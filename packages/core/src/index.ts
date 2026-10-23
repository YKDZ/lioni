import { createHash } from "node:crypto";

export type Awaitable<T> = T | Promise<T>;

export type TranslationUnitInput = {
  readonly source: string;
  readonly context?: unknown;
};

export type SourceAdapter<TUnit extends TranslationUnitInput> = {
  readUnits(): Awaitable<readonly TUnit[]>;
};

export type FrameworkConfig<TUnit extends TranslationUnitInput> = {
  readonly source: SourceAdapter<TUnit>;
  readonly keyOf: (unit: TUnit) => string;
};

export type SourceUnitFact<TUnit extends TranslationUnitInput> = {
  readonly key: string;
  readonly unit: TUnit;
};

export type SourceFacts<TUnit extends TranslationUnitInput> = {
  readonly version: string;
  readonly units: readonly SourceUnitFact<TUnit>[];
};

export class DuplicateTranslationUnitKeyError extends Error {
  readonly key: string;
  readonly firstIndex: number;
  readonly duplicateIndex: number;

  constructor(key: string, firstIndex: number, duplicateIndex: number) {
    super(
      `原文单元身份重复：${JSON.stringify(key)}（第 ${firstIndex + 1} 与第 ${duplicateIndex + 1} 个单元）`,
    );
    this.name = "DuplicateTranslationUnitKeyError";
    this.key = key;
    this.firstIndex = firstIndex;
    this.duplicateIndex = duplicateIndex;
  }
}

export function defineConfig<const TUnit extends TranslationUnitInput>(
  config: FrameworkConfig<TUnit>,
): FrameworkConfig<TUnit> {
  return config;
}

export async function readSourceFacts<TUnit extends TranslationUnitInput>(
  config: FrameworkConfig<TUnit>,
): Promise<SourceFacts<TUnit>> {
  const rawUnits = await config.source.readUnits();
  const firstIndexes = new Map<string, number>();
  const units: SourceUnitFact<TUnit>[] = [];
  for (const [index, unit] of rawUnits.entries()) {
    const key = config.keyOf(unit);
    const firstIndex = firstIndexes.get(key);
    if (firstIndex !== undefined)
      throw new DuplicateTranslationUnitKeyError(key, firstIndex, index);
    firstIndexes.set(key, index);
    units.push({ key, unit });
  }
  return {
    version: sourceFactsVersion(units),
    units,
  };
}

function sourceFactsVersion<TUnit extends TranslationUnitInput>(
  units: readonly SourceUnitFact<TUnit>[],
): string {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(units);
  } catch (error) {
    throw new TypeError("原文单元及上下文必须可序列化为 JSON。", {
      cause: error,
    });
  }
  if (serialized === undefined)
    throw new TypeError("原文单元及上下文必须可序列化为 JSON。");
  return `sha256:${createHash("sha256").update(serialized).digest("hex")}`;
}
