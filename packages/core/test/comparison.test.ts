import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ComparisonContractError,
  compareSnapshots,
  defineConfig,
  readComparisonSnapshot,
  type ComparisonResult,
  type ComparisonSnapshot,
  type Compare,
} from "../src/index.ts";
import {
  schemaFromExamples,
  sourceSchemaFromExamples,
} from "./source-schema.ts";

type Unit = {
  readonly source: string;
  readonly context: { readonly id: string };
};

type Translation = {
  readonly namespace: string;
  readonly id: string;
  readonly text: string;
};

type UnavailableTranslation = {
  readonly namespace: string;
  readonly id: string;
  readonly reason: string;
};

type SourceItem = {
  readonly value: Unit;
  readonly bodyAvailability?: "available" | "unavailable";
};

type SourceScope = {
  readonly range: string;
  readonly enumeration?: "complete" | "partial" | "failed";
  readonly records: readonly SourceItem[];
};

type TargetItem =
  | {
      readonly value: Translation;
      readonly bodyAvailability: "available";
    }
  | {
      readonly value: UnavailableTranslation;
      readonly bodyAvailability: "unavailable";
    };

type TargetScope = {
  readonly language: string;
  readonly range: string;
  readonly enumeration?: "complete" | "partial" | "failed";
  readonly covers?: readonly string[];
  readonly records: readonly TargetItem[];
};

const unitExample: Unit = {
  source: "example",
  context: { id: "example" },
};
const translationExample: Translation = {
  namespace: "messages",
  id: "example",
  text: "example",
};
const unavailableTranslationExample: UnavailableTranslation = {
  namespace: "messages",
  id: "example",
  reason: "not available",
};
const languages = ["de", "fr"] as const;

function snapshotConfig(
  sourceScopes: readonly SourceScope[],
  targetScopes: readonly TargetScope[],
  compare?: Compare<Unit, Translation, string, UnavailableTranslation>,
) {
  return defineConfig({
    source: {
      schema: sourceSchemaFromExamples(unitExample),
      read: () => ({
        scopes: sourceScopes.map((scope) => ({
          range: scope.range,
          enumeration: scope.enumeration ?? "complete",
          records: scope.records.map(({ value, bodyAvailability }) => ({
            value,
            bodyAvailability: bodyAvailability ?? "available",
          })),
        })),
      }),
    },
    keyOf: ({ context }) => context.id,
    ...(compare === undefined ? {} : { compare }),
    translations: {
      languages,
      schema: schemaFromExamples(translationExample),
      unavailableSchema: schemaFromExamples(unavailableTranslationExample),
      contentSchema: schemaFromExamples("example"),
      contentOf: ({ text }) => text,
      identityOf: (translation, language) => ({
        language,
        namespace: translation.namespace,
        key: translation.id,
      }),
      read: (language) => ({
        scopes: targetScopes
          .filter((scope) => scope.language === language)
          .map((scope) => ({
            range: scope.range,
            covers: scope.covers ?? [],
            enumeration: scope.enumeration ?? "complete",
            records: scope.records,
          })),
      }),
    },
  });
}

async function readSnapshot(
  sourceScopes: readonly SourceScope[],
  targetScopes: readonly TargetScope[],
): Promise<
  ComparisonSnapshot<Unit, Translation, string, UnavailableTranslation>
> {
  return readComparisonSnapshot(snapshotConfig(sourceScopes, targetScopes));
}

function unit(id: string, source: string): Unit {
  return { source, context: { id } };
}

function translated(namespace: string, id: string, text: string): TargetItem {
  return {
    value: { namespace, id, text },
    bodyAvailability: "available",
  };
}

function unavailable(namespace: string, id: string): TargetItem {
  return {
    value: { namespace, id, reason: "unavailable" },
    bodyAvailability: "unavailable",
  };
}

function sourceChange(
  result: ComparisonResult<Unit, Translation, string, UnavailableTranslation>,
  key: string,
) {
  const change = result.sourceChanges.find(
    (candidate) => candidate.key === key,
  );
  assert.ok(change, `找不到原文变化 ${key}`);
  return change;
}

