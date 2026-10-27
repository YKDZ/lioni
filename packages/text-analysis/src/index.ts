export { createTextAnalysis } from "./analysis.ts";
export type { TextAnalysis, TextAnalysisOptions } from "./analysis.ts";
export { normalizeText } from "./normalize.ts";
export type { NormalizedText } from "./normalize.ts";
export {
  asciiNumbers,
  braceVariables,
  literalMarkers,
  regexTokens,
} from "./recognizers.ts";
export type { RegexTokenOptions } from "./recognizers.ts";
export {
  createSignatureEquivalence,
  createTemplateSignature,
  signatureKey,
} from "./templates.ts";
export type {
  SignaturePart,
  SlotIdentity,
  TemplateOptions,
  TemplateSignature,
  TemplateSlot,
} from "./templates.ts";
export { TextAnalysisContractError } from "./types.ts";
export type {
  AnalysisRuntime,
  RecognitionResult,
  RecognitionInput,
  StructureAnalysis,
  TextAnalysisIssue,
  TextInput,
  TextRange,
  TextRecognizer,
  TextToken,
  WordAnalysis,
  WordSegmenter,
  WordToken,
} from "./types.ts";
export { segmentWords } from "./words.ts";
export { quantityProfile } from "./quantities/index.ts";
export type { QuantityOptions, QuantityProfile } from "./quantities/index.ts";
