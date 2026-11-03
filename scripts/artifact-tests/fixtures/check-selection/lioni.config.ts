import path from "node:path";

import {
  defineConfig,
  defineQualityCheck,
  type QualityCheckOutcome,
  type QualityObject,
  type StandardSchemaV1,
} from "@lioni/lioni";
import {
  createDirectoryQualityCheckResultCache,
  createFileQualityExceptionStore,
} from "@lioni/lioni/node";
import * as z from "zod";

import {
  getCandidateMode,
  getTermsLoaderMode,
  compileQualityData,
  readIndependentData,
  readSharedData,
  type QualityData,
  recordEvent,
  shouldBuilderReadShared,
} from "./state.ts";

type Unit = { readonly id: string; readonly source: string };
type Translation = { readonly id: string; readonly body: string };

function standardSchema<T>(
  isValue: (value: unknown) => value is T,
): StandardSchemaV1<T, T> {
  return {
    "~standard": {
      version: 1,
      vendor: "check-selection-artifact",
      validate(value) {
        return isValue(value)
          ? { value }
          : { issues: [{ message: "消费 fixture 数据结构无效。" }] };
      },
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const unitSchema = standardSchema<Unit>(
  (value): value is Unit =>
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.source === "string",
);
const translationSchema = standardSchema<Translation>(
  (value): value is Translation =>
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.body === "string",
);
const bodySchema = standardSchema<string>(
  (value): value is string => typeof value === "string",
);
const units: Unit[] = [{ id: "save", source: "Save 1 file" }];
const translations: Translation[] = [
  { id: "save", body: "Enregistrer 1 fichier" },
];
const dependencySchema = z.object({
  key: z.string(),
  revision: z.string(),
  origin: z.enum(["shared", "independent"]),
});

function assertQualityData(value: unknown): asserts value is QualityData {
  dependencySchema.parse(value);
}

const exceptionFileStore = createFileQualityExceptionStore(
  path.join(process.cwd(), "lioni.exceptions.yaml"),
);
const exceptionStore = {
  async load() {
    recordEvent("exception:load");
    return await exceptionFileStore.load();
  },
  async upsert(exception: Parameters<typeof exceptionFileStore.upsert>[0]) {
    recordEvent("exception:upsert");
    await exceptionFileStore.upsert(exception);
  },
};

function createChecker<const TId extends "syntax" | "terms" | "unlisted">(
  id: TId,
) {
  const configurationSchema = z
    .object({ name: z.literal(id) })
    .superRefine(() => recordEvent(`configuration:${id}`));

  return defineQualityCheck.withTypes<
    Unit,
    Translation,
    typeof configurationSchema,
    QualityObject,
    string
  >()({
    id,
    version: "artifact.check-selection/v1",
    configurationSchema,
    configuration: { name: id },
    async loadDependencies({ qualityData }) {
      recordEvent(`loader:${id}`);
      if (id === "terms") {
        const mode = getTermsLoaderMode();
        if (mode === "failure") throw new Error("术语检查资料读取失败。");
        if (mode === "contract-error") return { invalid: () => undefined };
        if (mode === "reader-contract-error") {
          const invalidRead = qualityData.read as unknown as (
            reader: undefined,
          ) => Promise<unknown>;
          return await invalidRead(undefined);
        }
      }

      const reader = id === "unlisted" ? readIndependentData : readSharedData;
      return await qualityData.read(reader, "catalog");
    },
    check(input): QualityCheckOutcome {
      const loadedData = input.dependencies;
      assertQualityData(loadedData);
      const dependency = input.memo.memo(compileQualityData)(loadedData);
      recordEvent(`rule:${id}:${dependency.revision}`);
      const diagnostics =
        id === "syntax"
          ? [
              {
                severity: "error" as const,
                object: {
                  kind: "translation-unit",
                  key: input.candidate.sourceKey,
                  language: input.candidate.language,
                },
                location: {
                  language: input.candidate.language,
                  range: "fr.json",
                  key: input.candidate.sourceKey,
                },
                message: `语法检查依据 ${dependency.revision}`,
                evidence: [],
              },
            ]
          : [];
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
    },
  });
}

const checks = [
  createChecker("syntax"),
  createChecker("terms"),
  createChecker("unlisted"),
];

export default defineConfig.withTypes<
  Unit,
  typeof unitSchema,
  typeof translationSchema,
  never,
  typeof bodySchema
>()({
  source: {
    schema: unitSchema,
    read() {
      recordEvent("source:read");
      return {
        scopes: [
          {
            range: "messages.json",
            enumeration: "complete",
            records: units.map((value) => ({
              value,
              bodyAvailability: "available" as const,
            })),
          },
        ],
      };
    },
  },
  keyOf: (unit) => unit.id,
  translations: {
    languages: ["fr"],
    keyOf: (translation) => ({ namespace: "messages", key: translation.id }),
    schema: translationSchema,
    contentSchema: bodySchema,
    contentOf: (translation) => translation.body,
    matches: (unit, translation) => unit.id === translation.id,
    read(_language, sourceUnits) {
      recordEvent("translations:read");
      return {
        scopes: [
          {
            range: "fr.json",
            enumeration: "complete",
            covers: sourceUnits.map(({ key }) => key),
            records: translations.map((value) => ({
              value,
              bodyAvailability: "available" as const,
            })),
          },
        ],
      };
    },
  },
  quality: {
    checks,
    groups: {
      daily: ["terms", "syntax"],
      syntaxOnly: ["syntax"],
      empty: [],
    },
    async buildCandidates({ defaultCandidates, memo, qualityData }) {
      recordEvent("candidate:build");
      if (shouldBuilderReadShared()) {
        const data = await qualityData.read(readSharedData, "catalog");
        memo.memo(compileQualityData)(data);
      }
      const mode = getCandidateMode();
      if (mode === "throw") throw new Error("候选构造失败。");
      if (mode === "empty") return [];
      return defaultCandidates;
    },
    exceptionStore,
    resultCache: createDirectoryQualityCheckResultCache(
      path.join(process.cwd(), ".lioni", "cache", "quality-results"),
    ),
  },
});
