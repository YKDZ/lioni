import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  analyzeQuality,
  defineConfig,
  defineQualityCheck,
  StandardSchemaContractError,
  validateFrameworkConfig,
  type QualityCheckDefinition,
  type QualityCheckOutcome,
  type SemanticEditCandidate,
  type StandardSchemaV1,
} from "../src/index.ts";
import { fixtureTranslationIdentity } from "./source-schema.ts";

type Unit = { readonly id: string; readonly source: string };
type ThresholdInput = { readonly threshold?: number };
type ThresholdConfiguration = { readonly threshold: number };
type ModeConfiguration = { readonly includeShortCandidates: boolean };

const unitSchema: StandardSchemaV1<Unit, Unit> = {
  "~standard": {
    version: 1,
    vendor: "qa-configuration-test",
    validate(value) {
      if (
        typeof value !== "object" ||
        value === null ||
        !("id" in value) ||
        typeof value.id !== "string" ||
        !("source" in value) ||
        typeof value.source !== "string"
      )
        return { issues: [{ message: "expected a source unit" }] };
      return { value: { id: value.id, source: value.source } };
    },
  },
};

const stringBodySchema: StandardSchemaV1<string, string> = {
  "~standard": {
    version: 1,
    vendor: "qa-configuration-test",
    validate(value) {
      return typeof value === "string"
        ? { value }
        : { issues: [{ message: "expected string content" }] };
    },
  },
};

const thresholdSchema: StandardSchemaV1<
  ThresholdInput,
  ThresholdConfiguration
> = {
  "~standard": {
    version: 1,
    vendor: "qa-configuration-test",
    validate(value) {
      if (typeof value !== "object" || value === null || Array.isArray(value))
        return { issues: [{ message: "threshold must be a number" }] };
      const thresholdValue = Object.hasOwn(value, "threshold")
        ? Reflect.get(value, "threshold")
        : undefined;
      if (thresholdValue !== undefined && typeof thresholdValue !== "number")
        return { issues: [{ message: "threshold must be a number" }] };
      return {
        value: {
          threshold: typeof thresholdValue === "number" ? thresholdValue : 3,
        },
      };
    },
  },
};

const asyncModeSchema: StandardSchemaV1<"include" | "skip", ModeConfiguration> =
  {
    "~standard": {
      version: 1,
      vendor: "qa-configuration-test",
      async validate(value) {
        if (value !== "include" && value !== "skip")
          return { issues: [{ message: "expected include or skip" }] };
        return { value: { includeShortCandidates: value === "include" } };
      },
    },
  };

type DefaultConfiguration = { readonly mode: "default" };
const defaultConfigurationSchema: StandardSchemaV1<
  undefined,
  DefaultConfiguration
> = {
  "~standard": {
    version: 1,
    vendor: "qa-configuration-test",
    validate(value) {
      if (value !== undefined)
        return { issues: [{ message: "expected omitted configuration" }] };
      return { value: { mode: "default" } };
    },
  },
};

const nonJsonOutputSchema: StandardSchemaV1<undefined, Map<string, string>> = {
  "~standard": {
    version: 1,
    vendor: "qa-configuration-test",
    validate() {
      return { value: new Map([["mode", "invalid"]]) };
    },
  },
};

function completeOutcome(
  diagnostics: QualityCheckOutcome["diagnostics"] = [],
): QualityCheckOutcome {
  return {
    status: "complete",
    diagnostics,
    issues: [],
    coverage: {
      selected: 1,
      evaluated: 1,
      notApplicable: 0,
      incomplete: 0,
      failed: 0,
    },
  };
}

function qualityConfig(
  checks: readonly QualityCheckDefinition<Unit, unknown>[],
) {
  return defineConfig({
    source: {
      schema: unitSchema,
      read: () => ({
        scopes: [
          {
            range: "messages.json",
            enumeration: "complete",
            records: [
              {
                value: { id: "save", source: "Save" },
                bodyAvailability: "available" as const,
              },
            ],
          },
        ],
      }),
    },
    keyOf: ({ id }) => id,
    translations: {
      languages: ["fr"],
      identityOf: fixtureTranslationIdentity,
      schema: unitSchema,
      contentSchema: stringBodySchema,
      read(_language, sourceUnits) {
        return {
          scopes: [
            {
              range: "messages.fr.json",
              covers: sourceUnits.map(({ key }) => key),
              enumeration: "complete",
              records: [],
            },
          ],
        };
      },
      matches: (unit, translation) => unit.id === translation.id,
      contentOf: (translation) => translation.source,
    },
    quality: { checks },
  });
}

