import type { MemoScope } from "@lioni/memo";

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

export type RecognitionInput = TextInput & {
  /** 尚未被保护或由更高优先级识别器占用的原文区间。 */
  readonly availableRanges: readonly TextRange[];
};

export type TextRecognizer = (
  input: RecognitionInput,
) => readonly TextToken[] | Promise<readonly TextToken[]>;

export type StructureAnalysis = {
  readonly text: string;
  readonly language: string;
  readonly tokens: readonly TextToken[];
  readonly protectedRanges: readonly TextRange[];
  readonly availableRanges: readonly TextRange[];
  readonly complete: boolean;
  readonly issues: readonly TextAnalysisIssue[];
};

export type WordToken = TextRange & { readonly text: string };

export type WordAnalysis = {
  readonly words: readonly WordToken[];
  readonly boundaries: readonly number[];
  readonly complete: boolean;
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
