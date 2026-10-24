import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  analyzeQuality,
  defineConfig,
  defineQualityCheck,
  prepareQualityConditionedSemanticEdit,
  type QualityCheckOutcome,
  type StandardSchemaV1,
} from "../src/index.ts";

type Unit = { readonly id: string; readonly source: string };
type ThresholdInput = { readonly threshold?: number };
type ThresholdConfiguration = { readonly threshold: number };
type ModeConfiguration = { readonly includeShortCandidates: boolean };

const unitSchema: StandardSchemaV1<Unit, Unit> = {
  "~standard": {
    version: 1,
    vendor: "qa-configuration-test",
    types: { input: {} as Unit, output: {} as Unit },
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

const thresholdSchema: StandardSchemaV1<
  ThresholdInput,
  ThresholdConfiguration
> = {
  "~standard": {
    version: 1,
    vendor: "qa-configuration-test",
    types: {
      input: {} as ThresholdInput,
      output: {} as ThresholdConfiguration,
    },
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
      types: {
        input: "include" as "include" | "skip",
        output: {} as ModeConfiguration,
      },
      async validate(value) {
        if (value !== "include" && value !== "skip")
          return { issues: [{ message: "expected include or skip" }] };
        return { value: { includeShortCandidates: value === "include" } };
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
  qualityChecks: ReturnType<typeof createChecks>["checks"],
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
    qualityChecks,
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
    configurationSchema: thresholdSchema,
    configuration: {},
    check: (input) => {
      observed.set("minimum-length", input.configuration);
      const minimum: number = input.configuration.threshold;
      // @ts-expect-error the checker receives the schema's output type
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
      result.checks.map(({ id, configuration }) => ({ id, configuration })),
      [
        {
          id: "minimum-length",
          configuration: { threshold: 3 },
        },
        {
          id: "short-candidate-policy",
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
      result.diagnostics.map(({ ruleId, message }) => [ruleId, message]),
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
      configurationSchema: thresholdSchema,
      // @ts-expect-error the declared input shape rejects invalid static configuration
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

  void it("matches cached QA results against the parsed configuration", async () => {
    const config = qualityConfig(createChecks().checks);
    const candidate = {
      sourceKey: "save",
      language: "fr",
      content: "A",
    };
    const quality = await analyzeQuality(config, { candidates: [candidate] });
    const result = await prepareQualityConditionedSemanticEdit(config, {
      candidate,
      quality,
      condition: () => true,
    });

    assert.equal(result.status, "passed");
  });
});
