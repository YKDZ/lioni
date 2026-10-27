import {
  defineQualityCheck,
  type Awaitable,
  type JsonValue,
  type QualityCheckDefinition,
  type QualityCheckInput,
  type QualityObject,
  type QualityCheckOutcome,
  type StandardSchemaV1,
  type TranslationUnitInput,
} from "../src/index.ts";

const identityConfigurationSchema: StandardSchemaV1<JsonValue, JsonValue> = {
  "~standard": {
    version: 1,
    vendor: "core-test-quality-check",
    validate(value) {
      return { value: value as JsonValue };
    },
  },
};

export function defineTestQualityCheck<
  TUnit extends TranslationUnitInput = TranslationUnitInput,
  TTranslation = unknown,
  TBody = unknown,
  TUnavailable = never,
>(definition: {
  readonly id: string;
  readonly version?: string;
  readonly configuration: JsonValue;
  readonly check: (
    input: QualityCheckInput<
      TUnit,
      TTranslation,
      JsonValue,
      TBody,
      TUnavailable
    >,
  ) => Awaitable<QualityCheckOutcome>;
}): QualityCheckDefinition<
  TUnit,
  TTranslation,
  QualityObject,
  TBody,
  TUnavailable
> {
  return defineQualityCheck<
    TUnit,
    TTranslation,
    typeof identityConfigurationSchema,
    QualityObject,
    TBody,
    TUnavailable
  >({
    ...definition,
    version: definition.version ?? "core-test-v1",
    configurationSchema: identityConfigurationSchema,
  });
}