function createChecks() {
  const observed = new Map<string, unknown>();
  const thresholdChecker = defineQualityCheck<
    Unit,
    unknown,
    typeof thresholdSchema
  >({
    id: "minimum-length",
    version: "qa-configuration-v1",
    configurationSchema: thresholdSchema,
    configuration: {},
    check: (input) => {
      observed.set("minimum-length", input.configuration);
      const minimum: number = input.configuration.threshold;
      // @ts-expect-error 检查器接收到的配置类型应与 schema 输出类型一致。
      const wrongType: string = input.configuration.threshold;
      void wrongType;
      return completeOutcome(
        typeof input.candidate.content === "string" &&
          input.candidate.content.length < minimum
          ? [
              {
                severity: "warning",
                object: {
                  kind: "translation-unit",
                  key: input.candidate.sourceKey,
                  language: input.candidate.language,
                },
                location: {
                  language: input.candidate.language,
                  range: "messages.fr.json",
                },
                message: `Candidate is shorter than ${minimum}.`,
                evidence: [],
              },
            ]
          : [],
      );
    },
  });

  const modeChecker = defineQualityCheck<Unit, unknown, typeof asyncModeSchema>(
    {
      id: "short-candidate-policy",
      version: "qa-configuration-v1",
      configurationSchema: asyncModeSchema,
      configuration: "skip",
      check: (input) => {
        observed.set("short-candidate-policy", input.configuration);
        return completeOutcome(
          input.configuration.includeShortCandidates ||
            typeof input.candidate.content !== "string" ||
            input.candidate.content.length >= 2
            ? []
            : [
                {
                  severity: "info",
                  object: {
                    kind: "translation-unit",
                    key: input.candidate.sourceKey,
                    language: input.candidate.language,
                  },
                  location: {
                    language: input.candidate.language,
                    range: "messages.fr.json",
                  },
                  message: "Short candidate is disabled by configuration.",
                  evidence: [],
                },
              ],
        );
      },
    },
  );

  return { checks: [thresholdChecker, modeChecker], observed };
}

