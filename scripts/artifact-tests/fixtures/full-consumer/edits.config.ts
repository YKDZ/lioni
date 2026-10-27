import { readFileSync, writeFileSync } from "node:fs";

import { defineConfig, defineQualityCheck } from "@lioni/core";

import { isNumberArray, isRecord, standardSchema } from "./schemas.ts";

type Unit = {
  source: string;
  context: {
    identity: string;
    line: number;
    targetKey: string;
    screenshot: string;
    unrelated?: string;
  };
};
type Translation = {
  targetId: string;
  text: string;
  context: {
    file: string;
    resourceKey: string;
    sourceLines: number[];
    annotation?: string;
    readOnly?: boolean;
    writeFailure?: boolean;
    writeIgnore?: boolean;
  };
};
const sourceSchema = standardSchema<Unit>(
  (value): value is Unit =>
    isRecord(value) &&
    typeof value.source === "string" &&
    isRecord(value.context) &&
    typeof value.context.identity === "string" &&
    typeof value.context.line === "number" &&
    typeof value.context.targetKey === "string" &&
    typeof value.context.screenshot === "string" &&
    (value.context.unrelated === undefined ||
      typeof value.context.unrelated === "string"),
);
const translationSchema = standardSchema<Translation>(
  (value): value is Translation =>
    isRecord(value) &&
    typeof value.targetId === "string" &&
    typeof value.text === "string" &&
    isRecord(value.context) &&
    typeof value.context.file === "string" &&
    typeof value.context.resourceKey === "string" &&
    isNumberArray(value.context.sourceLines) &&
    (value.context.annotation === undefined ||
      typeof value.context.annotation === "string") &&
    (value.context.readOnly === undefined ||
      typeof value.context.readOnly === "boolean") &&
    (value.context.writeFailure === undefined ||
      typeof value.context.writeFailure === "boolean") &&
    (value.context.writeIgnore === undefined ||
      typeof value.context.writeIgnore === "boolean"),
);
const contentSchema = standardSchema<string>(
  (value): value is string => typeof value === "string",
);
const qaConfigurationSchema = standardSchema<{ readonly review?: string }>(
  (value): value is { readonly review?: string } =>
    isRecord(value) &&
    (value.review === undefined || typeof value.review === "string"),
);

function readSources(): Unit[] {
  return JSON.parse(readFileSync("edit-sources.json", "utf8")) as Unit[];
}

function readCatalogue(): {
  enumeration: "complete" | "partial";
  records: Translation[];
  unrelated: unknown;
} {
  return JSON.parse(readFileSync("edit-catalogue.json", "utf8")) as {
    enumeration: "complete" | "partial";
    records: Translation[];
    unrelated: unknown;
  };
}

export default defineConfig({
  source: {
    schema: sourceSchema,
    read() {
      return {
        scopes: [
          {
            range: "edit-sources.json",
            enumeration: "complete",
            records: readSources().map((value) => ({
              value,
              bodyAvailability: "available" as const,
            })),
          },
        ],
      };
    },
  },
  keyOf: (unit) => unit.context.identity,
  translations: {
    languages: ["fr"],
    identityOf: (translation) => ({
      namespace: "edit-targets",
      key: translation.targetId,
    }),
    schema: translationSchema,
    contentSchema,
    contentOf: (translation) => translation.text,
    read(_language, sourceUnits) {
      const catalogue = readCatalogue();
      return {
        scopes: [
          {
            range: "edit-catalogue.json",
            covers: sourceUnits.map(({ key }) => key),
            enumeration: catalogue.enumeration,
            records: catalogue.records.map((value) => ({
              value,
              bodyAvailability: "available" as const,
            })),
          },
        ],
      };
    },
    matches: (unit, translation) =>
      translation.context.sourceLines.includes(unit.context.line),
  },
  qualityChecks: [
    defineQualityCheck<Unit, Translation, typeof qaConfigurationSchema>({
      id: "host-review",
      version: "host-review-v1",
      configurationSchema: qaConfigurationSchema,
      configuration: { review: "manual" },
      check: ({ candidate }) => ({
        status: "complete",
        diagnostics: [
          {
            severity: "warning",
            object: {
              kind: "translation-unit",
              key: candidate.sourceKey,
              language: candidate.language,
            },
            location: {
              language: candidate.language,
              range: "edit-catalogue.json",
              key: candidate.sourceKey,
            },
            message: "待复核",
            evidence: [],
          },
        ],
        issues: [],
        coverage: {
          selected: 1,
          evaluated: 1,
          notApplicable: 0,
          incomplete: 0,
          failed: 0,
        },
      }),
    }),
    defineQualityCheck<Unit, Translation, typeof qaConfigurationSchema>({
      id: "unconfigured-check",
      version: "unconfigured-check-v1",
      configurationSchema: qaConfigurationSchema,
      configuration: {},
      check: () => ({
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
      }),
    }),
  ],
  translationWriteback: {
    locateExistingTarget({ translation }) {
      if (translation.translation.context.readOnly)
        return { status: "notWritable", reason: "该译文资源只读。" };
      return {
        status: "located",
        locator: {
          file: translation.translation.context.file,
          key: translation.translation.context.resourceKey,
        },
      };
    },
    locateNewTarget({ sourceUnit, language }) {
      const key = sourceUnit.unit.context.targetKey;
      if (key === "")
        return { status: "notWritable", reason: "宿主无法定位新增目标。" };
      return {
        status: "located",
        locator: { file: "locales/" + language + ".json", key },
      };
    },
    write({ request, sourceUnit, target, currentTranslation }) {
      const catalogue = readCatalogue();
      if (request.operation !== "write" || typeof request.content !== "string")
        throw new Error("编辑宿主只接受字符串译文写入请求。");
      if (target.kind === "existing") {
        if (currentTranslation?.translation.context.writeFailure)
          throw new Error("宿主资源拒绝保存该译文。");
        if (currentTranslation?.translation.context.writeIgnore) return;
        const locator = target.locator as { file: string; key: string };
        const record = catalogue.records.find(
          (item) =>
            item.context.file === locator.file &&
            item.context.resourceKey === locator.key,
        );
        if (record === undefined) throw new Error("实际译文定位已失效。");
        record.text = request.content;
      } else {
        if (sourceUnit === undefined)
          throw new Error("新建目标需要明确的原文单元。");
        const locator = target.locator as { file: string; key: string };
        catalogue.records.push({
          targetId: locator.key,
          text: request.content,
          context: {
            file: locator.file,
            resourceKey: locator.key,
            sourceLines: [sourceUnit.unit.context.line],
            annotation: "created by host adapter",
          },
        });
      }
      writeFileSync("edit-catalogue.json", JSON.stringify(catalogue, null, 2));
    },
  },
});
