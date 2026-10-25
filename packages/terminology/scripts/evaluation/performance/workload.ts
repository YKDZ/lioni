import type {
  TermComparisonInput,
  TermDiscoveryCorpus,
  TermbaseData,
} from "@lioni/terminology";

import type { CfpaPreparedInput } from "../corpora/convert.ts";
import { canonicalJson, sha256 } from "../support/json.ts";

export type PerformanceWorkloadFacts = {
  readonly comparisonGroups: number;
  readonly concepts: number;
  readonly expressions: number;
  readonly sourceTexts: number;
  readonly targetTexts: number;
  readonly uniqueTexts: number;
  readonly sourceCodepoints: number;
  readonly targetCodepoints: number;
  readonly sourceUtf16Units: number;
  readonly targetUtf16Units: number;
  readonly hardShapes: Readonly<Record<string, number>>;
};

export type PerformanceMemoMode = "no-memo" | "empty-scope" | "reused-scope";

export type PerformancePreparedInput = {
  readonly schemaVersion: 1;
  readonly id: "controlled-scale" | "cfpa";
  readonly termbase: TermbaseData;
  readonly comparison: TermComparisonInput;
  readonly discovery: TermDiscoveryCorpus;
  readonly facts: PerformanceWorkloadFacts;
  readonly generation?: {
    readonly algorithm: "lioni-terminology-scale-v1";
    readonly seed: number;
    readonly conceptStride: number;
    readonly groupCount: number;
    readonly conceptCount: number;
    readonly expressionsPerConcept: number;
    readonly shapeCounts: Readonly<Record<string, number>>;
  };
  readonly external?: {
    readonly id: "cfpa";
    readonly source: CfpaPreparedInput["source"];
    readonly transformedInputSha256: string;
    readonly selections: CfpaPreparedInput["selections"];
  };
};

export type ControlledWorkloadOptions = {
  readonly groupCount?: number;
  readonly conceptCount?: number;
  readonly seed?: number;
};

export type PreparedPerformanceWorkload = {
  readonly input: PerformancePreparedInput;
  readonly inputSha256: string;
};

const defaultGroupCount = 10_000;
const defaultConceptCount = 1_000;
const defaultSeed = 20_261_025;
const discoveryPolicy = Object.freeze({
  maxWords: 3,
  maxCharacters: 80,
  minOccurrences: 2,
  limit: 100_000,
  maxExamples: 2,
});

function letters(index: number): string {
  let value = index;
  let result = "";
  do {
    result = String.fromCharCode(97 + (value % 26)) + result;
    value = Math.floor(value / 26) - 1;
  } while (value >= 0);
  return result;
}

