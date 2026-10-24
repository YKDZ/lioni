import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import type { CliJourney } from "../journey.ts";

const journey: CliJourney = {
  name: "completion",
  modes: ["source", "distribution"],
  async setup({ workDir }) {
    await writeFile(
      path.join(workDir, "l10n.config.ts"),
      `export default {
  source: {
    read: () => ({ scopes: [{
      range: "src/messages.ts",
      enumeration: "complete",
      records: [
        { value: { source: "Save", context: { file: "src/messages.ts", line: 18 } }, bodyAvailability: "available" },
        { value: { source: "Submit", context: { file: "src/messages.ts", line: 19 } }, bodyAvailability: "available" }
      ]
    }] })
  },
  keyOf: (unit) => unit.context.file + ":" + unit.context.line,
  translations: {
    languages: ["fr", "de"],
    read(language, sourceUnits) {
      return { scopes: [{
        range: "locales/" + language + ".json",
        covers: sourceUnits.map(({ key }) => key),
        enumeration: "complete",
        records: language === "fr" ? [
          { value: { text: "Save", context: { sourceLine: 18 } }, bodyAvailability: "available" },
          { value: { text: "Legacy", context: { sourceLine: 999 } }, bodyAvailability: "available" }
        ] : []
      }] };
    },
    matches: (unit, translation) => unit.context.line === translation.context.sourceLine,
    contentOf: (translation) => translation.text
  },
  completion: {
    criterion: "存在实际译文记录（允许同文）",
    resolveCompletion: ({ translations }) => translations.length > 0
  }
};
`,
    );
    await writeFile(
      path.join(workDir, "partial.config.ts"),
      `export default {
  source: {
    read: () => ({ scopes: [{
      range: "src/messages.ts",
      enumeration: "partial",
      records: [{ value: { source: "Save", context: { line: 18 } }, bodyAvailability: "available" }]
    }] })
  },
  keyOf: (unit) => String(unit.context.line),
  translations: {
    languages: ["fr"],
    read: (language, sourceUnits) => ({ scopes: [{
      range: "locales/fr.json",
      covers: sourceUnits.map(({ key }) => key),
      enumeration: "complete",
      records: [{ value: { text: "Save", context: { sourceLine: 18 } }, bodyAvailability: "available" }]
    }] }),
    matches: (unit, translation) => unit.context.line === translation.context.sourceLine,
    contentOf: (translation) => translation.text
  },
  completion: {
    criterion: "实际译文存在",
    resolveCompletion: ({ translations }) => translations.length > 0
  }
};
`,
    );
    await writeFile(
      path.join(workDir, "facts-only.config.ts"),
      `export default {
  source: { read: () => ({ scopes: [] }) },
  keyOf: (unit) => String(unit.source)
};
`,
    );
    await writeFile(
      path.join(workDir, "completion-no-language.config.ts"),
      `export default {
  source: { read: () => ({ scopes: [] }) },
  keyOf: (unit) => String(unit.source),
  completion: {
    criterion: "自定义完成判据",
    resolveCompletion: () => true
  }
};
`,
    );
  },
  commands() {
    return [
      { name: "structured completion", args: ["completion", "l10n.config.ts"] },
      {
        name: "readable completion",
        args: ["completion", "l10n.config.ts", "--output-format", "text"],
      },
      {
        name: "unknown source total",
        args: ["completion", "partial.config.ts"],
      },
      {
        name: "facts do not require a completion policy",
        args: ["facts", "facts-only.config.ts"],
      },
      {
        name: "completion requires a host policy",
        args: ["completion", "facts-only.config.ts"],
      },
      {
        name: "completion requires explicit target languages",
        args: ["completion", "completion-no-language.config.ts"],
      },
    ];
  },
  async assertions({ results }) {
    const structured = results[0];
    const readable = results[1];
    const partial = results[2];
    const factsOnly = results[3];
    const missingPolicy = results[4];
    const missingLanguages = results[5];
    assert.equal(structured?.exitCode, 0, structured?.stderr);
    assert.equal(structured?.stderr, "");
    const result = JSON.parse(structured?.stdout ?? "") as {
      data: {
        factsVersion: string;
        criterion: string;
        status: string;
        scope: {
          sourceReadStatus: string;
          sourceUnitCount: number | null;
          knownSourceUnitCount: number;
          targetLanguages: readonly string[];
          obligationCount: number | null;
          knownObligationCount: number;
        };
        confirmedCompleteCount: number;
        confirmedIncompleteCount: number;
        unknownCount: number;
        completionRate: number | null;
        obligations: readonly {
          sourceKey: string;
          language: string;
          status: string;
          translationIndexes: readonly number[];
        }[];
      };
    };
    assert.match(result.data.factsVersion, /^sha256:[a-f0-9]{64}$/u);
    assert.equal(result.data.criterion, "存在实际译文记录（允许同文）");
    assert.equal(result.data.status, "incomplete");
    assert.deepEqual(result.data.scope, {
      sourceReadStatus: "complete",
      sourceUnitCount: 2,
      knownSourceUnitCount: 2,
      targetLanguages: ["fr", "de"],
      obligationCount: 4,
      knownObligationCount: 4,
    });
    assert.equal(result.data.confirmedCompleteCount, 1);
    assert.equal(result.data.confirmedIncompleteCount, 3);
    assert.equal(result.data.unknownCount, 0);
    assert.equal(result.data.completionRate, 0.25);
    assert.deepEqual(
      result.data.obligations.map(
        ({ language, status, translationIndexes }) => ({
          language,
          status,
          translationIndexes,
        }),
      ),
      [
        { language: "fr", status: "complete", translationIndexes: [0] },
        { language: "fr", status: "incomplete", translationIndexes: [] },
        { language: "de", status: "incomplete", translationIndexes: [] },
        { language: "de", status: "incomplete", translationIndexes: [] },
      ],
    );
    assert.equal(readable?.exitCode, 0);
    assert.match(readable?.stdout ?? "", /存在实际译文记录（允许同文）/u);
    assert.match(readable?.stdout ?? "", /完成率：25\.0%/u);
    assert.match(readable?.stdout ?? "", /原文正文可用/u);
    assert.match(readable?.stdout ?? "", /src\/messages\.ts:18 → fr：完成/u);
    assert.equal(partial?.exitCode, 0);
    const partialResult = JSON.parse(partial?.stdout ?? "") as {
      data: {
        status: string;
        scope: {
          sourceUnitCount: number | null;
          obligationCount: number | null;
          knownObligationCount: number;
          unknownTotalReason: string;
        };
        completionRate: number | null;
      };
    };
    assert.equal(partialResult.data.status, "unknown");
    assert.equal(partialResult.data.scope.sourceUnitCount, null);
    assert.equal(partialResult.data.scope.obligationCount, null);
    assert.equal(partialResult.data.scope.knownObligationCount, 1);
    assert.equal(
      partialResult.data.scope.unknownTotalReason,
      "原文范围未完整枚举，原文总数未知。",
    );
    assert.equal(partialResult.data.completionRate, null);
    assert.equal(factsOnly?.exitCode, 0, factsOnly?.stderr);
    assert.equal(missingPolicy?.exitCode, 1);
    assert.equal(missingPolicy?.stdout, "");
    assert.partialDeepStrictEqual(JSON.parse(missingPolicy?.stderr ?? ""), {
      kind: "failure",
      variant: "configurationRequired",
      data: { reason: "missingPolicy" },
    });
    assert.equal(missingLanguages?.exitCode, 1);
    assert.partialDeepStrictEqual(JSON.parse(missingLanguages?.stderr ?? ""), {
      kind: "failure",
      variant: "configurationRequired",
      data: { reason: "missingTranslations" },
    });
  },
};

export default journey;
