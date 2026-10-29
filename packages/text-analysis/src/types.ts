import type { MemoScope } from "@lioni/memo";
import { z } from "zod";

/** 原文中的 UTF-16 半开区间，不切开代理对。 */
export type TextRange = {
  readonly start: number;
  readonly end: number;
};

export type TextInput = {
  readonly text: string;
  readonly language: string;
  readonly protectedRanges?: readonly TextRange[];
};

export type TextAnalysisIssue = {
  readonly code: string;
  readonly message: string;
  readonly range?: TextRange;
};

export type TextToken = TextRange & {
  readonly kind: string;
  readonly identity?: string;
  readonly value?: unknown;
  /** 显式保护该区间；种类名称不隐式决定保护行为。 */
  readonly protect?: boolean;
};

/** Recognizer 的已知命中与能力完整性分别表达；返回 token 数组是完整结果的简写。 */
export type RecognitionResult = {
  /** 此识别器能确认的命中；不完整结果仍保留这些命中。 */
  readonly tokens: readonly TextToken[];
  /** false 表示本识别器的可用范围内仍可能有未报告命中。 */
  readonly complete: boolean;
  /** 与本识别器限制或分析结果相关的问题。 */
  readonly issues: readonly TextAnalysisIssue[];
};

export type RecognitionInput = TextInput & {
  /** 尚未被保护或由更高优先级识别器占用的原文区间。 */
  readonly availableRanges: readonly TextRange[];
};

export type TextRecognizer = (
  input: RecognitionInput,
) =>
  | readonly TextToken[]
  | RecognitionResult
  | Promise<readonly TextToken[] | RecognitionResult>;

export type StructureAnalysis = {
  readonly text: string;
  readonly language: string;
  readonly tokens: readonly TextToken[];
  readonly protectedRanges: readonly TextRange[];
  readonly availableRanges: readonly TextRange[];
  /** 所有配置的识别器均完整时为 true；已知命中可与问题同时存在。 */
  readonly complete: boolean;
  /** 按识别器配置顺序累积的问题。 */
  readonly issues: readonly TextAnalysisIssue[];
};

export type WordToken = TextRange & { readonly text: string };

export type WordAnalysis = {
  readonly words: readonly WordToken[];
  readonly boundaries: readonly number[];
  /** 结构和词界阶段均完整时为 true；两阶段的问题按顺序合并。 */
  readonly complete: boolean;
  /** 结构问题先于词界问题，均保留原始范围和说明。 */
  readonly issues: readonly TextAnalysisIssue[];
};

export type WordSegmenter = (
  input: TextInput,
) => WordAnalysis | Promise<WordAnalysis>;

export type AnalysisRuntime = { readonly memo?: MemoScope };

export class TextAnalysisContractError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "TextAnalysisContractError";
    this.code = code;
  }
}

export const textRangeSchema = z
  .object({ start: z.int().nonnegative(), end: z.int().nonnegative() })
  .readonly() satisfies z.ZodType<TextRange>;
export const textInputSchema = z
  .object({
    text: z.string(),
    language: z.string().min(1),
    protectedRanges: z.array(textRangeSchema).readonly().exactOptional(),
  })
  .readonly() satisfies z.ZodType<TextInput>;
export const analysisIssueSchema = z
  .object({
    code: z.string().min(1),
    message: z.string(),
    range: textRangeSchema.exactOptional(),
  })
  .readonly() satisfies z.ZodType<TextAnalysisIssue>;
export const textTokenSchema = textRangeSchema
  .unwrap()
  .extend({
    kind: z.string().min(1),
    identity: z.string().min(1).exactOptional(),
    value: z.unknown().exactOptional(),
    /** 显式保护该区间；种类名称不隐式决定保护行为。 */
    protect: z.boolean().exactOptional(),
  })
  .readonly() satisfies z.ZodType<TextToken>;
export const recognitionSchema = z
  .object({
    tokens: z.array(textTokenSchema).readonly(),
    complete: z.boolean(),
    issues: z.array(analysisIssueSchema).readonly(),
  })
  .readonly() satisfies z.ZodType<RecognitionResult>;
export const wordTokenSchema = textRangeSchema
  .unwrap()
  .extend({ text: z.string() })
  .readonly() satisfies z.ZodType<WordToken>;
export const wordAnalysisSchema = z
  .object({
    words: z.array(wordTokenSchema).readonly(),
    boundaries: z.array(z.int().nonnegative()).readonly(),
    /** 结构和词界阶段均完整时为 true；两阶段的问题按顺序合并。 */
    complete: z.boolean(),
    issues: z.array(analysisIssueSchema).readonly(),
  })
  .readonly() satisfies z.ZodType<WordAnalysis>;

export function analysisError(
  code: string,
  error: z.ZodError,
): TextAnalysisContractError {
  return new TextAnalysisContractError(
    code,
    error.issues
      .map(
        (issue) =>
          `${issue.path.map(String).join(".") || "输入"}：${issue.message}`,
      )
      .join("；"),
  );
}
