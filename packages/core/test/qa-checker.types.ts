import { defineChecker, type StandardSchemaV1 } from "../src/index.ts";
import { schemaFromExamples } from "./source-schema.ts";

const inputSchema = schemaFromExamples({ text: "" });
const check = () => ({
  status: "complete" as const,
  diagnostics: [],
  issues: [],
  coverage: {
    selected: 1,
    evaluated: 1,
    notApplicable: 0,
    incomplete: 0,
    failed: 0,
  },
});

const simple = defineChecker({
  id: "simple",
  version: "1",
  inputSchema,
  prepare({ loaded }) {
    loaded satisfies undefined;
    return { status: "ready", input: { text: "正文" } };
  },
  check(input) {
    input.text satisfies string;
    // @ts-expect-error 规则只读消费最终输入。
    input.text = "修改";
    return check();
  },
});
simple.id satisfies "simple";

type NestedInput = { payload: { key: string }; entries: string[] };
const nestedInputSchema: StandardSchemaV1<NestedInput, NestedInput> = {
  "~standard": {
    version: 1,
    vendor: "lioni-test",
    validate: (value) => ({ value: value as NestedInput }),
  },
};
const nested = defineChecker({
  id: "nested-readonly",
  version: "1",
  inputSchema: nestedInputSchema,
  prepare: () => ({
    status: "ready" as const,
    input: { payload: { key: "message" }, entries: ["one"] },
  }),
  check(input) {
    // @ts-expect-error 可修改 JSON 对象必须在最终输入中递归只读。
    input.payload.key = "changed";
    // @ts-expect-error 普通数组不能通过 JsonValue 可赋值关系绕过只读。
    input.entries.push("two");
    return check();
  },
});
nested.id satisfies "nested-readonly";

type Unit = { source: { message: string } };
const typed = defineChecker.withTypes<Unit, unknown, string>()({
  id: "typed",
  version: "1",
  inputSchema,
  async load() {
    return new Map<string, number>([["message", 2]]);
  },
  prepare({ candidate, sourceUnit, loaded }) {
    loaded.get(candidate.content) satisfies number | undefined;
    sourceUnit.unit.source.message satisfies string;
    return { status: "ready", input: { text: sourceUnit.unit.source.message } };
  },
  check,
});
typed.id satisfies "typed";

const prepare = () => ({ status: "ready" as const, input: { text: "正文" } });
const declaration = {
  id: "required",
  version: "1",
  inputSchema,
  prepare,
  check,
};
const { id, version } = declaration;
// @ts-expect-error version 必填。
defineChecker({ id, inputSchema, prepare, check });
// @ts-expect-error id 必填。
defineChecker({ version, inputSchema, prepare, check });
// @ts-expect-error inputSchema 必填。
defineChecker({ id, version, prepare, check });
// @ts-expect-error prepare 必填。
defineChecker({ id, version, inputSchema, check });
// @ts-expect-error check 必填。
defineChecker({ id, version, inputSchema, prepare });

const transformingSchema: StandardSchemaV1<string, { text: string }> = {
  "~standard": {
    version: 1,
    vendor: "lioni-test",
    validate: () => ({ value: { text: "转换后" } }),
  },
};
const transforming = { ...declaration, inputSchema: transformingSchema };
// @ts-expect-error 最终输入 schema 的输入输出类型必须一致。
defineChecker(transforming);

const invalidInput = {
  ...declaration,
  prepare: () => ({ status: "ready" as const, input: { text: 7 } }),
};
// @ts-expect-error 准备结果必须符合 inputSchema。
defineChecker(invalidInput);
