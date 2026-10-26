import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  defineConfig,
  writeTranslationRequests,
  type JsonValue,
  type TranslationIdentity,
  type TranslationWriteRequest,
  type TranslationWritebackAdapter,
} from "../src/index.ts";
import {
  jsonValueSchema,
  schemaFromExamples,
  sourceSchemaFromExamples,
} from "./source-schema.ts";

type Unit = { id: string; source: string };
type Translation = { id: string; text: string };
type WriteInput = Parameters<
  NonNullable<TranslationWritebackAdapter<Unit, Translation>["write"]>
>[0];

function identity(id: string): TranslationIdentity {
  return { language: "fr", namespace: "messages", key: id };
}

function configFor(options: {
  readonly sources?: readonly Unit[];
  readonly translations: Translation[];
  readonly matches?: (unit: Unit, translation: Translation) => boolean;
  readonly locateExistingTarget?: (identity: TranslationIdentity) => JsonValue;
  readonly onWrite: (input: WriteInput) => void;
}) {
  const sources = [...(options.sources ?? [])];
  const translations = options.translations;
  return defineConfig({
    source: {
      schema: sourceSchemaFromExamples({ id: "example", source: "Example" }),
      read: () => ({
        scopes: [
          {
            range: "source.json",
            enumeration: "complete",
            records: sources.map((value) => ({
              value,
              bodyAvailability: "available" as const,
            })),
          },
        ],
      }),
    },
    keyOf: ({ id }) => id,
    compare: () => {
      throw new Error("执行写入不应重新比较。");
    },
    updatePolicy: () => {
      throw new Error("执行写入不应运行策略。");
    },
    translations: {
      languages: ["fr"],
      identityOf: (translation) => ({ namespace: "messages", key: translation.id }),
      schema: schemaFromExamples({ id: "example", text: "Exemple" }),
      contentSchema: jsonValueSchema,
      contentOf: ({ text }) => text,
      read: (_language, sourceUnits) => ({
        scopes: [
          {
            range: "fr.json",
            covers: sourceUnits.map(({ key }) => key),
            enumeration: "complete",
            records: translations.map((value) => ({
              value,
              bodyAvailability: "available" as const,
            })),
          },
        ],
      }),
      ...(options.matches === undefined ? {} : { matches: options.matches }),
    },
    translationWriteback: {
      locateExistingTarget: ({ identity: targetIdentity }) => ({
        status: "located",
        locator:
          options.locateExistingTarget?.(targetIdentity) ?? {
            file: "fr.json",
            key: targetIdentity.key,
          },
      }),
      locateNewTarget: ({ sourceUnit, language }) => ({
        status: "located",
        locator: { file: `${language}.json`, key: sourceUnit.key },
      }),
      write: options.onWrite,
    },
  });
}