function translationChange(
  result: ComparisonResult<Unit, Translation, string, UnavailableTranslation>,
  language: string,
  namespace: string,
  key: string,
) {
  const change = result.translationChanges.find(
    (candidate) =>
      candidate.identity.language === language &&
      candidate.identity.namespace === namespace &&
      candidate.identity.key === key,
  );
  assert.ok(
    change,
    `找不到译文变化 ${JSON.stringify({ language, namespace, key })}`,
  );
  return change;
}

void describe("snapshot comparison", () => {
  void it("compares stable source and full target identities while retaining before and after facts", async () => {
    const previous = await readSnapshot(
      [
        {
          range: "messages.json",
          records: [
            { value: unit("save", "Save") },
            { value: unit("removed", "Retired") },
            { value: unit("stable", "Stable") },
            { value: unit("known-partial", "Before") },
          ],
        },
        {
          range: "partial.json",
          enumeration: "partial",
          records: [{ value: unit("unrelated-partial", "Partial before") }],
        },
      ],
      [
        {
          language: "fr",
          range: "fr.json",
          records: [
            translated("messages", "save", "Enregistrer"),
            translated("legacy", "orphan", "Ancien"),
            translated("messages", "stale", "Obsolète"),
            translated("buttons", "confirm", "Confirmer"),
            translated("messages", "stable", "Stable"),
            translated("messages", "known-partial", "Avant"),
          ],
        },
        { language: "de", range: "de.json", records: [] },
        {
          language: "fr",
          range: "fr-partial.json",
          enumeration: "partial",
          records: [
            translated("messages", "unrelated-partial", "Partiel avant"),
          ],
        },
      ],
    );
    const current = await readSnapshot(
      [
        {
          range: "messages.json",
          records: [
            { value: unit("added", "New") },
            { value: unit("save", "Save now") },
            { value: unit("stable", "Stable") },
            { value: unit("known-partial", "After") },
          ],
        },
        {
          range: "partial.json",
          enumeration: "failed",
          records: [{ value: unit("unrelated-partial", "Partial after") }],
        },
      ],
      [
        {
          language: "fr",
          range: "fr.json",
          records: [
            translated("messages", "save", "Sauvegarder"),
            translated("plugins", "orphan", "Orphelin"),
            translated("messages", "stable", "Stable"),
            translated("messages", "known-partial", "Après"),
          ],
        },
        {
          language: "de",
          range: "de.json",
          records: [translated("buttons", "confirm", "Bestätigen")],
        },
        {
          language: "fr",
          range: "fr-partial.json",
          enumeration: "partial",
          records: [
            translated("messages", "unrelated-partial", "Partiel après"),
          ],
        },
      ],
    );
    const previousBefore = structuredClone(previous);
    const currentBefore = structuredClone(current);

    const result = await compareSnapshots({ previous, current });

    assert.equal(sourceChange(result, "save").status, "modified");
    assert.equal(sourceChange(result, "save").previous?.unit.source, "Save");
    assert.equal(sourceChange(result, "save").current?.unit.source, "Save now");
    assert.equal(sourceChange(result, "stable").status, "unchanged");
    assert.equal(sourceChange(result, "added").status, "added");
    assert.equal(sourceChange(result, "removed").status, "removed");
    assert.equal(sourceChange(result, "known-partial").status, "modified");

    assert.equal(
      translationChange(result, "fr", "messages", "save").status,
      "modified",
    );
    assert.equal(
      translationChange(result, "fr", "messages", "save").previous?.content,
      "Enregistrer",
    );
    assert.equal(
      translationChange(result, "fr", "messages", "save").current?.content,
      "Sauvegarder",
    );
    assert.equal(
      translationChange(result, "fr", "messages", "stable").status,
      "unchanged",
    );
    assert.equal(
      translationChange(result, "fr", "plugins", "orphan").status,
      "added",
    );
    assert.equal(
      translationChange(result, "fr", "legacy", "orphan").status,
      "removed",
    );
    assert.equal(
      translationChange(result, "de", "buttons", "confirm").status,
      "added",
    );
    assert.equal(
      translationChange(result, "fr", "buttons", "confirm").status,
      "removed",
    );
    assert.equal(
      translationChange(result, "fr", "messages", "stale").status,
      "removed",
    );
    assert.equal(
      translationChange(result, "fr", "messages", "known-partial").status,
      "modified",
    );
    assert.deepStrictEqual(result.reads.previous?.source, previous.source.read);
    assert.deepStrictEqual(result.reads.current.source, current.source.read);
    assert.deepStrictEqual(previous, previousBefore);
    assert.deepStrictEqual(current, currentBefore);
  });

  void it("distinguishes a missing history from complete empty snapshots", async () => {
    const current = await readSnapshot(
      [
        {
          range: "messages.json",
          records: [{ value: unit("welcome", "Welcome") }],
        },
      ],
      [
        { language: "de", range: "de.json", records: [] },
        {
          language: "fr",
          range: "fr.json",
          records: [translated("plugins", "orphan", "Legacy")],
        },
      ],
    );
    const withoutHistory = await compareSnapshots({
      previous: undefined,
      current,
    });

    assert.equal(
      sourceChange(withoutHistory, "welcome").status,
      "historyMissing",
    );
    assert.equal(
      translationChange(withoutHistory, "fr", "plugins", "orphan").status,
      "historyMissing",
    );
    assert.equal(withoutHistory.reads.previous, undefined);
    assert.deepStrictEqual(
      withoutHistory.reads.current.source,
      current.source.read,
    );

    const empty = await readSnapshot(
      [{ range: "messages.json", records: [] }],
      [
        { language: "de", range: "de.json", records: [] },
        { language: "fr", range: "fr.json", records: [] },
      ],
    );
    const completeEmpty = await compareSnapshots({
      previous: empty,
      current: empty,
    });

    assert.deepStrictEqual(completeEmpty.sourceChanges, []);
    assert.deepStrictEqual(completeEmpty.translationChanges, []);
    assert.equal(completeEmpty.reads.previous?.source.status, "complete");
    assert.equal(completeEmpty.reads.current.source.status, "complete");

    const fromEmpty = await compareSnapshots({ previous: empty, current });
    assert.equal(sourceChange(fromEmpty, "welcome").status, "added");
    assert.equal(
      translationChange(fromEmpty, "fr", "plugins", "orphan").status,
      "added",
    );
  });

  void it("reports evidence gaps per identity and body availability per side", async () => {
    const previous = await readSnapshot(
      [
        {
          range: "messages.json",
          enumeration: "partial",
          records: [
            { value: unit("source-old", "Old") },
            {
              value: unit("source-history-unavailable", "Hidden"),
              bodyAvailability: "unavailable",
            },
            { value: unit("source-current-unavailable", "Visible") },
            {
              value: unit("source-both-unavailable", "Hidden both sides"),
              bodyAvailability: "unavailable",
            },
          ],
        },
      ],
      [
        {
          language: "fr",
          range: "fr.json",
          enumeration: "partial",
          records: [
            translated("messages", "target-history-unavailable", "Before"),
            unavailable("messages", "target-both-unavailable"),
            translated("messages", "target-current-unavailable", "Before"),
            translated("messages", "target-old", "Gone"),
          ],
        },
      ],
    );
    const current = await readSnapshot(
      [
        {
          range: "messages.json",
          enumeration: "partial",
          records: [
            { value: unit("source-new", "New") },
            { value: unit("source-history-unavailable", "Available now") },
            {
              value: unit("source-current-unavailable", "Hidden"),
              bodyAvailability: "unavailable",
            },
            {
              value: unit("source-both-unavailable", "Hidden both sides"),
              bodyAvailability: "unavailable",
            },
          ],
        },
      ],
      [
        {
          language: "fr",
          range: "fr.json",
          enumeration: "partial",
          records: [
            translated("messages", "target-history-unavailable", "After"),
            unavailable("messages", "target-both-unavailable"),
            unavailable("messages", "target-current-unavailable"),
            translated("messages", "target-new", "New"),
          ],
        },
      ],
    );
    const result = await compareSnapshots({ previous, current });

    assert.equal(
      sourceChange(result, "source-new").status,
      "historyInsufficient",
    );
    assert.equal(
      sourceChange(result, "source-old").status,
      "currentInsufficient",
    );
    assert.equal(
      sourceChange(result, "source-history-unavailable").status,
      "historyInsufficient",
    );
    assert.equal(
      sourceChange(result, "source-current-unavailable").status,
      "currentInsufficient",
    );
    assert.equal(
      sourceChange(result, "source-both-unavailable").status,
      "bothInsufficient",
    );
    assert.equal(
      translationChange(result, "fr", "messages", "target-new").status,
      "historyInsufficient",
    );
    assert.equal(
      translationChange(result, "fr", "messages", "target-old").status,
      "currentInsufficient",
    );
    assert.equal(
      translationChange(result, "fr", "messages", "target-history-unavailable")
        .status,
      "modified",
    );
    assert.equal(
      translationChange(result, "fr", "messages", "target-current-unavailable")
        .status,
      "currentInsufficient",
    );
    assert.equal(
      translationChange(result, "fr", "messages", "target-both-unavailable")
        .status,
      "bothInsufficient",
    );
  });

  void it("accepts a custom comparison result without rerunning the default algorithm", async () => {
    const previous = await readSnapshot(
      [{ range: "messages.json", records: [{ value: unit("save", "Save") }] }],
      [{ language: "fr", range: "fr.json", records: [] }],
    );
    const current = await readSnapshot(
      [
        {
          range: "messages.json",
          records: [{ value: unit("save", "Save now") }],
        },
      ],
      [{ language: "fr", range: "fr.json", records: [] }],
    );
    const input = { previous, current };
    let calls = 0;
    const custom: Compare<
      Unit,
      Translation,
      string,
      UnavailableTranslation
    > = async () => {
      calls += 1;
      const before = previous.source.units[0];
      const after = current.source.units[0];
      assert.ok(before);
      assert.ok(after);
      return {
        sourceChanges: [
          {
            key: "save",
            status: "unchanged",
            previous: before,
            current: after,
          },
        ],
        translationChanges: [],
        reads: {
          previous: {
            source: previous.source.read,
            translations: previous.translations.reads,
          },
          current: {
            source: current.source.read,
            translations: current.translations.reads,
          },
        },
      };
    };

    const configured = snapshotConfig([], [], custom);
    assert.strictEqual(configured.compare, custom);

    const result = await compareSnapshots(input, custom);

    assert.equal(calls, 1);
    assert.equal(result.sourceChanges[0]?.status, "unchanged");
  });

  void it("propagates custom failures and rejects results with changed read evidence", async () => {
    const previous = await readSnapshot(
      [{ range: "messages.json", records: [{ value: unit("save", "Save") }] }],
      [{ language: "fr", range: "fr.json", records: [] }],
    );
    const current = await readSnapshot(
      [
        {
          range: "messages.json",
          records: [{ value: unit("save", "Save now") }],
        },
      ],
      [{ language: "fr", range: "fr.json", records: [] }],
    );
    const input = { previous, current };
    const failure = new Error("custom comparison failed");
    let calls = 0;

    await assert.rejects(
      compareSnapshots(input, () => {
        calls += 1;
        throw failure;
      }),
      (error: unknown) => error === failure,
    );
    assert.equal(calls, 1);

    const before = previous.source.units[0];
    const after = current.source.units[0];
    assert.ok(before);
    assert.ok(after);
    calls = 0;
    await assert.rejects(
      compareSnapshots(input, () => {
        calls += 1;
        return {
          sourceChanges: [
            {
              key: "save",
              status: "modified",
              previous: before,
              current: after,
            },
          ],
          translationChanges: [],
          reads: {
            previous: {
              source: { ...previous.source.read, status: "failed" },
              translations: previous.translations.reads,
            },
            current: {
              source: current.source.read,
              translations: current.translations.reads,
            },
          },
        };
      }),
      (error: unknown) => error instanceof ComparisonContractError,
    );
    assert.equal(calls, 1);
  });
});