void describe("quality checker configuration contracts", () => {
  void it("配置入口接受带自定义原型的通用 schema 对象", () => {
    const schema = Object.assign(
      Object.create({ inherited: true }),
      unitSchema,
    );

    assert.doesNotThrow(() =>
      validateFrameworkConfig({
        source: { schema, read: () => ({ scopes: [] }) },
        keyOf: ({ id }: Unit) => id,
      }),
    );
  });

  void it("runs transformed sync and async configurations and records their outputs", async () => {
    const { checks, observed } = createChecks();
    const config = qualityConfig(checks);
    const result = await analyzeQuality(config, {
      candidates: [
        { sourceKey: "save", language: "fr", content: "A" },
        { sourceKey: "save", language: "fr", content: "Sauver" },
      ],
    });

    assert.equal(result.status, "complete");
    assert.deepEqual(
      result.checks.map(({ checkId, configuration }) => ({
        checkId,
        configuration,
      })),
      [
        {
          checkId: "minimum-length",
          configuration: { threshold: 3 },
        },
        {
          checkId: "short-candidate-policy",
          configuration: { includeShortCandidates: false },
        },
      ],
    );
    assert.deepEqual(
      observed.get("minimum-length"),
      result.checks[0]?.configuration,
    );
    assert.deepEqual(
      observed.get("short-candidate-policy"),
      result.checks[1]?.configuration,
    );
    assert.deepEqual(
      result.diagnostics.map(({ checkId, message }) => [checkId, message]),
      [
        ["minimum-length", "Candidate is shorter than 3."],
        [
          "short-candidate-policy",
          "Short candidate is disabled by configuration.",
        ],
      ],
    );
  });

  void it("rejects a bad checker configuration before converting it to QA failure", async () => {
    const invalidChecker = defineQualityCheck<
      Unit,
      unknown,
      typeof thresholdSchema
    >({
      id: "minimum-length",
      version: "qa-configuration-v1",
      configurationSchema: thresholdSchema,
      // @ts-expect-error 静态配置值不符合声明的输入类型。
      configuration: { threshold: "three" },
      check: () => completeOutcome(),
    });
    const config = qualityConfig([invalidChecker]);

    await assert.rejects(
      analyzeQuality(config, {
        candidates: [{ sourceKey: "save", language: "fr", content: "A" }],
      }),
      { name: "StandardSchemaContractError" },
    );
  });

  void it("applies defaults to an omitted configuration through the public QA workflow", async () => {
    const defaultChecker = defineQualityCheck<
      Unit,
      unknown,
      typeof defaultConfigurationSchema
    >({
      id: "default-config",
      version: "qa-configuration-v1",
      configurationSchema: defaultConfigurationSchema,
      configuration: undefined,
      check: (input) => {
        assert.equal(input.configuration.mode, "default");
        return completeOutcome();
      },
    });
    const result = await analyzeQuality(qualityConfig([defaultChecker]), {
      candidates: [{ sourceKey: "save", language: "fr", content: "Saved" }],
    });

    assert.equal(result.status, "complete");
    assert.deepEqual(result.checks[0]?.configuration, { mode: "default" });
  });

  void it("rejects a non-JSON final configuration after schema conversion", async () => {
    const invalidOutputChecker = defineQualityCheck<
      Unit,
      unknown,
      typeof nonJsonOutputSchema
    >({
      id: "non-json-config",
      version: "qa-configuration-v1",
      configurationSchema: nonJsonOutputSchema,
      configuration: undefined,
      check: () => completeOutcome(),
    });

    await assert.rejects(
      analyzeQuality(qualityConfig([invalidOutputChecker]), {
        candidates: [{ sourceKey: "save", language: "fr", content: "Saved" }],
      }),
      (error: unknown) => {
        assert.ok(error instanceof StandardSchemaContractError);
        assert.equal(error.kind, "invalid-json");
        assert.equal(
          error.valueDescription,
          "QA 检查器 non-json-config 的最终配置",
        );
        return true;
      },
    );
  });

  void it("自定义指纹依据含非 JSON 值时作为契约错误拒绝", async () => {
    const checker = defineQualityCheck<Unit, unknown, typeof thresholdSchema>({
      id: "non-json-fingerprint",
      version: "qa-configuration-v1",
      configurationSchema: thresholdSchema,
      configuration: {},
      fingerprintInput: () =>
        ({ callback: () => "hidden dependency" }) as never,
      check: () => completeOutcome(),
    });

    await assert.rejects(
      analyzeQuality(qualityConfig([checker]), {
        candidates: [{ sourceKey: "save", language: "fr", content: "Saved" }],
      }),
      (error: unknown) => {
        assert.ok(error instanceof StandardSchemaContractError);
        assert.equal(error.kind, "invalid-json");
        assert.equal(
          error.valueDescription,
          "QA 检查器 non-json-fingerprint 的输入指纹依据.callback",
        );
        return true;
      },
    );
  });

  void it("rejects candidate bodies that violate the declared content schema", async () => {
    let checkerCalled = false;
    const checker = defineQualityCheck<Unit, unknown, typeof thresholdSchema>({
      id: "candidate-schema",
      version: "qa-configuration-v1",
      configurationSchema: thresholdSchema,
      configuration: {},
      check: () => {
        checkerCalled = true;
        return completeOutcome();
      },
    });
    const invalidCandidate = {
      sourceKey: "save",
      language: "fr",
      content: { text: "not the declared string body" },
    } as unknown as SemanticEditCandidate<string>;

    await assert.rejects(
      analyzeQuality(qualityConfig([checker]), {
        candidates: [invalidCandidate],
      }),
      (error: unknown) => {
        assert.ok(error instanceof StandardSchemaContractError);
        assert.equal(error.kind, "schema-mismatch");
        assert.equal(error.valueDescription, "译文候选正文");
        return true;
      },
    );
    assert.equal(checkerCalled, false);
  });
});
