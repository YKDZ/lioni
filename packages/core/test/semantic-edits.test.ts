import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  StandardSchemaContractError,
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
type Translation = { id: string; text: string; sourceId?: string };
type WriteInput = Parameters<
  NonNullable<TranslationWritebackAdapter<Unit, Translation>["write"]>
>[0];
type BatchWriteInput = Parameters<
  NonNullable<TranslationWritebackAdapter<Unit, Translation>["writeBatch"]>
>[0];

function identity(id: string): TranslationIdentity {
  return { language: "fr", namespace: "messages", key: id };
}

function configFor(options: {
  readonly sources?: readonly Unit[];
  readonly sourceBodyAvailability?: "available" | "unavailable";
  readonly translations: Translation[];
  readonly matches?: (unit: Unit, translation: Translation) => boolean;
  readonly locateExistingTarget?: (identity: TranslationIdentity) => JsonValue;
  readonly locateNewTarget?: (unit: Unit, language: string) => JsonValue;
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
              bodyAvailability: options.sourceBodyAvailability ?? "available",
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
      keyOf: (translation) => ({
        namespace: "messages",
        key: translation.id,
      }),
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
        locator: options.locateExistingTarget?.(targetIdentity) ?? {
          file: "fr.json",
          key: targetIdentity.key,
        },
      }),
      locateNewTarget: ({ sourceUnit, language }) => ({
        status: "located",
        locator: options.locateNewTarget?.(sourceUnit.unit, language) ?? {
          file: `${language}.json`,
          key: sourceUnit.key,
        },
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

  void it("does not read or validate source data for an identity-only request", async () => {
    const target: Translation = { id: "A", text: "Ancien" };
    let writeCalls = 0;
    let sourceReadCalls = 0;
    const config = configFor({
      translations: [target],
      onWrite: ({ request }) => {
        writeCalls += 1;
        if (request.operation === "write")
          target.text = request.content as string;
      },
    });
    const brokenSource = config.source as unknown as {
      schema: unknown;
      read: () => never;
    };
    brokenSource.read = () => {
      sourceReadCalls += 1;
      throw new Error("source adapter should not run");
    };
    brokenSource.schema = null;
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

    assert.equal(sourceReadCalls, 0);
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

  void it("rejects a saved target request when the original target record changed", async () => {
    const target: Translation = { id: "A", text: "Actuel", sourceId: "B" };
    let writeCalls = 0;
    const config = configFor({
      translations: [target],
      onWrite: () => {
        writeCalls += 1;
      },
    });
    const request: TranslationWriteRequest<JsonValue, Unit> = {
      operation: "delete",
      target: { identity: identity("A") },
      expectedTarget: {
        status: "present",
        identity: identity("A"),
        content: "Actuel",
        range: "fr.json",
        record: { id: "A", text: "Actuel", sourceId: "A" },
      },
    };

    const result = await writeTranslationRequests([request], config);

    assert.equal(writeCalls, 0);
    assert.equal(result.results[0]?.status, "conflict");
    assert.match(result.results[0]?.reason ?? "", /记录已变化/);
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

  void it("writes an external candidate when source identity is known but its body is unavailable", async () => {
    const source: Unit = { id: "new", source: "unavailable source body" };
    const records: Translation[] = [];
    let writeCalls = 0;
    const config = configFor({
      sources: [source],
      sourceBodyAvailability: "unavailable",
      translations: records,
      matches: (unit, translation) => unit.id === translation.id,
      locateNewTarget: (unit, language) => ({ id: unit.id, language }),
      onWrite: ({ request, sourceUnit }) => {
        writeCalls += 1;
        assert.equal(request.operation, "write");
        assert.equal(sourceUnit?.unit.id, "new");
        if (
          request.operation === "write" &&
          typeof request.content === "string"
        )
          records.push({ id: "new", text: request.content });
      },
    });
    const request: TranslationWriteRequest<JsonValue, Unit> = {
      operation: "write",
      target: { sourceKey: "new", language: "fr" },
      content: "人工候选译文",
      expectedTarget: { status: "missing" },
    };
    const explicitSourceRequest: TranslationWriteRequest<JsonValue, Unit> = {
      ...request,
      expectedSource: {
        presence: "present",
        key: "new",
        range: "source.json",
        unit: source,
        content: source.source,
      },
    };

    const sourceDependent = await writeTranslationRequests(
      [explicitSourceRequest],
      config,
    );
    assert.equal(sourceDependent.results[0]?.status, "notWritable");
    assert.equal(writeCalls, 0);

    const externalCandidate = await writeTranslationRequests([request], config);
    assert.equal(externalCandidate.results[0]?.status, "written");
    assert.equal(writeCalls, 1);
    assert.deepEqual(records, [{ id: "new", text: "人工候选译文" }]);
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

    let batchWrites = 0;
    const batchConfig = {
      ...config,
      translationWriteback: {
        ...config.translationWriteback!,
        writeBatch() {
          batchWrites += 1;
        },
      },
    };
    const batchResult = await writeTranslationRequests(requests, batchConfig);

    assert.equal(batchWrites, 0);
    assert.deepEqual(
      batchResult.results.map(({ status }) => status),
      ["conflict", "conflict"],
    );
  });

  void it("按同一快照预检批次并在写入后逐项确认结果", async () => {
    const targetA: Translation = { id: "A", text: "Old A" };
    const targetB: Translation = { id: "B", text: "Old B" };
    const config = configFor({
      translations: [targetA, targetB],
      onWrite: () => {
        throw new Error("the batch writer should be used");
      },
    });
    const batchConfig = {
      ...config,
      translationWriteback: {
        ...config.translationWriteback!,
        writeBatch: ({ requests }: BatchWriteInput) => {
          assert.equal(requests.length, 2);
          assert.deepEqual(
            requests.map(
              ({ currentTranslation }) => currentTranslation?.content,
            ),
            ["Old A", "Old B"],
          );
          targetA.text = "New A";
          targetB.text = "New B";
        },
      },
    };
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

    const result = await writeTranslationRequests(requests, batchConfig);

    assert.deepEqual(
      result.results.map(({ status }) => status),
      ["written", "written"],
    );
  });

  void it("兼容的重复物理目标只应用一次", async () => {
    const records: Translation[] = [];
    const config = configFor({
      sources: [{ id: "A", source: "Source A" }],
      translations: records,
      matches: (unit, translation) => unit.id === translation.id,
      onWrite: () => {
        throw new Error("the batch writer should be used");
      },
    });
    const batchConfig = {
      ...config,
      translationWriteback: {
        ...config.translationWriteback!,
        writeBatch({ requests }: BatchWriteInput) {
          for (const { request } of requests) {
            const target = request.target;
            if (request.operation !== "write" || !("sourceKey" in target))
              throw new Error("unexpected request");
            if (records.some(({ id }) => id === target.sourceKey))
              throw new Error("new target was sent more than once");
            if (typeof request.content !== "string")
              throw new Error("unexpected body");
            records.push({
              id: target.sourceKey,
              text: request.content,
            });
          }
        },
      },
    };
    const request: TranslationWriteRequest<JsonValue, Unit> = {
      operation: "write",
      target: { sourceKey: "A", language: "fr" },
      content: "New A",
      expectedTarget: { status: "missing" },
    };

    const result = await writeTranslationRequests(
      [request, request],
      batchConfig,
    );

    assert.deepEqual(
      result.results.map(({ status }) => status),
      ["written", "written"],
    );
    assert.equal(Object.hasOwn(result, "batchError"), false);
  });

  void it("保留已确认的部分成功结果和原始批次异常", async () => {
    const failure = new StandardSchemaContractError(
      "host batch",
      "invalid-schema-result",
      "shared file could not be saved",
    );
    const targetA: Translation = { id: "A", text: "Old A" };
    const targetB: Translation = { id: "B", text: "Old B" };
    const config = configFor({
      translations: [targetA, targetB],
      onWrite: () => {
        throw new Error("the batch writer should be used");
      },
    });
    const batchConfig = {
      ...config,
      translationWriteback: {
        ...config.translationWriteback!,
        writeBatch: () => {
          targetA.text = "New A";
          throw failure;
        },
      },
    };
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

    const result = await writeTranslationRequests(requests, batchConfig);

    assert.deepEqual(
      result.results.map(({ status }) => status),
      ["written", "writeFailed"],
    );
    assert.equal(result.batchError, failure);
  });

  void it("写入后读取不完整时将失败批次项保留为未确认", async () => {
    const failure = new Error("batch write failed");
    const target: Translation = { id: "A", text: "Old" };
    const base = configFor({
      translations: [target],
      onWrite: () => {
        throw new Error("the batch writer should be used");
      },
    });
    let batchFailed = false;
    type SourceUnits = Parameters<
      NonNullable<typeof base.translations>["read"]
    >[1];
    const config = {
      ...base,
      translations: {
        ...base.translations!,
        read(language: string, sourceUnits: SourceUnits) {
          if (batchFailed)
            return {
              scopes: [
                {
                  range: `${language}.json`,
                  covers: [],
                  enumeration: "partial" as const,
                  records: [],
                },
              ],
            };
          return base.translations!.read(language, sourceUnits);
        },
      },
      translationWriteback: {
        ...base.translationWriteback!,
        writeBatch() {
          batchFailed = true;
          throw failure;
        },
      },
    };
    const request: TranslationWriteRequest<JsonValue, Unit> = {
      operation: "write",
      target: { identity: identity("A") },
      content: "New",
      expectedTarget: {
        status: "present",
        identity: identity("A"),
        content: "Old",
      },
    };

    const result = await writeTranslationRequests([request], config);

    assert.equal(result.results[0]?.status, "writeUnconfirmed");
    assert.equal(result.batchError, failure);
  });

  void it("写入后架构验证失败时保留批次异常和未确认项", async () => {
    const failure = new Error("batch writer failed");
    const readFailure = new StandardSchemaContractError(
      "host translations",
      "invalid-schema-result",
      "post-write records are malformed",
    );
    const target: Translation = { id: "A", text: "Old" };
    const base = configFor({
      translations: [target],
      onWrite: () => {
        throw new Error("the batch writer should be used");
      },
    });
    let batchFailed = false;
    type SourceUnits = Parameters<
      NonNullable<typeof base.translations>["read"]
    >[1];
    const config = {
      ...base,
      translations: {
        ...base.translations!,
        read(language: string, sourceUnits: SourceUnits) {
          if (batchFailed) throw readFailure;
          return base.translations!.read(language, sourceUnits);
        },
      },
      translationWriteback: {
        ...base.translationWriteback!,
        writeBatch() {
          batchFailed = true;
          target.text = "New";
          throw failure;
        },
      },
    };
    const request: TranslationWriteRequest<JsonValue, Unit> = {
      operation: "write",
      target: { identity: identity("A") },
      content: "New",
      expectedTarget: {
        status: "present",
        identity: identity("A"),
        content: "Old",
      },
    };

    const result = await writeTranslationRequests([request], config);

    assert.equal(result.results[0]?.status, "writeUnconfirmed");
    assert.match(
      result.results[0]?.reason ?? "",
      /post-write records are malformed/u,
    );
    assert.equal(result.batchError, failure);
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
