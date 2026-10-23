import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import type { CliJourney } from "../journey.ts";

const journey: CliJourney = {
  name: "facts",
  modes: ["source", "distribution"],
  async setup({ workDir }) {
    await writeFile(
      path.join(workDir, "l10n.config.ts"),
      `export default {
  source: {
    read: () => ({ scopes: [{
      range: "src/messages.ts",
      enumeration: "complete",
      records: [{
        value: {
          source: "Save",
          context: { file: "src/messages.ts", line: 18, screenshot: "shots/save.png" }
        },
        bodyAvailability: "available"
      }]
    }] })
  },
  keyOf: (unit) => unit.context.file + ":" + unit.context.line,
  translations: {
    languages: ["fr"],
    read: (_language, sourceUnits) => ({ scopes: [{
      range: "locales/fr.json",
      covers: sourceUnits.map(({ key }) => key),
      enumeration: "complete",
      records: [
        {
          value: { text: "Enregistrer", context: { file: "src/messages.ts", line: 18 } },
          bodyAvailability: "available"
        },
        {
          value: { text: "Avis", context: { file: "legacy/messages.ts", line: 999 } },
          bodyAvailability: "available"
        }
      ]
    }] }),
    matches: (unit, translation) =>
      unit.context.file === translation.context.file &&
      unit.context.line === translation.context.line
  }
};
`,
    );
    await writeFile(
      path.join(workDir, "duplicate.config.ts"),
      `export default {
  source: {
    read: () => ({ scopes: [{
      range: "src/messages.ts",
      enumeration: "complete",
      records: [
        { value: { source: "Save", context: { file: "src/messages.ts", line: 18 } }, bodyAvailability: "available" },
        { value: { source: "Submit", context: { file: "src/messages.ts", line: 18 } }, bodyAvailability: "available" }
      ]
    }] })
  },
  keyOf: (unit) => unit.context.file + ":" + unit.context.line
};
`,
    );
  },
  commands() {
    return [
      {
        name: "structured source and translation facts",
        args: ["facts", "l10n.config.ts"],
      },
      {
        name: "readable source and translation facts",
        args: ["facts", "l10n.config.ts", "--output-format", "text"],
      },
      {
        name: "duplicate source identity",
        args: ["facts", "duplicate.config.ts"],
      },
      { name: "help", args: ["--help"] },
      { name: "version", args: ["--version"] },
    ];
  },
  async assertions({ results }) {
    const structured = results[0];
    const readable = results[1];
    const duplicate = results[2];
    assert.equal(
      structured?.exitCode,
      0,
      `${structured?.stdout ?? ""}${structured?.stderr ?? ""}`,
    );
    assert.equal(structured?.stderr, "");
    const result = JSON.parse(structured?.stdout ?? "") as {
      data: {
        version: string;
        source: {
          totalUnitCount: number | null;
          read: { status: string };
          units: readonly {
            key: string;
            unit: {
              source: string;
              context: { file: string; line: number; screenshot: string };
            };
            bodyAvailability: string;
            scopeIndex: number;
          }[];
        };
        translations: {
          reads: readonly {
            language: string;
            status: string;
            scopes: readonly {
              range: string;
              covers: readonly string[];
              enumeration: string;
              translationIndexes: readonly number[];
            }[];
          }[];
          records: readonly {
            index: number;
            language: string;
            scopeIndex: number;
            range: string;
            translation: {
              text: string;
              context: { file: string; line: number };
            };
            bodyAvailability: string;
          }[];
        };
        associations: readonly {
          sourceKey: string;
          language: string;
          status: string;
          coverageStatus: string;
          scopeIndexes: readonly number[];
          translationIndexes: readonly number[];
        }[];
      };
    };
    assert.match(result.data.version, /^sha256:[a-f0-9]{64}$/u);
    assert.equal(result.data.source.read.status, "complete");
    assert.equal(result.data.source.totalUnitCount, 1);
    assert.deepEqual(result.data.source.units, [
      {
        key: "src/messages.ts:18",
        unit: {
          source: "Save",
          context: {
            file: "src/messages.ts",
            line: 18,
            screenshot: "shots/save.png",
          },
        },
        bodyAvailability: "available",
        scopeIndex: 0,
      },
    ]);
    assert.deepEqual(result.data.translations.reads, [
      {
        language: "fr",
        status: "complete",
        scopes: [
          {
            range: "locales/fr.json",
            covers: ["src/messages.ts:18"],
            enumeration: "complete",
            translationIndexes: [0, 1],
          },
        ],
      },
    ]);
    assert.deepEqual(result.data.translations.records, [
      {
        index: 0,
        language: "fr",
        scopeIndex: 0,
        range: "locales/fr.json",
        translation: {
          text: "Enregistrer",
          context: { file: "src/messages.ts", line: 18 },
        },
        bodyAvailability: "available",
      },
      {
        index: 1,
        language: "fr",
        scopeIndex: 0,
        range: "locales/fr.json",
        translation: {
          text: "Avis",
          context: { file: "legacy/messages.ts", line: 999 },
        },
        bodyAvailability: "available",
      },
    ]);
    assert.deepEqual(result.data.associations, [
      {
        sourceKey: "src/messages.ts:18",
        language: "fr",
        status: "matched",
        coverageStatus: "complete",
        scopeIndexes: [0],
        translationIndexes: [0],
      },
    ]);
    assert.equal(readable?.exitCode, 0);
    assert.equal(readable?.stderr, "");
    assert.ok(readable?.stdout.includes(result.data.version));
    assert.match(readable?.stdout ?? "", /src\/messages\.ts:18/u);
    assert.ok(readable?.stdout.includes('"source":"Save"'));
    assert.match(readable?.stdout ?? "", /shots\/save\.png/u);
    assert.match(readable?.stdout ?? "", /Enregistrer/u);
    assert.match(readable?.stdout ?? "", /matched/u);
    assert.equal(duplicate?.exitCode, 1);
    assert.equal(duplicate?.stdout, "");
    assert.partialDeepStrictEqual(JSON.parse(duplicate?.stderr ?? ""), {
      kind: "failure",
      variant: "duplicateIdentity",
      data: { key: "src/messages.ts:18" },
    });
    assert.equal(results[3]?.exitCode, 0);
    assert.match(results[3]?.stdout ?? "", /facts/u);
    assert.equal(results[4]?.exitCode, 0);
    assert.equal(results[4]?.stdout, "l10n 0.0.0\n");
  },
};

export default journey;
