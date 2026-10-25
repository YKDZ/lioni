import assert from "node:assert/strict";

import {
  applySemanticEdits,
  analyzeQuality,
  defineConfig,
  defineQualityCheck,
  prepareQualityConditionedSemanticEdit,
  type QualityCheckOutcome,
  type QualityObject,
  type StandardSchemaV1,
} from "@lioni/core";
import {
  createMemoScope,
  MemoScopeClosedError,
  type MemoScope,
} from "@lioni/memo";

type Unit = { readonly id: string; readonly source: string };
type Translation = { readonly id: string; readonly text: string };
type CheckConfig = { readonly version: 1 };

const unitSchema: StandardSchemaV1<Unit, Unit> = {
  "~standard": {
    version: 1,
    vendor: "ticket02-artifact-unit",
    validate(value) {
      return typeof value === "object" &&
        value !== null &&
        "id" in value &&
        typeof value.id === "string" &&
        "source" in value &&
        typeof value.source === "string"
        ? { value: value as Unit }
        : { issues: [{ message: "invalid source unit" }] };
    },
  },
};

const translationSchema: StandardSchemaV1<Translation, Translation> = {
  "~standard": {
    version: 1,
    vendor: "ticket02-artifact-translation",
    validate(value) {
      return typeof value === "object" &&
        value !== null &&
        "id" in value &&
        typeof value.id === "string" &&
        "text" in value &&
        typeof value.text === "string"
        ? { value: value as Translation }
        : { issues: [{ message: "invalid translation" }] };
    },
  },
};

const stringSchema: StandardSchemaV1<string, string> = {
  "~standard": {
    version: 1,
    vendor: "ticket02-artifact-string",
    validate(value) {
      return typeof value === "string"
        ? { value }
        : { issues: [{ message: "expected a string" }] };
    },
  },
};

const checkConfigSchema: StandardSchemaV1<CheckConfig, CheckConfig> = {
  "~standard": {
    version: 1,
    vendor: "ticket02-artifact-check-config",
    validate(value) {
      return typeof value === "object" &&
        value !== null &&
        "version" in value &&
        value.version === 1
        ? { value: { version: 1 } }
        : { issues: [{ message: "expected version 1" }] };
    },
  },
};

function completeOutcome(): QualityCheckOutcome {
  return {
    status: "complete",
    diagnostics: [],
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

const observedScopes: MemoScope[] = [];
let calculations = 0;
let storedText = "Enregistrer";
const operation = (source: string) => `${source}:${++calculations}`;

function createCheck(id: string) {
  return defineQualityCheck<
    Unit,
    Translation,
    typeof checkConfigSchema,
    QualityObject,
    string
  >({
    id,
    configurationSchema: checkConfigSchema,
    configuration: { version: 1 },
    check: ({ memo }) => {
      observedScopes.push(memo);
      memo.memo(operation)("Save");
      return completeOutcome();
    },
  });
}

const config = defineConfig({
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
              bodyAvailability: "available",
            },
          ],
        },
      ],
    }),
  },
  keyOf: ({ id }) => id,
  translations: {
    languages: ["fr"],
    schema: translationSchema,
    contentSchema: stringSchema,
    contentOf: ({ text }) => text,
    read: (_language, sourceUnits) => ({
      scopes: [
        {
          range: "fr.json",
          enumeration: "complete",
          covers: sourceUnits.map(({ key }) => key),
          records: [
            {
              value: { id: "save", text: storedText },
              bodyAvailability: "available",
            },
          ],
        },
      ],
    }),
    matches: (unit, translation) => unit.id === translation.id,
  },
  translationWriteback: {
    locateExistingTarget: () => ({
      status: "located",
      locator: { file: "fr.json", key: "save" },
    }),
    locateNewTarget: () => ({
      status: "notWritable",
      reason: "本场景只修改已有译文。",
    }),
    write: ({ edit }) => {
      if (edit.operation === "write") storedText = edit.content;
    },
  },
  createQualityRequest: () => ({
    candidates: [{ sourceKey: "save", language: "fr", content: "Sauver" }],
    dependencies: {},
  }),
  qualityChecks: [createCheck("first"), createCheck("second")],
});

const owned = await analyzeQuality(config);
assert.equal(owned.status, "complete");
assert.equal(calculations, 1);
assert.equal(observedScopes[0], observedScopes[1]);
assert.throws(() => observedScopes[0]!.memo(operation), MemoScopeClosedError);
assert.equal(JSON.stringify(owned).includes('"memo"'), false);

const borrowed = createMemoScope();
await analyzeQuality(config, { memo: borrowed });
assert.equal(calculations, 2);
assert.equal(borrowed.memo(operation)("Save"), "Save:2");
borrowed.dispose();

const candidate = {
  sourceKey: "save",
  language: "fr",
  content: "Sauver",
};
const rejectedScopeStart = observedScopes.length;
const rejected = await prepareQualityConditionedSemanticEdit(config, {
  candidate,
  condition: () => false,
});
assert.equal(rejected.status, "rejected");
assert.equal(calculations, 3);
assert.equal(
  observedScopes[rejectedScopeStart],
  observedScopes[rejectedScopeStart + 1],
);
assert.throws(
  () => observedScopes[rejectedScopeStart]!.memo(operation),
  MemoScopeClosedError,
);
assert.equal(storedText, "Enregistrer");

const passedScopeStart = observedScopes.length;
const passed = await prepareQualityConditionedSemanticEdit(config, {
  candidate,
  condition: (quality) => quality.status === "complete",
});
assert.equal(passed.status, "passed");
assert.equal(calculations, 4);
assert.equal(
  observedScopes[passedScopeStart],
  observedScopes[passedScopeStart + 1],
);
assert.throws(
  () => observedScopes[passedScopeStart]!.memo(operation),
  MemoScopeClosedError,
);
if (passed.status !== "passed" || passed.preparation.status !== "prepared")
  throw new Error("QA 条件通过后应准备可写入的编辑。");
const applied = await applySemanticEdits([passed.preparation.edit], config);
assert.equal(applied.results[0]?.status, "written");
assert.equal(storedText, "Sauver");
