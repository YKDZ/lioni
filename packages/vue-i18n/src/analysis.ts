import { createTextAnalysis } from "@lioni/text-analysis";
import type { TextAnalysis, TextRecognizer } from "@lioni/text-analysis";

import { parseVueI18nMessage } from "./vue-i18n-messages.ts";

/** 将固定的 Vue I18n 解析结果接入共享文本分析能力。 */
export function createVueI18nTextRecognizer(): TextRecognizer {
  return (input) => {
    const result = parseVueI18nMessage(input.text);
    return {
      tokens: result.tokens.filter((token) =>
        input.availableRanges.some(
          (range) => token.start >= range.start && token.end <= range.end,
        ),
      ),
      complete: result.errors.length === 0,
      issues: result.errors.map(({ code, message }) => ({
        code: "vue-message-syntax",
        message: `${code}: ${message}`,
      })),
    };
  };
}

/** 创建使用 Vue I18n 消息变量语法的文本分析器。 */
export function createVueI18nAnalysis(): TextAnalysis {
  return createTextAnalysis({ recognizers: [createVueI18nTextRecognizer()] });
}
