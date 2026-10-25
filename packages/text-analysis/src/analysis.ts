import {
  complementRanges,
  emptyRanges,
  fitsRange,
  mergeRanges,
  validateInput,
  validateRange,
} from "./ranges.ts";
import { createTemplateSignature } from "./templates.ts";
import type { TemplateOptions, TemplateSignature } from "./templates.ts";
import { TextAnalysisContractError } from "./types.ts";
import type {
  AnalysisRuntime,
  StructureAnalysis,
  TextInput,
  TextRange,
  TextRecognizer,
  TextToken,
  WordAnalysis,
  WordSegmenter,
} from "./types.ts";
import { segmentWords } from "./words.ts";

export type TextAnalysisOptions = {
  readonly recognizers?: readonly TextRecognizer[];
  readonly segmenter?: WordSegmenter;
};

export type TextAnalysis = {
  readonly structures: (
    input: TextInput,
    runtime?: AnalysisRuntime,
  ) => Promise<StructureAnalysis>;
  readonly words: (
    input: TextInput,
    runtime?: AnalysisRuntime,
  ) => Promise<WordAnalysis>;
  readonly signature: (
    input: TextInput,
    options: TemplateOptions,
    runtime?: AnalysisRuntime,
  ) => Promise<TemplateSignature>;
};

/** 配置只固定函数和政策；调用时才计算，借入的 memo 生命周期由调用方管理。 */
export function createTextAnalysis(
  options: TextAnalysisOptions = {},
): TextAnalysis {
  const recognizers = [...(options.recognizers ?? [])];
  const segmenter = options.segmenter ?? segmentWords;

  async function computeStructures(
    text: string,
    language: string,
    inputProtectedRanges: readonly TextRange[],
  ): Promise<StructureAnalysis> {
    validateInput({ text, language });
    const protectedRanges = mergeRanges(text, inputProtectedRanges);
    const tokens: TextToken[] = [];
    for (const recognizer of recognizers) {
      const availableRanges = complementRanges(
        text,
        mergeRanges(text, [...protectedRanges, ...tokens]),
      );
      const recognized = await recognizer({
        text,
        language,
        protectedRanges,
        availableRanges,
      });
      if (!Array.isArray(recognized))
        throw new TextAnalysisContractError(
          "invalid-tokens",
          "识别器必须返回 token 数组。",
        );
      const sorted = [...recognized].sort(
        (a, b) => a.start - b.start || a.end - b.end,
      );
      let previousEnd = -1;
      for (const token of sorted) {
        validateRange(text, token);
        if (
          typeof token.kind !== "string" ||
          token.kind.length === 0 ||
          (token.identity !== undefined &&
            (typeof token.identity !== "string" ||
              token.identity.length === 0)) ||
          (token.protect !== undefined && typeof token.protect !== "boolean")
        )
          throw new TextAnalysisContractError(
            "invalid-token",
            "token 种类、身份或保护标志不符合契约。",
          );
        if (!fitsRange(token, availableRanges) || token.start < previousEnd)
          throw new TextAnalysisContractError(
            "overlapping-token",
            "识别结果必须位于可用范围内且互不重叠。",
          );
        tokens.push(Object.freeze({ ...token }));
        previousEnd = token.end;
      }
    }
    tokens.sort((a, b) => a.start - b.start);
    const effectiveProtectedRanges = mergeRanges(text, [
      ...protectedRanges,
      ...tokens.filter((token) => token.protect === true),
    ]);
    return Object.freeze({
      text,
      language,
      tokens: Object.freeze(tokens),
      protectedRanges: effectiveProtectedRanges,
      availableRanges: complementRanges(text, effectiveProtectedRanges),
      complete: true,
      issues: Object.freeze([]),
    });
  }

  async function computeWords(
    analysis: StructureAnalysis,
  ): Promise<WordAnalysis> {
    const result = await segmenter({
      text: analysis.text,
      language: analysis.language,
      protectedRanges: analysis.protectedRanges,
    });
    if (
      !Array.isArray(result.words) ||
      !Array.isArray(result.boundaries) ||
      !Array.isArray(result.issues) ||
      typeof result.complete !== "boolean"
    )
      throw new TextAnalysisContractError(
        "invalid-segmentation",
        "分词器必须返回词、边界、完整性与问题。",
      );
    let previousEnd = -1;
    for (const word of result.words) {
      validateRange(analysis.text, word);
      if (
        !fitsRange(word, analysis.availableRanges) ||
        word.start < previousEnd ||
        word.text !== analysis.text.slice(word.start, word.end)
      )
        throw new TextAnalysisContractError(
          "invalid-segmentation",
          "词必须按原文顺序定位于可用范围，文本须与原文一致。",
        );
      previousEnd = word.end;
    }
    for (const boundary of result.boundaries) {
      validateRange(analysis.text, { start: boundary, end: boundary }, true);
      if (
        analysis.protectedRanges.some(
          (range) => range.start < boundary && boundary < range.end,
        )
      )
        throw new TextAnalysisContractError(
          "invalid-segmentation",
          "词界不能位于受保护区间内部。",
        );
    }
    return Object.freeze({
      words: Object.freeze(
        result.words.map((word) => Object.freeze({ ...word })),
      ),
      boundaries: Object.freeze(
        [...new Set(result.boundaries)].sort((a, b) => a - b),
      ),
      complete: result.complete,
      issues: Object.freeze(
        result.issues.map((issue) => Object.freeze({ ...issue })),
      ),
    });
  }

  function computeSignature(
    analysis: StructureAnalysis,
    policy: TemplateOptions,
  ): TemplateSignature {
    return createTemplateSignature(analysis, policy);
  }

  function structureKey(
    text: string,
    language: string,
    protectedRanges: readonly TextRange[],
  ): readonly unknown[] {
    return [
      text,
      language,
      ...protectedRanges.flatMap((range) => [range.start, range.end]),
    ];
  }

  function signatureInputKey(
    analysis: StructureAnalysis,
    policy: TemplateOptions,
  ): readonly unknown[] {
    return [analysis, policy.abstract];
  }

  function structures(
    input: TextInput,
    runtime: AnalysisRuntime = {},
  ): Promise<StructureAnalysis> {
    const compute =
      runtime.memo?.memo(computeStructures, { key: structureKey }) ??
      computeStructures;
    return compute(
      input.text,
      input.language,
      input.protectedRanges ?? emptyRanges,
    );
  }

  return Object.freeze({
    structures,
    words: async (input: TextInput, runtime: AnalysisRuntime = {}) => {
      const structure = await structures(input, runtime);
      const compute = runtime.memo?.memo(computeWords) ?? computeWords;
      return compute(structure);
    },
    signature: async (
      input: TextInput,
      policy: TemplateOptions,
      runtime: AnalysisRuntime = {},
    ) => {
      const structure = await structures(input, runtime);
      const compute =
        runtime.memo?.memo(computeSignature, { key: signatureInputKey }) ??
        computeSignature;
      return compute(structure, policy);
    },
  });
}
