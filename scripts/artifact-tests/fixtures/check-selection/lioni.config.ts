import path from "node:path";

import {
  defineConfig,
  defineChecker,
  type QualityFinding,
  type QualityObject,
  type StandardSchemaV1,
} from "@lioni/lioni";
import {
  createDirectoryQualityCheckResultCache,
  createFileQaSuppressionStore,
} from "@lioni/lioni/node";
import * as z from "zod";

import {
  getTermsLoaderMode,
  compileQualityData,
  readIndependentData,
  readSharedData,
  type QualityData,
  recordEvent,
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
});
const preparedDependencySchema = z.object({
  key: z.string(),
  revision: z.string(),
});

function assertQualityData(value: unknown): asserts value is QualityData {
  dependencySchema.parse(value);
}

const suppressionFileStore = createFileQaSuppressionStore(
  path.join(process.cwd(), "lioni.suppressions.yaml"),
);
const suppressionStore = {
  async load() {
    recordEvent("suppression:load");
    return await suppressionFileStore.load();
  },
  async upsert(suppression: Parameters<typeof suppressionFileStore.upsert>[0]) {
    recordEvent("suppression:upsert");
    await suppressionFileStore.upsert(suppression);
  },
};

function createChecker<const TId extends "syntax" | "terms" | "unlisted">(
  id: TId,
) {
  const inputSchema = z.object({
    candidateSourceKey: z.string(),
    candidateLanguage: z.string(),
    dependency: preparedDependencySchema,
  });
  return defineChecker.withTypes<Unit, Translation, string>()<
    typeof inputSchema,
    QualityObject,
    TId,
    QualityData
  >({
    id,
    version: "artifact.check-selection/v1",
    inputSchema,
    async load({ qualityData }) {
      recordEvent(`loader:${id}`);
      if (id === "terms") {
        const mode = getTermsLoaderMode();
        if (mode === "failure") throw new Error("术语检查资料读取失败。");
        if (mode === "reader-contract-error") {
          const invalidRead = qualityData.read as unknown as (
            reader: undefined,
          ) => Promise<unknown>;
          await invalidRead(undefined);
          throw new Error("无效读取器未被拒绝。");
        }
      }

      const reader = id === "unlisted" ? readIndependentData : readSharedData;
      const value = await qualityData.read(reader, "catalog");
      assertQualityData(value);
      return value;
    },
    prepare({ association, loaded, memo }) {
      assertQualityData(loaded);
      const dependency = memo.memo(compileQualityData)(loaded);
      return {
          candidateSourceKey: association.sourceKey,
          candidateLanguage: association.language,
          dependency,
        };
    },
    check(input): readonly QualityFinding[] {
      const dependency = input.dependency;
      recordEvent(`rule:${id}:${dependency.revision}`);
      const diagnostics =
        id === "syntax"
          ? [
              {
                severity: "error" as const,
                object: {
                  kind: "translation-unit",
                  key: input.candidateSourceKey,
                  language: input.candidateLanguage,
                },
                location: {
                  language: input.candidateLanguage,
                  range: "fr.json",
                  key: input.candidateSourceKey,
                },
                message: `语法检查依据 ${dependency.revision}`,
                evidence: [],
              },
            ]
          : [];
      return diagnostics;
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
    keyOf: (translation) => translation.id,
    schema: translationSchema,
    contentSchema: bodySchema,
    contentOf: (translation) => translation.body,
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
    suppressionStore,
    resultCache: createDirectoryQualityCheckResultCache(
      path.join(process.cwd(), ".lioni", "cache", "quality-results"),
    ),
  },
});
