import { parseVueI18nMessage } from "@lioni/checks";
import type { VueI18nMessage } from "@lioni/checks";
import { createTextAnalysis } from "@lioni/text-analysis";

export function createKumaAnalysis() {
  const cache = new Map<string, VueI18nMessage>();
  const message = (text: string) => {
    let value = cache.get(text);
    if (!value) {
      value = parseVueI18nMessage(text);
      cache.set(text, value);
    }
    return value;
  };
  const analysis = createTextAnalysis({
    recognizers: [
      (input) => {
        const result = message(input.text);
        return {
          tokens: result.tokens.filter((t) =>
            input.availableRanges.some(
              (r) => t.start >= r.start && t.end <= r.end,
            ),
          ),
          complete: result.errors.length === 0,
          issues: result.errors.map(({ code, message: text }) => ({
            code: "vue-message-syntax",
            message: `${code}: ${text}`,
          })),
        };
      },
    ],
  });
  return { analysis, message };
}
