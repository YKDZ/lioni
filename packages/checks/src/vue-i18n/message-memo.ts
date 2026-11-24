import type { MemoScope } from "@lioni/memo";

import { parseVueI18nMessage } from "./vue-i18n-messages.ts";

const keyByText = (text: string) => [text];

/** 同一次 QA 运行共享相同消息正文的解析结果。 */
export function memoizedVueI18nMessage(text: string, memo: MemoScope) {
  const parse = memo.memo(parseVueI18nMessage, { key: keyByText });
  return parse(text);
}
