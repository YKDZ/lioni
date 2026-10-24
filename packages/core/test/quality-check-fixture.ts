import {
  defineQualityCheck,
  type Awaitable,
  type JsonValue,
  type QualityCheckDefinition,
  type QualityCheckInput,
  type QualityCheckOutcome,
  type StandardSchemaV1,
  type TranslationUnitInput,
} from "../src/index.ts";

const identityConfigurationSchema: StandardSchemaV1<JsonValue, JsonValue> = {
  "~standard": {
    version: 1,
    vendor: "core-test-quality-check",
    types: { input: {} as JsonValue, output: {} as JsonValue },
    validate(value) {
      return { value: value as JsonValue };
    },
  },
};

export function defineTestQualityCheck<
  TUnit extends TranslationUnitInput = TranslationUnitInput,
  TTranslation = unknown,
>(definition: {
  readonly id: string;
  readonly configuration: JsonValue;
  readonly check: (
    input: QualityCheckInput<TUnit, TTranslation, JsonValue>,
  ) => Awaitable<QualityCheckOutcome>;
}): QualityCheckDefinition<TUnit, TTranslation> {
  return defineQualityCheck<
    TUnit,
    TTranslation,
    typeof identityConfigurationSchema
  >({
    ...definition,
    configurationSchema: identityConfigurationSchema,
  });
}
