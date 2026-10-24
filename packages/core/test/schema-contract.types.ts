import { defineConfig } from "../src/index.ts";
import type { StandardSchemaV1, TranslationUnitInput } from "../src/index.ts";

type Unit = {
  readonly source: string;
  readonly context: { readonly line: number };
};

declare const sourceSchema: StandardSchemaV1<Unit, Unit>;
const config = defineConfig({
  source: {
    schema: sourceSchema,
    read: () => ({ scopes: [] }),
  },
  keyOf(unit) {
    const line: number = unit.context.line;
    return `message:${line}`;
  },
});
const key: string = config.keyOf({ source: "Save", context: { line: 18 } });
void key;
const sourceUnit: Unit = { source: "Save", context: { line: 18 } };
const translationUnitConstraint: TranslationUnitInput = sourceUnit;
void translationUnitConstraint;

defineConfig({
  // @ts-expect-error 原文 adapter 必须在扩展定义时绑定 schema。
  source: { read: () => ({ scopes: [] }) },
  keyOf: () => "unused",
});

type InputUnit = { readonly source: string };
type OutputUnit = { readonly source: number };
declare const transformingSchema: StandardSchemaV1<InputUnit, OutputUnit>;

defineConfig({
  source: {
    // @ts-expect-error 原文契约必须具有相同的 schema 输入与输出类型。
    schema: transformingSchema,
    read: () => ({ scopes: [] }),
  },
  keyOf: (unit) => String(unit.source),
});
