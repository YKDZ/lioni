import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  ComparisonBaselineFormatError,
  defineConfig,
  readComparisonSnapshot,
  recordComparisonBaseline,
  replaceComparisonBaseline,
  type JsonValue,
} from "../src/index.ts";
import { createFileComparisonBaselineStore } from "../src/node.ts";
import {
  jsonValueSchema,
  schemaFromExamples,
  sourceSchemaFromExamples,
} from "./source-schema.ts";

type Unit = { readonly id: string; readonly source: string };
type Translation = {
  readonly id: string;
  readonly namespace: string;
  readonly text: string;
};
type UnavailableTranslation = {
  readonly id: string;
  readonly namespace: string;
  readonly reason: string;
};

const translationSchema = schemaFromExamples<Translation>({
  id: "example",
  namespace: "messages",
  text: "example",
});
const unavailableSchema = schemaFromExamples<UnavailableTranslation>({
  id: "example",
  namespace: "messages",
  reason: "unavailable",
});

type SourceScope = {
  readonly range: string;
  readonly records: readonly {
    readonly value: Unit;
    readonly bodyAvailability?: "available" | "unavailable";
  }[];
  readonly enumeration?: "complete" | "partial" | "failed";
};

type TranslationScope = {
  readonly range: string;
  readonly covers: readonly string[];
  readonly records: readonly (
    | {
        readonly value: Translation;
        readonly bodyAvailability?: "available";
      }
    | {
        readonly value: UnavailableTranslation;
        readonly bodyAvailability: "unavailable";
      }
  )[];
  readonly enumeration?: "complete" | "partial" | "failed";
};

function makeConfig(options: {
  readonly sourceScopes: readonly SourceScope[];
  readonly translationScopes?: readonly TranslationScope[];
  readonly sourceError?: string;
  readonly languages?: readonly string[];
}) {
  return defineConfig({
    source: {
      schema: sourceSchemaFromExamples<Unit>(
        { id: "example", source: "example" },
        ...options.sourceScopes.flatMap(({ records }) =>
          records.map(({ value }) => value),
        ),
      ),
      read: () => {
        if (options.sourceError !== undefined)
          throw new Error(options.sourceError);
        return {
          scopes: options.sourceScopes.map((scope) => ({
            range: scope.range,
            enumeration: scope.enumeration ?? "complete",
            records: scope.records.map(({ value, bodyAvailability }) => ({
              value,
              bodyAvailability: bodyAvailability ?? "available",
            })),
          })),
        };
      },
    },
    keyOf: ({ id }) => id,
    translations: {
      languages: options.languages ?? ["fr"],
      schema: translationSchema,
      unavailableSchema,
      contentSchema: jsonValueSchema,
      contentOf: ({ text }) => text,
      read: () => ({
        scopes: (options.translationScopes ?? []).map((scope) => ({
          range: scope.range,
          covers: scope.covers,
          enumeration: scope.enumeration ?? "complete",
          records: scope.records.map((record) =>
            record.bodyAvailability === "unavailable"
              ? { ...record, bodyAvailability: "unavailable" as const }
              : { ...record, bodyAvailability: "available" as const },
          ),
        })),
      }),
      identityOf: (translation) => ({
        namespace: translation.namespace,
        key: translation.id,
      }),
    },
  });
}

function sourceScope(range: string, ...records: readonly Unit[]): SourceScope {
  return { range, records: records.map((value) => ({ value })) };
}

function translationScope(
  range: string,
  ...records: readonly (Translation | UnavailableTranslation)[]
): TranslationScope {
  return {
    range,
    covers: [],
    records: records.map((value) =>
      "reason" in value
        ? { value, bodyAvailability: "unavailable" as const }
        : { value, bodyAvailability: "available" as const },
    ),
  };
}

function createTestStore(filePath: string) {
  return createFileComparisonBaselineStore<
    Unit,
    Translation,
    JsonValue,
    UnavailableTranslation
  >(filePath);
}

