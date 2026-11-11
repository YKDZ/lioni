import {
  defineChecker,
  type Awaitable,
  type QualityCheckOutcome,
  type TranslationUnitInput,
} from "../src/index.ts";
import { schemaFromExamples } from "./source-schema.ts";

const emptyInputSchema = schemaFromExamples(null);

/** 用空 JSON 输入简化不读取上下文的检查器测试。 */
export function defineTestChecker<
  TUnit extends TranslationUnitInput = TranslationUnitInput,
  TTranslation = unknown,
  TBody = unknown,
  TUnavailable = unknown,
>(definition: {
  readonly id: string;
  readonly version?: string;
  readonly check: (input: null) => Awaitable<QualityCheckOutcome>;
}) {
  return defineChecker.withTypes<TUnit, TTranslation, TBody, TUnavailable>()({
    id: definition.id,
    version: definition.version ?? "core-test-v1",
    inputSchema: emptyInputSchema,
    prepare: () => ({ status: "ready", input: null }),
    check: definition.check,
  });
}
