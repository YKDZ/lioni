import { validateRange } from "./ranges.ts";
import { TextAnalysisContractError } from "./types.ts";
import type { StructureAnalysis, TextRange, TextToken } from "./types.ts";

export type SlotIdentity = {
  readonly kind: string;
  readonly identity: string;
};

export type SignaturePart =
  | { readonly type: "text"; readonly text: string }
  | ({ readonly type: "slot" } & SlotIdentity);

export type TemplateSlot = TextRange &
  SlotIdentity & {
    readonly raw: string;
    readonly value?: unknown;
  };

export type TemplateSignature = {
  readonly parts: readonly SignaturePart[];
  readonly slots: readonly TemplateSlot[];
};

export type TemplateOptions = {
  readonly abstract: (token: TextToken) => SlotIdentity | undefined;
};

/** 只抽象明确选中的 token；保护区间和未抽象内容仍作为原样文本参与比较。 */
export function createTemplateSignature(
  analysis: StructureAnalysis,
  options: TemplateOptions,
): TemplateSignature {
  if (!analysis.complete)
    throw new TextAnalysisContractError(
      "incomplete-structure",
      "结构分析不完整，不能生成完整模板签名。",
    );
  const parts: SignaturePart[] = [];
  const slots: TemplateSlot[] = [];
  let cursor = 0;
  let previousEnd = -1;
  for (const token of analysis.tokens) {
    validateRange(analysis.text, token);
    if (token.start < previousEnd)
      throw new TextAnalysisContractError(
        "overlapping-token",
        "模板 token 必须按原文顺序且不重叠。",
      );
    previousEnd = token.end;
    const identity = options.abstract(token);
    if (identity === undefined) continue;
    if (
      identity === null ||
      typeof identity !== "object" ||
      typeof identity.kind !== "string" ||
      identity.kind.length === 0 ||
      typeof identity.identity !== "string" ||
      identity.identity.length === 0
    )
      throw new TextAnalysisContractError(
        "invalid-slot",
        "槽位种类与身份必须非空。",
      );
    if (token.start > cursor)
      parts.push(
        Object.freeze({
          type: "text",
          text: analysis.text.slice(cursor, token.start),
        }),
      );
    parts.push(
      Object.freeze({
        type: "slot",
        kind: identity.kind,
        identity: identity.identity,
      }),
    );
    slots.push(
      Object.freeze({
        start: token.start,
        end: token.end,
        kind: identity.kind,
        identity: identity.identity,
        raw: analysis.text.slice(token.start, token.end),
        ...(token.value === undefined ? {} : { value: token.value }),
      }),
    );
    cursor = token.end;
  }
  if (cursor < analysis.text.length)
    parts.push(
      Object.freeze({ type: "text", text: analysis.text.slice(cursor) }),
    );
  return Object.freeze({
    parts: Object.freeze(parts),
    slots: Object.freeze(slots),
  });
}

/** 结构编码不会把原值、原文长度或来源位置当作模板等价条件。 */
export function signatureKey(signature: TemplateSignature): string {
  return JSON.stringify(
    signature.parts.map((part) =>
      part.type === "text"
        ? ["text", part.text]
        : ["slot", part.kind, part.identity],
    ),
  );
}

/** 声明等价关系；未声明的签名保留自身类别，不构成白名单失败。 */
export function createSignatureEquivalence(
  groups: readonly (readonly TemplateSignature[])[],
): (signature: TemplateSignature) => string {
  const parents = new Map<string, string>();
  function root(key: string): string {
    const parent = parents.get(key);
    if (parent === undefined || parent === key) return key;
    const result = root(parent);
    parents.set(key, result);
    return result;
  }
  for (const group of groups) {
    const keys = group.map(signatureKey);
    const first = keys[0];
    if (first === undefined) continue;
    for (const key of keys) {
      const left = root(first);
      const right = root(key);
      if (left < right) parents.set(right, left);
      else if (right < left) parents.set(left, right);
    }
  }
  const canonical = new Map(
    [...parents.keys()].map((key) => [key, root(key)] as const),
  );
  return (signature) => {
    const key = signatureKey(signature);
    return canonical.get(key) ?? key;
  };
}