async function withDirectory(
  run: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lioni-baseline-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

void describe("comparison baselines", () => {
  void it("records actual source and target facts without associations or QA", async () => {
    await withDirectory(async (directory) => {
      const config = makeConfig({
        sourceScopes: [
          sourceScope(
            "messages",
            { id: "save", source: "Save" },
            { id: "submit", source: "Submit" },
          ),
        ],
        translationScopes: [
          translationScope(
            "catalogue.fr",
            {
              id: "save",
              namespace: "ui",
              text: "Enregistrer",
            },
            {
              id: "legacy",
              namespace: "legacy",
              reason: "text is encrypted",
            },
          ),
        ],
      });
      const pathName = path.join(directory, "lioni.baseline.json");
      const store = createTestStore(pathName);

      const result = await recordComparisonBaseline(config, store);
      const loaded = await store.load();

      assert.equal(result.outcome, "saved");
      assert.deepStrictEqual(loaded, result.baseline);
      assert.deepStrictEqual(
        result.baseline.snapshot.translations.records.map((record) => [
          record.identity,
          record.bodyAvailability,
        ]),
        [
          [{ language: "fr", namespace: "ui", key: "save" }, "available"],
          [
            { language: "fr", namespace: "legacy", key: "legacy" },
            "unavailable",
          ],
        ],
      );
      assert.deepStrictEqual(
        result.baseline.snapshot.source.units.map(({ key }) => key),
        ["save", "submit"],
      );
      assert.deepStrictEqual(
        JSON.parse(await readFile(pathName, "utf8")),
        result.baseline,
      );
    });
  });

  void it("records complete empty scopes and skips unchanged file writes", async () => {
    await withDirectory(async (directory) => {
      const config = makeConfig({
        sourceScopes: [sourceScope("empty-source")],
        translationScopes: [translationScope("empty-target")],
      });
      const store = createTestStore(path.join(directory, "baseline.json"));

      const first = await recordComparisonBaseline(config, store);
      const pathName = path.join(directory, "baseline.json");
      const before = await stat(pathName, { bigint: true });
      const second = await recordComparisonBaseline(config, store);
      const after = await stat(pathName, { bigint: true });

      assert.equal(first.outcome, "saved");
      assert.equal(second.outcome, "unchanged");
      assert.deepStrictEqual(second.baseline, first.baseline);
      assert.equal(before.ino, after.ino);
      assert.equal(before.mtimeNs, after.mtimeNs);
    });
  });

  void it("records a source-only snapshot without requiring target configuration", async () => {
    await withDirectory(async (directory) => {
      const config = defineConfig({
        source: {
          schema: sourceSchemaFromExamples<Unit>({
            id: "source-only",
            source: "Original",
          }),
          read: () => ({
            scopes: [
              {
                range: "messages",
                enumeration: "complete",
                records: [
                  {
                    value: { id: "source-only", source: "Original" },
                    bodyAvailability: "available",
                  },
                ],
              },
            ],
          }),
        },
        keyOf: ({ id }) => id,
      });
      const store = createFileComparisonBaselineStore<Unit, never>(
        path.join(directory, "baseline.json"),
      );

      const result = await recordComparisonBaseline(config, store);

      assert.equal(result.outcome, "saved");
      assert.deepStrictEqual(result.baseline.snapshot.translations, {
        reads: [],
        records: [],
      });
      assert.deepStrictEqual(
        result.baseline.snapshot.source.units.map(({ key }) => key),
        ["source-only"],
      );
    });
  });

  void it("replaces only selected scopes and rebuilds all scope and record indexes", async () => {
    const previousSnapshot = await readComparisonSnapshot(
      makeConfig({
        sourceScopes: [
          sourceScope("a", { id: "a", source: "A" }),
          sourceScope("b", { id: "b", source: "B old" }),
        ],
        translationScopes: [
          translationScope("target-a", {
            id: "a",
            namespace: "ui",
            text: "A fr",
          }),
          translationScope("target-b", {
            id: "b",
            namespace: "ui",
            text: "B old fr",
          }),
        ],
      }),
    );
    const baseline = replaceComparisonBaseline({ current: previousSnapshot });
    const currentSnapshot = await readComparisonSnapshot(
      makeConfig({
        sourceScopes: [sourceScope("b", { id: "b-new", source: "B new" })],
        translationScopes: [
          translationScope("target-b", {
            id: "b-new",
            namespace: "ui",
            text: "B new fr",
          }),
        ],
      }),
    );

    const replaced = replaceComparisonBaseline({
      previous: baseline,
      current: currentSnapshot,
      selection: {
        sourceRanges: ["b"],
        translationRanges: [{ language: "fr", range: "target-b" }],
      },
    });

    assert.deepStrictEqual(
      replaced.snapshot.source.read.scopes.map(({ range }) => range),
      ["a", "b"],
    );
    assert.notEqual(replaced.snapshot.version, baseline.snapshot.version);
    assert.notEqual(
      replaced.snapshot.source.version,
      baseline.snapshot.source.version,
    );
    assert.deepStrictEqual(
      replaced.snapshot.source.units.map(({ key, scopeIndex }) => [
        key,
        scopeIndex,
      ]),
      [
        ["a", 0],
        ["b-new", 1],
      ],
    );
    assert.deepStrictEqual(
      replaced.snapshot.translations.reads[0]?.scopes.map(
        ({ range, translationIndexes }) => [range, translationIndexes],
      ),
      [
        ["target-a", [0]],
        ["target-b", [1]],
      ],
    );
    assert.deepStrictEqual(
      replaced.snapshot.translations.records.map(({ index, scopeIndex }) => [
        index,
        scopeIndex,
      ]),
      [
        [0, 0],
        [1, 1],
      ],
    );
    assert.throws(
      () =>
        replaceComparisonBaseline({
          previous: baseline,
          current: currentSnapshot,
          selection: { sourceRanges: ["not-read"], translationRanges: [] },
        }),
      /没有对应的本次读取证据/u,
    );
  });

  void it("leaves an existing file untouched when configured reads are incomplete", async () => {
    await withDirectory(async (directory) => {
      const pathName = path.join(directory, "baseline.json");
      const store = createTestStore(pathName);
      const completeConfig = makeConfig({
        sourceScopes: [sourceScope("messages", { id: "save", source: "Save" })],
        translationScopes: [translationScope("catalogue.fr")],
      });
      const saved = await recordComparisonBaseline(completeConfig, store);
      const previousContents = await readFile(pathName, "utf8");
      const incompleteConfig = makeConfig({
        sourceScopes: [
          {
            ...sourceScope("messages", { id: "save", source: "Save" }),
            enumeration: "partial",
          },
        ],
        translationScopes: [translationScope("catalogue.fr")],
      });
      const failedConfig = makeConfig({
        sourceScopes: [],
        sourceError: "source resource unavailable",
        translationScopes: [translationScope("catalogue.fr")],
      });
      const incompleteTranslationConfig = makeConfig({
        sourceScopes: [sourceScope("messages", { id: "save", source: "Save" })],
        translationScopes: [
          { ...translationScope("catalogue.fr"), enumeration: "partial" },
        ],
      });

      for (const config of [
        incompleteConfig,
        failedConfig,
        incompleteTranslationConfig,
      ]) {
        await assert.rejects(recordComparisonBaseline(config, store), {
          name: "ComparisonBaselineIncompleteSnapshotError",
        });
        assert.equal(await readFile(pathName, "utf8"), previousContents);
      }

      assert.deepStrictEqual(await store.load(), saved.baseline);
    });
  });

  void it("reports old processing baseline files as unsupported", async () => {
    await withDirectory(async (directory) => {
      const pathName = path.join(directory, "baseline.json");
      await writeFile(
        pathName,
        `${JSON.stringify({ formatVersion: 1, entries: [], sourceScopes: [] })}\n`,
      );

      await assert.rejects(
        createFileComparisonBaselineStore(pathName).load(),
        ComparisonBaselineFormatError,
      );
    });
  });
});
