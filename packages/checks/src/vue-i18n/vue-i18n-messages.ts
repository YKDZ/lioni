import { baseCompile } from "@intlify/message-compiler";
import type {
  CompileError,
  LinkedNode,
  ListNode,
  MessageNode,
  NamedNode,
  ResourceNode,
} from "@intlify/message-compiler";
import type { TextRange, TextToken } from "@lioni/text-analysis";

export const VUE_I18N_MESSAGE_COMPILER_VERSION = "11.4.17";

export type VueI18nSyntaxError = {
  readonly code: number;
  readonly domain?: string;
  readonly message: string;
  readonly range?: TextRange;
};

export type VueI18nMessageBranch = {
  readonly range: TextRange;
  /** 把插值和关联消息折成空格，供现有文本分析复用。 */
  readonly text: string;
  /** 按原顺序保留每次出现，包括动态关联键中的直接变量。 */
  readonly variables: readonly string[];
};

export type VueI18nLink =
  | {
      readonly kind: "static";
      readonly key: string;
      readonly range: TextRange;
    }
  | {
      readonly kind: "dynamic";
      readonly variables: readonly string[];
      readonly range: TextRange;
    };

export type VueI18nMessage = {
  readonly errors: readonly VueI18nSyntaxError[];
  readonly branches: readonly VueI18nMessageBranch[];
  readonly tokens: readonly TextToken[];
  /** 保留每个关联的键、范围和动态变量。 */
  readonly links: readonly VueI18nLink[];
};

/** 使用固定版本的 Vue I18n 编译器提取消息分支、变量和关联。 */
export function parseVueI18nMessage(text: string): VueI18nMessage {
  const errors: VueI18nSyntaxError[] = [];
  const { ast } = baseCompile(text, {
    jit: true,
    optimize: false,
    onError: (error) => errors.push(syntaxError(error)),
  });
  const cases = "cases" in ast.body ? ast.body.cases : [ast.body];
  const tokens: TextToken[] = [];
  const links: VueI18nLink[] = [];
  const branches = cases.map((branch) =>
    analyzeBranch(branch, text.length, tokens, links),
  );

  return { errors, branches, tokens, links };
}

function analyzeBranch(
  branch: MessageNode,
  textLength: number,
  tokens: TextToken[],
  links: VueI18nLink[],
): VueI18nMessageBranch {
  const variables: string[] = [];
  let projectedText = "";

  for (const item of branch.items) {
    if (item.type === 3 || item.type === 9) {
      projectedText += item.value ?? "";
    } else if (item.type === 4 || item.type === 5) {
      addVariable(item, variables, tokens);
      projectedText += " ";
    } else if (item.type === 6) {
      projectedText += " ";
      const link = analyzeLink(item, variables, tokens, textLength);
      links.push(link);
    }
  }

  return {
    range: nodeRange(branch, textLength),
    text: projectedText,
    variables,
  };
}

function analyzeLink(
  item: LinkedNode,
  variables: string[],
  tokens: TextToken[],
  textLength: number,
): VueI18nLink {
  const range = nodeRange(item, textLength);
  const key = item.key;
  if (key.type === 7) return { kind: "static", key: key.value, range };
  if (key.type === 9) {
    const value = key.value ?? "";
    return { kind: "static", key: value, range };
  }

  if (key.type === 4 || key.type === 5) {
    const identity = addVariable(key, variables, tokens);
    return { kind: "dynamic", variables: [identity], range };
  }

  return { kind: "dynamic", variables: [], range };
}

function addVariable(
  node: NamedNode | ListNode,
  variables: string[],
  tokens: TextToken[],
): string {
  const identity = node.type === 4 ? `named:${node.key}` : `list:${node.index}`;
  variables.push(identity);
  const range = nodeRange(node, node.end ?? 0);
  tokens.push({ kind: "variable", identity, ...range, protect: true });
  return identity;
}

function nodeRange(
  node: ResourceNode | MessageNode | LinkedNode | NamedNode | ListNode,
  textLength: number,
): TextRange {
  return {
    start: node.loc?.start.offset ?? node.start ?? 0,
    end: node.loc?.end.offset ?? node.end ?? textLength,
  };
}

function syntaxError(error: CompileError): VueI18nSyntaxError {
  const { location } = error;
  return {
    code: error.code,
    ...(error.domain === undefined ? {} : { domain: error.domain }),
    message: error.message,
    ...(location === undefined
      ? {}
      : {
          range: {
            start: location.start.offset,
            end: location.end.offset,
          },
        }),
  };
}
