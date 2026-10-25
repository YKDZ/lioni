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
  value: unknown,
  code: string,
): readonly TextAnalysisIssue[] {
  if (!Array.isArray(value))
    throw new TextAnalysisContractError(code, "分析问题必须是数组。");
  return Object.freeze(
    value.map((issue: unknown) => {
      if (typeof issue !== "object" || issue === null || Array.isArray(issue))
        throw new TextAnalysisContractError(code, "分析问题格式无效。");
      const record = issue as Record<string, unknown>;
      if (
        typeof record.code !== "string" ||
        record.code.length === 0 ||
        typeof record.message !== "string"
      )
        throw new TextAnalysisContractError(code, "分析问题格式无效。");
      let range: TextRange | undefined;
      if (record.range !== undefined) {
        if (
          typeof record.range !== "object" ||
          record.range === null ||
          Array.isArray(record.range)
        )
          throw new TextAnalysisContractError(code, "分析问题区间无效。");
        range = record.range as TextRange;
        validateRange(text, range);
      }
      return Object.freeze({
        code: record.code,
        message: record.message,
        ...(range === undefined
          ? {}
          : { range: Object.freeze({ start: range.start, end: range.end }) }),
      });
    }),
  );
}

function recognitionResult(
  value: readonly TextToken[] | RecognitionResult,
): RecognitionResult {
  if (Array.isArray(value))
    return { tokens: value, complete: true, issues: [] };
  const result = value as RecognitionResult;
  if (
    typeof value !== "object" ||
    value === null ||
    !Array.isArray(result.tokens) ||
    typeof result.complete !== "boolean" ||
    !Array.isArray(result.issues)
  )
    throw new TextAnalysisContractError(
      "invalid-recognition",
      "识别器必须返回 token 数组或带完整性与问题的分析结果。",
    );
  return result;
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
    validateInput({ text, language });
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
      issues.push(
        ...copyIssues(text, recognized.issues, "invalid-recognition"),
      );
      for (const token of recognized.tokens) {
        if (typeof token !== "object" || token === null || Array.isArray(token))
          throw new TextAnalysisContractError(
            "invalid-token",
            "识别结果中的 token 格式无效。",
          );
        validateRange(text, token);
      }
      const sorted = [...recognized.tokens].sort(
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
    const issues = copyIssues(
      analysis.text,
      result.issues,
      "invalid-segmentation",
    );
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
