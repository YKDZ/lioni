import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  defineConfig,
  DuplicateTranslationUnitKeyError,
  readSourceFacts,
} from "../src/index.ts";

void describe("source facts", () => {
  void it("reads raw source units and derives identity without reading translations", async () => {
    const rawUnit = {
      source: "Save",
      context: {
        file: "src/messages.ts",
        line: 18,
        screenshot: "shots/save-button.png",
      },
    };
    let reads = 0;
    let identityInput: typeof rawUnit | undefined;
    const config = defineConfig({
      source: {
        readUnits() {
          reads += 1;
          return [rawUnit];
        },
      },
      keyOf(unit) {
        identityInput = unit;
        return `${unit.context.file}:${unit.context.line}`;
      },
    });

    assert.equal(reads, 0);
    const facts = await readSourceFacts(config);

    assert.equal(reads, 1);
    assert.strictEqual(identityInput, rawUnit);
    assert.deepStrictEqual(facts.units, [
      { key: "src/messages.ts:18", unit: rawUnit },
    ]);
  });

  void it("reports duplicate identities instead of overwriting a source unit", async () => {
    const config = defineConfig({
      source: {
        readUnits: () => [
          { source: "Save", context: { file: "src/messages.ts", line: 18 } },
          { source: "Submit", context: { file: "src/messages.ts", line: 18 } },
        ],
      },
      keyOf: (unit) => `${unit.context.file}:${unit.context.line}`,
    });

    await assert.rejects(
      readSourceFacts(config),
      (error: unknown) =>
        error instanceof DuplicateTranslationUnitKeyError &&
        error.key === "src/messages.ts:18" &&
        error.firstIndex === 0 &&
        error.duplicateIndex === 1,
    );
  });

  void it("changes the fact version when non-identity source context changes", async () => {
    const makeConfig = (screenshot: string) =>
      defineConfig({
        source: {
          readUnits: () => [
            {
              source: "Save",
              context: {
                file: "src/messages.ts",
                line: 18,
                screenshot,
              },
            },
          ],
        },
        keyOf: (unit) => `${unit.context.file}:${unit.context.line}`,
      });

    const before = await readSourceFacts(makeConfig("shots/before.png"));
    const after = await readSourceFacts(makeConfig("shots/after.png"));

    assert.equal(before.units[0]?.key, after.units[0]?.key);
    assert.notEqual(before.version, after.version);
  });

  void it("uses changed source identity inputs to produce a new key", async () => {
    const makeConfig = (source: string, file: string) =>
      defineConfig({
        source: {
          readUnits: () => [{ source, context: { file, line: 18 } }],
        },
        keyOf: (unit) =>
          `${unit.context.file}:${unit.context.line}:${unit.source}`,
      });

    const before = await readSourceFacts(makeConfig("Save", "src/a.ts"));
    const after = await readSourceFacts(makeConfig("Submit", "src/b.ts"));

    assert.notEqual(before.units[0]?.key, after.units[0]?.key);
  });
});
