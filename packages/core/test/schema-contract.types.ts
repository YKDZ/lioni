import type { StandardSchemaV1 as OfficialStandardSchemaV1 } from "@standard-schema/spec";

import { defineConfig } from "../src/index.ts";
import type {
  StandardSchemaV1,
  StandardSchemaV1Issue,
  StandardSchemaV1Result,
  TranslationUnitInput,
} from "../src/index.ts";

type IsSameType<TLeft, TRight> =
  (<TCandidate>() => TCandidate extends TLeft ? 1 : 2) extends <
    TCandidate,
  >() => TCandidate extends TRight ? 1 : 2
    ? (<TCandidate>() => TCandidate extends TRight ? 1 : 2) extends <
        TCandidate,
      >() => TCandidate extends TLeft ? 1 : 2
      ? true
      : false
    : false;
type Assert<T extends true> = T;

const standardIssueUsesOfficialType: Assert<
  IsSameType<StandardSchemaV1Issue, OfficialStandardSchemaV1.Issue>
> = true;
void standardIssueUsesOfficialType;
const standardResultUsesOfficialUnion: Assert<
  IsSameType<
    StandardSchemaV1Result<Unit>,
    OfficialStandardSchemaV1.Result<Unit>
  >
> = true;
void standardResultUsesOfficialUnion;

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

declare const officialSourceSchema: OfficialStandardSchemaV1<Unit, Unit>;
defineConfig({
  source: {
    schema: officialSourceSchema,
    read: () => ({ scopes: [] }),
  },
  keyOf(unit) {
    const line: number = unit.context.line;
    return `official:${line}`;
  },
});

declare const promisedResult: PromiseLike<
  OfficialStandardSchemaV1.Result<Unit>
>;
const promiseLikeSourceSchema: StandardSchemaV1<Unit, Unit> = {
  "~standard": {
    version: 1,
    vendor: "promise-like-type-contract",
    validate: () => promisedResult,
  },
};
void promiseLikeSourceSchema;

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
