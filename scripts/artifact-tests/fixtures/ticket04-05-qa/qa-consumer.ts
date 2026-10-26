import assert from "node:assert/strict";

import { createTermChecker } from "@lioni/checks";
import {
  analyzeQuality,
  defineConfig,
  type StandardSchemaV1,
} from "@lioni/core";
import {
  compileTerms,
  createTermbase,
  evaluateTerms,
  rejectForbiddenTranslation,
  requireAllowedTranslation,
  type TermComparisonInput,
} from "@lioni/terminology";
import { createTextAnalysis, segmentWords } from "@lioni/text-analysis";

type Unit = { readonly id: string; readonly source: string };
type Translation = { readonly id: string; readonly text: string };

function schema<T>(
  vendor: string,
  valid: (value: unknown) => value is T,
): StandardSchemaV1<T, T> {
  return {
    "~standard": {
      version: 1,
      vendor,
      validate(value) {
        return valid(value)
          ? { value }
          : { issues: [{ message: `invalid ${vendor}` }] };
      },
    },
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const unitSchema = schema<Unit>(
  "ticket05-unit",
  (value): value is Unit =>
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.source === "string",
);
const translationSchema = schema<Translation>(
  "ticket05-translation",
  (value): value is Translation =>
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.text === "string",
);
const stringSchema = schema<string>(
  "ticket05-string",
  (value): value is string => typeof value === "string",
);

const textAnalysis = createTextAnalysis({ segmenter: segmentWords });
const terms = compileTerms(
  createTermbase({
    concepts: [
      {
        id: "log",
        languages: [
          {
            language: "en",
            expressions: [{ id: "log-en", text: "log", usage: "preferred" }],
          },
          {
            language: "zh",
            expressions: [
              { id: "log-zh", text: "日志", usage: "allowed" },
              { id: "log-record", text: "记录", usage: "forbidden" },
            ],
          },
        ],
      },
      {
        id: "record",
        languages: [
          {
            language: "en",
            expressions: [
              { id: "record-en", text: "record", usage: "preferred" },
            ],
          },
          {
            language: "zh",
            expressions: [{ id: "record-zh", text: "记录", usage: "allowed" }],
          },
        ],
      },
      {
        id: "workspace",
        languages: [
          {
            language: "en",
            expressions: [
              { id: "workspace-en", text: "workspace", usage: "preferred" },
            ],
          },
          {
            language: "zh",
            expressions: [
              { id: "workspace-zh", text: "工作区", usage: "allowed" },
              { id: "workspace-old", text: "作业区", usage: "forbidden" },
            ],
          },
        ],
      },
    ],
  }),
  { analysis: textAnalysis },
);

const sourceText = "log record workspace";
const targetText = "日志与记录，作业区";
const project = ({
  candidate,
  sourceUnit,
}: {
  readonly candidate: { readonly content: string };
  readonly sourceUnit: { readonly unit: Unit } | null;
}) =>
  sourceUnit === null
    ? {
        status: "incomplete" as const,
        issue: { code: "source-unavailable", message: "原文不可用。" },
      }
    : {
        status: "ready" as const,
        value: {
          groups: [
            {
              ref: "catalogue",
              source: {
                language: "en",
                fragments: [{ ref: "source", text: sourceUnit.unit.source }],
              },
              target: {
                language: "zh",
                fragments: [{ ref: "candidate", text: candidate.content }],
              },
            },
          ],
        } satisfies TermComparisonInput,
      };

const qualityChecks = [
  createTermChecker<Unit, Translation, string, string>({
    terms,
    rule: requireAllowedTranslation(),
    select: ({ candidate }) => ({
      status: "selected",
      subject: candidate.sourceKey,
    }),
    project,
  }),
  createTermChecker<Unit, Translation, string, string>({
    terms,
    rule: rejectForbiddenTranslation(),
    select: ({ candidate }) => ({
      status: "selected",
      subject: candidate.sourceKey,
    }),
    project,
  }),
];

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
              value: { id: "catalogue", source: sourceText },
              bodyAvailability: "available",
            },
          ],
        },
      ],
    }),
  },
  keyOf: ({ id }) => id,
  translations: {
    languages: ["zh"],
    schema: translationSchema,
    contentSchema: stringSchema,
    contentOf: ({ text }) => text,
    identityOf: ({ id }) => ({ namespace: "ticket05", key: id }),
    read: (_language, sourceUnits) => ({
      scopes: [
        {
          range: "locale.json",
          enumeration: "complete",
          covers: sourceUnits.map(({ key }) => key),
          records: [
            {
              value: { id: "catalogue", text: targetText },
              bodyAvailability: "available",
            },
          ],
        },
      ],
    }),
    matches: (unit, translation) => unit.id === translation.id,
  },
  createQualityRequest: () => ({
    candidates: [
      { sourceKey: "catalogue", language: "zh", content: targetText },
    ],
    dependencies: {},
  }),
  qualityChecks,
});

const quality = await analyzeQuality(config);
const comparison: TermComparisonInput = {
  groups: [
    {
      ref: "catalogue",
      source: {
        language: "en",
        fragments: [{ ref: "source", text: sourceText }],
      },
      target: {
        language: "zh",
        fragments: [{ ref: "candidate", text: targetText }],
      },
    },
  ],
};
const independent = await evaluateTerms(terms, comparison);
assert.equal(quality.status, "incomplete");
assert.equal(quality.status, independent.status);
assert.deepEqual(
  quality.diagnostics.map((diagnostic) => diagnostic.object.code),
  independent.problems.map((problem) => problem.code),
);
assert.deepEqual(
  quality.diagnostics.map((diagnostic) => diagnostic.object.code),
  ["missing-allowed-translation", "forbidden-translation"],
);
assert.ok(
  quality.checks
    .flatMap((check) => check.issues)
    .some(
      (issue) =>
        issue.object?.ruleId === "reject-forbidden-translation" &&
        issue.object?.conceptId === "log",
    ),
);
