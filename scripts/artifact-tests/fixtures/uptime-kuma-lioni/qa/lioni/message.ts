import { baseCompile } from "@intlify/message-compiler";
import type { MessageNode } from "@intlify/message-compiler";
import type { TextToken } from "@lioni/text-analysis";
export type Message = {
  errors: readonly string[];
  branches: readonly {
    variables: readonly string[];
    text: string;
    start: number;
    end: number;
  }[];
  tokens: readonly TextToken[];
  links: readonly string[];
};
/** 使用宿主锁定版本的编译器；不对 ICU 或花括号另造解析算法。 */
export function parseMessage(text: string): Message {
  const errors: string[] = [];
  const result = baseCompile(text, {
    jit: true,
    optimize: false,
    onError: (error) => {
      errors.push(`${error.code}: ${error.message}`);
    },
  });
  const branches: {
    variables: string[];
    text: string;
    start: number;
    end: number;
  }[] = [];
  const tokens: TextToken[] = [];
  const links: string[] = [];
  const cases: MessageNode[] =
    result.ast.body.type === 1 ? result.ast.body.cases : [result.ast.body];
  for (const branch of cases) {
    const variables: string[] = [];
    let literal = "";
    for (const item of branch.items) {
      if (item.type === 4 || item.type === 5) {
        const identity =
          item.type === 4 ? `named:${item.key}` : `list:${item.index}`;
        variables.push(identity);
        literal += " ";
        if (item.loc)
          tokens.push({
            kind: "variable",
            identity,
            start: item.loc.start.offset,
            end: item.loc.end.offset,
            protect: true,
          });
      } else if (item.type === 3 || item.type === 9)
        literal += item.value ?? "";
      else if (item.type === 6) {
        literal += " ";
        if (item.key.type === 7) links.push(item.key.value);
        else if (item.key.type === 9 && item.key.value)
          links.push(item.key.value);
      }
    }
    branches.push({
      variables: [...new Set(variables)],
      text: literal,
      start: branch.loc?.start.offset ?? 0,
      end: branch.loc?.end.offset ?? text.length,
    });
  }
  return { errors, branches, tokens, links };
}
