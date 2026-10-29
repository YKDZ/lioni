import { z } from "zod";

import {
  complementRanges,
  emptyRanges,
  fitsRange,
  mergeRanges,
  validateInput,
  validateRangeBounds,
} from "./ranges.ts";
import { createTemplateSignature } from "./templates.ts";
import type { TemplateOptions, TemplateSignature } from "./templates.ts";
import {
  TextAnalysisContractError,
  analysisError,
  recognitionSchema,
  textTokenSchema,
  wordAnalysisSchema,
} from "./types.ts";
import type {
  AnalysisRuntime,
  RecognitionResult,
  StructureAnalysis,
  TextAnalysisIssue,
  TextInput,
  TextRange,
  TextRecognizer,
  TextToken,
  WordAnalysis,
  WordSegmenter,
} from "./types.ts";
import { segmentWords } from "./words.ts";

function copyIssues(
  text: string,
  value: readonly TextAnalysisIssue[],
): readonly TextAnalysisIssue[] {
  return Object.freeze(
    value.map((issue) => {
      if (issue.range !== undefined) validateRangeBounds(text, issue.range);
      return Object.freeze({
        code: issue.code,
        message: issue.message,
        ...(issue.range === undefined
          ? {}
          : { range: Object.freeze({ ...issue.range }) }),
      });
    }),
  );
}

const recognizedSchema = z.compile(
  z.union([z.array(textTokenSchema), recognitionSchema]),
);
function recognitionResult(
  value: readonly TextToken[] | RecognitionResult,
): RecognitionResult {
  if (!recognizedSchema.validate(value))
    throw analysisError(
      "invalid-recognition",
      recognizedSchema.safeParse(value).error!,
    );
  // 只验证形状；保留宿主 token 的附加字段和值身份。
  return Array.isArray(value)
    ? { tokens: value, complete: true, issues: [] }
    : (value as RecognitionResult);
}

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
    const protectedRanges = mergeRanges(text, inputProtectedRanges);
    const tokens: TextToken[] = [];
    const issues: TextAnalysisIssue[] = [];
    let complete = true;
    for (const recognizer of recognizers) {
      const availableRanges = complementRanges(
        text,
        mergeRanges(text, [...protectedRanges, ...tokens]),
      );
      const recognized = recognitionResult(
        await recognizer({ text, language, protectedRanges, availableRanges }),
      );
      complete = complete && recognized.complete;
      issues.push(...copyIssues(text, recognized.issues));
      const sorted = [...recognized.tokens].sort(
        (a, b) => a.start - b.start || a.end - b.end,
      );
      let previousEnd = -1;
      for (const token of sorted) {
        validateRangeBounds(text, token);
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
      complete,
      issues: Object.freeze(issues),
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
    if (!wordAnalysisSchema.validate(result))
      throw analysisError(
        "invalid-segmentation",
        wordAnalysisSchema.safeParse(result).error!,
      );
    let previousEnd = -1;
    for (const word of result.words) {
      validateRangeBounds(analysis.text, word);
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
      validateRangeBounds(
        analysis.text,
        { start: boundary, end: boundary },
        true,
      );
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
    const issues = copyIssues(analysis.text, result.issues);
    return Object.freeze({
      words: Object.freeze(
        result.words.map((word) => Object.freeze({ ...word })),
      ),
      boundaries: Object.freeze(
        [...new Set(result.boundaries)].sort((a, b) => a - b),
      ),
      complete: analysis.complete && result.complete,
      issues: Object.freeze([...analysis.issues, ...issues]),
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
    validateInput(input);
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
