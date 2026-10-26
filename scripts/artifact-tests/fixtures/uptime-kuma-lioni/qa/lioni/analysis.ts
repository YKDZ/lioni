import { createTextAnalysis } from "@lioni/text-analysis";

import { parseMessage } from "./message.ts";

export function createKumaAnalysis() {
  const cache = new Map<string, ReturnType<typeof parseMessage>>();
  const message = (text: string) => {
    let value = cache.get(text);
    if (!value) {
      value = parseMessage(text);
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
          issues: result.errors.map((error) => ({
            code: "vue-message-syntax",
            message: error,
          })),
        };
      },
    ],
  });
  return { analysis, message };
}