function greatestCommonDivisor(left: number, right: number): number {
  let a = left;
  let b = right;
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

function conceptStride(conceptCount: number, seed: number): number {
  if (conceptCount <= 1) return 1;
  let stride = Math.abs(seed) % conceptCount || 1;
  while (greatestCommonDivisor(stride, conceptCount) !== 1)
    stride = (stride + 1) % conceptCount || 1;
  return stride;
}

function textStats(values: readonly string[]) {
  return Object.freeze({
    codepoints: values.reduce(
      (sum, value) => sum + Array.from(value).length,
      0,
    ),
    utf16Units: values.reduce((sum, value) => sum + value.length, 0),
  });
}

function workloadFacts(
  termbase: TermbaseData,
  comparison: TermComparisonInput,
  hardShapes: Readonly<Record<string, number>>,
): PerformanceWorkloadFacts {
  const sourceTexts = comparison.groups.map(
    ({ source }) => source.fragments[0]?.text ?? "",
  );
  const targetTexts = comparison.groups.map(
    ({ target }) => target.fragments[0]?.text ?? "",
  );
  const sourceStats = textStats(sourceTexts);
  const targetStats = textStats(targetTexts);
  return Object.freeze({
    comparisonGroups: comparison.groups.length,
    concepts: termbase.concepts.length,
    expressions: termbase.concepts.reduce(
      (sum, concept) =>
        sum +
        concept.languages.reduce(
          (count, language) => count + language.expressions.length,
          0,
        ),
      0,
    ),
    sourceTexts: new Set(sourceTexts).size,
    targetTexts: new Set(targetTexts).size,
    uniqueTexts: new Set([...sourceTexts, ...targetTexts]).size,
    sourceCodepoints: sourceStats.codepoints,
    targetCodepoints: targetStats.codepoints,
    sourceUtf16Units: sourceStats.utf16Units,
    targetUtf16Units: targetStats.utf16Units,
    hardShapes,
  });
}

function shapeOf(
  groupIndex: number,
): "regular" | "long" | "unicode" | "punctuation" {
  const slot = groupIndex % 1_000;
  if (slot < 10) return "long";
  if (slot < 15) return "unicode";
  if (slot < 25) return "punctuation";
  return "regular";
}

function contextSuffix(
  groupIndex: number,
  shape: ReturnType<typeof shapeOf>,
): {
  readonly source: string;
  readonly target: string;
} {
  const groupLabel = letters(groupIndex);
  if (shape === "long")
    return {
      source: ` ${Array.from({ length: 48 }, (_, index) => `detail ${letters(groupIndex + index + 1)}`).join(" ")}`,
      target: ` ${Array.from({ length: 48 }, (_, index) => `附加说明${letters(groupIndex + index + 1)}`).join(" ")}`,
    };
  if (shape === "unicode")
    return {
      source: ` résumé ﬁle ${groupLabel}`,
      target: ` 文本 café ﬁle ${groupLabel}`,
    };
  if (shape === "punctuation")
    return {
      source: ` [case: ${groupLabel}] — checked.`,
      target: `（案例：${groupLabel}）——已检查。`,
    };
  return { source: ` case ${groupLabel}.`, target: ` 案例${groupLabel}。` };
}

export function createControlledPerformanceWorkload(
  options: ControlledWorkloadOptions = {},
): PreparedPerformanceWorkload {
  const groupCount = options.groupCount ?? defaultGroupCount;
  const conceptCount = options.conceptCount ?? defaultConceptCount;
  const seed = options.seed ?? defaultSeed;
  if (
    !Number.isSafeInteger(groupCount) ||
    groupCount < 1 ||
    groupCount > 100_000
  )
    throw new RangeError("规模场景比较组数必须在 1 到 100000 之间。");
  if (
    !Number.isSafeInteger(conceptCount) ||
    conceptCount < 1 ||
    conceptCount > groupCount
  )
    throw new RangeError("规模场景概念数必须在 1 到比较组数之间。");
  if (!Number.isSafeInteger(seed) || seed < 0)
    throw new RangeError("规模场景种子必须是非负安全整数。");

  const stride = conceptStride(conceptCount, seed);
  const concepts = Array.from({ length: conceptCount }, (_, conceptIndex) => {
    const label = letters(conceptIndex);
    return Object.freeze({
      id: `concept-${label}`,
      languages: Object.freeze([
        Object.freeze({
          language: "en",
          expressions: Object.freeze([
            {
              id: `en-item-${label}`,
              text: `catalog item ${label}`,
              usage: "preferred" as const,
            },
            {
              id: `en-component-${label}`,
              text: `catalog component ${label}`,
              usage: "allowed" as const,
            },
          ]),
        }),
        Object.freeze({
          language: "zh-CN",
          expressions: Object.freeze([
            {
              id: `zh-term-${label}`,
              text: `术语${label}`,
              usage: "preferred" as const,
            },
            {
              id: `zh-component-${label}`,
              text: `组件${label}`,
              usage: "allowed" as const,
            },
          ]),
        }),
      ]),
    });
  });
  const shapeCounts: Record<string, number> = {
    regular: 0,
    long: 0,
    unicode: 0,
    punctuation: 0,
  };
  const groups = Array.from({ length: groupCount }, (_, groupIndex) => {
    const conceptIndex =
      (groupIndex * stride + (seed % conceptCount)) % conceptCount;
    const conceptLabel = letters(conceptIndex);
    const variant = groupIndex % 2 === 1;
    const sourceTerm = variant
      ? `catalog component ${conceptLabel}`
      : `catalog item ${conceptLabel}`;
    const targetTerm = variant ? `组件${conceptLabel}` : `术语${conceptLabel}`;
    const shape = shapeOf(groupIndex);
    shapeCounts[shape] = (shapeCounts[shape] ?? 0) + 1;
    const suffix = contextSuffix(groupIndex, shape);
    return Object.freeze({
      ref: `group-${groupIndex}`,
      source: Object.freeze({
        language: "en",
        fragments: Object.freeze([
          Object.freeze({
            ref: `source-${groupIndex}`,
            text: `${sourceTerm} stores${suffix.source}`,
          }),
        ]),
      }),
      target: Object.freeze({
        language: "zh-CN",
        fragments: Object.freeze([
          Object.freeze({
            ref: `target-${groupIndex}`,
            text: `${targetTerm} 已保存${suffix.target}`,
          }),
        ]),
      }),
    });
  });
  const comparison: TermComparisonInput = Object.freeze({
    groups: Object.freeze(groups),
  });
  const sourceEntries = comparison.groups.map(({ ref, source }, index) =>
    Object.freeze({
      ref: ref ?? `group-${index}`,
      fragments: source.fragments,
    }),
  );
  const discovery: TermDiscoveryCorpus = Object.freeze({
    language: "en",
    entries: Object.freeze(sourceEntries),
  });
  const termbase: TermbaseData = Object.freeze({
    concepts: Object.freeze(concepts),
  });
  const hardShapes = Object.freeze(shapeCounts);
  const input: PerformancePreparedInput = Object.freeze({
    schemaVersion: 1,
    id: "controlled-scale",
    termbase,
    comparison,
    discovery,
    facts: workloadFacts(termbase, comparison, hardShapes),
    generation: Object.freeze({
      algorithm: "lioni-terminology-scale-v1",
      seed,
      conceptStride: stride,
      groupCount,
      conceptCount,
      expressionsPerConcept: 4,
      shapeCounts: hardShapes,
    }),
  });
  return Object.freeze({ input, inputSha256: sha256(canonicalJson(input)) });
}

export function createCfpaPerformanceWorkload(
  prepared: CfpaPreparedInput,
  transformedInputSha256: string,
): PreparedPerformanceWorkload {
  const corpus = prepared.corpora.en;
  if (!corpus) throw new Error("CFPA 固定输入缺少英语候选发现语料。");
  const hardShapes = Object.freeze({
    "source-has-protected-ranges": prepared.comparison.groups.filter(
      ({ source }) =>
        source.fragments.some(
          ({ protectedRanges }) => (protectedRanges?.length ?? 0) > 0,
        ),
    ).length,
    "source-is-incomplete": prepared.comparison.groups.filter(
      ({ source }) => source.complete === false,
    ).length,
    "target-is-incomplete": prepared.comparison.groups.filter(
      ({ target }) => target.complete === false,
    ).length,
  });
  const input: PerformancePreparedInput = Object.freeze({
    schemaVersion: 1,
    id: "cfpa",
    termbase: prepared.referenceTermbase,
    comparison: prepared.comparison,
    discovery: corpus,
    facts: workloadFacts(
      prepared.referenceTermbase,
      prepared.comparison,
      hardShapes,
    ),
    external: Object.freeze({
      id: "cfpa",
      source: prepared.source,
      transformedInputSha256,
      selections: prepared.selections,
    }),
  });
  return Object.freeze({ input, inputSha256: sha256(canonicalJson(input)) });
}

export const performanceDiscoveryPolicy = discoveryPolicy;
