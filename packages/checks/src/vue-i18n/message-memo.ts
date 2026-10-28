import type { MemoScope } from "@lioni/memo";

import { parseVueI18nMessage } from "./vue-i18n-messages.ts";

const keyByText = (text: string) => [text];

/** 在当前检查运行内共享同一条消息的解析事实。 */
export function memoizedVueI18nMessage(text: string, memo: MemoScope) {
  const parse = memo.memo(parseVueI18nMessage, { key: keyByText });
  return parse(text);
}