void describe("translation write requests", () => {
  void it("writes an existing target by identity without source association", async () => {
    const target: Translation = { id: "A", text: "Ancien" };
    let writeCalls = 0;
    const config = configFor({
      translations: [target],
      onWrite: ({ request }) => {
        writeCalls += 1;
        assert.equal(request.operation, "write");
        assert.deepEqual(request.target, { identity: identity("A") });
        target.text = "Nouveau";
      },
    });

    const request: TranslationWriteRequest<JsonValue, Unit> = {
      operation: "write",
      target: { identity: identity("A") },
      content: "Nouveau",
      expectedTarget: {
        status: "present",
        identity: identity("A"),
        content: "Ancien",
      },
    };
    const result = await writeTranslationRequests([request], config);

    assert.equal(writeCalls, 1);
    assert.equal(result.results[0]?.status, "written");
  });

  void it("rejects an identity target whose expected content changed", async () => {
    const target: Translation = { id: "A", text: "Actuel" };
    let writeCalls = 0;
    const config = configFor({
      translations: [target],
      onWrite: () => {
        writeCalls += 1;
      },
    });
    const request: TranslationWriteRequest<JsonValue, Unit> = {
      operation: "write",
      target: { identity: identity("A") },
      content: "Nouveau",
      expectedTarget: {
        status: "present",
        identity: identity("A"),
        content: "Ancien",
      },
    };

    const result = await writeTranslationRequests([request], config);

    assert.equal(writeCalls, 0);
    assert.equal(result.results[0]?.status, "conflict");
  });

  void it("rejects an identity target whose expected range changed", async () => {
    const target: Translation = { id: "A", text: "Actuel" };
    let writeCalls = 0;
    const config = configFor({
      translations: [target],
      onWrite: () => {
        writeCalls += 1;
      },
    });
    const request: TranslationWriteRequest<JsonValue, Unit> = {
      operation: "write",
      target: { identity: identity("A") },
      content: "Nouveau",
      expectedTarget: {
        status: "present",
        identity: identity("A"),
        content: "Actuel",
        range: "old-fr.json",
      },
    };

    const result = await writeTranslationRequests([request], config);

    assert.equal(writeCalls, 0);
    assert.equal(result.results[0]?.status, "conflict");
  });

  void it("runs an explicitly composed condition before a valid write", async () => {
    const target: Translation = { id: "A", text: "Actuel" };
    let writeCalls = 0;
    const config = configFor({
      translations: [target],
      onWrite: () => {
        writeCalls += 1;
      },
    });
    const request: TranslationWriteRequest<JsonValue, Unit> = {
      operation: "write",
      target: { identity: identity("A") },
      content: "Nouveau",
      expectedTarget: {
        status: "present",
        identity: identity("A"),
        content: "Actuel",
      },
    };

    const result = await writeTranslationRequests(
      [request],
      config,
      ({ request: currentRequest, current }) => {
        assert.equal(currentRequest.operation, "write");
        assert.equal(current.translations.records.length, 1);
        return { status: "rejected", reason: "QA 条件未通过。" };
      },
    );

    assert.equal(writeCalls, 0);
    assert.equal(result.results[0]?.status, "conflict");
    assert.equal(result.results[0]?.reason, "QA 条件未通过。");
  });

  void it("keeps the validated candidate bound while an async condition waits", async () => {
    const target: Translation = { id: "A", text: "Actuel" };
    const desired = { text: "Checked" };
    let captured: JsonValue | undefined;
    let release: () => void = () => {};
    let enter: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const config = configFor({
      translations: [target],
      onWrite: ({ request }) => {
        if (request.operation === "write") captured = request.content;
      },
    });
    const request: TranslationWriteRequest<JsonValue, Unit> = {
      operation: "write",
      target: { identity: identity("A") },
      content: desired,
      expectedTarget: {
        status: "present",
        identity: identity("A"),
        content: "Actuel",
      },
    };

    const pending = writeTranslationRequests([request], config, async () => {
      enter();
      await gate;
      return true;
    });
    await entered;
    desired.text = "Changed after condition started";
    release();
    const result = await pending;

    assert.deepEqual(captured, { text: "Checked" });
    assert.equal(result.results[0]?.status, "writeUnconfirmed");
  });

  void it("deletes an existing identity target without a source or history reference", async () => {
    const target: Translation = { id: "orphan", text: "À retirer" };
    const records = [target];
    let writeCalls = 0;
    const config = configFor({
      translations: records,
      onWrite: ({ request }) => {
        writeCalls += 1;
        assert.equal(request.operation, "delete");
        assert.deepEqual(request.target, { identity: identity("orphan") });
        records.splice(records.indexOf(target), 1);
      },
    });
    const request: TranslationWriteRequest<JsonValue, Unit> = {
      operation: "delete",
      target: { identity: identity("orphan") },
      expectedTarget: {
        status: "present",
        identity: identity("orphan"),
        content: "À retirer",
      },
    };

    const result = await writeTranslationRequests([request], config);

    assert.equal(writeCalls, 1);
    assert.equal(result.results[0]?.status, "written");
  });

  void it("checks a source absence condition only when the request supplies one", async () => {
    const source: Unit = { id: "A", source: "Rétabli" };
    const target: Translation = { id: "A", text: "Traduction" };
    let writeCalls = 0;
    const config = configFor({
      sources: [source],
      translations: [target],
      matches: (unit, translation) => unit.id === translation.id,
      onWrite: () => {
        writeCalls += 1;
      },
    });
    const request: TranslationWriteRequest<JsonValue, Unit> = {
      operation: "delete",
      target: { identity: identity("A") },
      expectedSource: {
        presence: "absent",
        key: "A",
        range: "source.json",
      },
      expectedTarget: {
        status: "present",
        identity: identity("A"),
        content: "Traduction",
      },
    };

    const result = await writeTranslationRequests([request], config);

    assert.equal(writeCalls, 0);
    assert.equal(result.results[0]?.status, "conflict");
  });

  void it("creates a missing target from an explicitly referenced source", async () => {
    const source: Unit = { id: "new", source: "New source" };
    const records: Translation[] = [];
    let writtenSource: Unit | undefined;
    const config = configFor({
      sources: [source],
      translations: records,
      matches: (unit, translation) => unit.id === translation.id,
      onWrite: ({ request, sourceUnit }) => {
        assert.equal(request.operation, "write");
        assert.equal("sourceKey" in request.target, true);
        writtenSource = sourceUnit?.unit;
        records.push({ id: "new", text: "New source" });
      },
    });
    const request: TranslationWriteRequest<JsonValue, Unit> = {
      operation: "write",
      target: { sourceKey: "new", language: "fr" },
      content: "New source",
      expectedSource: {
        presence: "present",
        key: "new",
        range: "source.json",
        unit: source,
        content: "New source",
      },
      expectedTarget: { status: "missing" },
    };

    const result = await writeTranslationRequests([request], config);

    assert.deepEqual(writtenSource, source);
    assert.equal(result.results[0]?.status, "written");
  });

  void it("detects incompatible requests for one physical target before writing", async () => {
    const records: Translation[] = [
      { id: "A", text: "Old A" },
      { id: "B", text: "Old B" },
    ];
    let writeCalls = 0;
    const config = configFor({
      translations: records,
      locateExistingTarget: () => ({ file: "shared.json", key: "one" }),
      onWrite: () => {
        writeCalls += 1;
      },
    });
    const requests: TranslationWriteRequest<JsonValue, Unit>[] = [
      {
        operation: "write",
        target: { identity: identity("A") },
        content: "New A",
        expectedTarget: {
          status: "present",
          identity: identity("A"),
          content: "Old A",
        },
      },
      {
        operation: "write",
        target: { identity: identity("B") },
        content: "New B",
        expectedTarget: {
          status: "present",
          identity: identity("B"),
          content: "Old B",
        },
      },
    ];

    const result = await writeTranslationRequests(requests, config);

    assert.equal(writeCalls, 0);
    assert.deepEqual(
      result.results.map(({ status }) => status),
      ["conflict", "conflict"],
    );
  });

  void it("continues independent requests after a writer throws", async () => {
    const targetA: Translation = { id: "A", text: "Old A" };
    const targetB: Translation = { id: "B", text: "Old B" };
    const records = [targetA, targetB];
    const config = configFor({
      translations: records,
      onWrite: ({ request }) => {
        if (request.operation !== "write" || !("identity" in request.target))
          throw new Error("unexpected request");
        if (request.target.identity.key === "A") throw new Error("I/O failure");
        if (typeof request.content !== "string")
          throw new Error("unexpected content");
        targetB.text = request.content;
      },
    });
    const requests: TranslationWriteRequest<JsonValue, Unit>[] = [
      {
        operation: "write",
        target: { identity: identity("A") },
        content: "New A",
        expectedTarget: {
          status: "present",
          identity: identity("A"),
          content: "Old A",
        },
      },
      {
        operation: "write",
        target: { identity: identity("B") },
        content: "New B",
        expectedTarget: {
          status: "present",
          identity: identity("B"),
          content: "Old B",
        },
      },
    ];

    const result = await writeTranslationRequests(requests, config);

    assert.deepEqual(
      result.results.map(({ status }) => status),
      ["writeFailed", "written"],
    );
  });

  void it("validates the whole request batch before invoking the writer", async () => {
    let writeCalls = 0;
    const config = configFor({
      translations: [{ id: "A", text: "Old" }],
      onWrite: () => {
        writeCalls += 1;
      },
    });
    const valid: TranslationWriteRequest<JsonValue, Unit> = {
      operation: "write",
      target: { identity: identity("A") },
      content: "New",
      expectedTarget: {
        status: "present",
        identity: identity("A"),
        content: "Old",
      },
    };
    const malformed = {
      operation: "delete",
      target: { sourceKey: "A", language: "fr" },
      expectedTarget: { status: "missing" },
    };

    await assert.rejects(
      writeTranslationRequests([valid, malformed] as never, config),
      TypeError,
    );

    assert.equal(writeCalls, 0);
  });
});
