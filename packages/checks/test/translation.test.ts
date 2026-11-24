import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  defineConfig,
  runQa,
  update,
  type BodyAvailability,
  type JsonValue,
} from "@lioni/core";
import { z } from "zod";

import {
  createMissingTranslationChecker,
  createSameTextChecker,
} from "../src/index.ts";

type Unit = { readonly key: string; readonly source: JsonValue };
type Translation = { readonly key: string; readonly text: JsonValue };
type Unavailable = { readonly key: string; readonly reason: string };

const jsonValueSchema: z.ZodType<JsonValue, JsonValue> = z.json();
const sourceSchema: z.ZodType<Unit, Unit> = z.object({
  key: z.string(),
  source: jsonValueSchema,
});
const translationSchema: z.ZodType<Translation, Translation> = z.object({
  key: z.string(),
  text: jsonValueSchema,
});
const unavailableSchema: z.ZodType<Unavailable, Unavailable> = z.object({
  key: z.string(),
  reason: z.string(),
});

type TestConfigOptions = {
  readonly source?: readonly {
    readonly key: string;
    readonly source: JsonValue;
    readonly bodyAvailability?: BodyAvailability;
  }[];
  readonly target?: readonly {
    readonly key: string;
    readonly text?: JsonValue;
    readonly bodyAvailability?: BodyAvailability;
  }[];
  readonly sourceRange?: string;
  readonly targetRange?: string;
  readonly checks?: readonly (
    | ReturnType<
        typeof createMissingTranslationChecker<
          Unit,
          Translation,
          JsonValue,
          Unavailable
        >
      >
    | ReturnType<
        typeof createSameTextChecker<Unit, Translation, JsonValue, Unavailable>
      >
  )[];
};

function createTestConfig(options: TestConfigOptions) {
  const sourceRecords = options.source ?? [
    { key: "greeting", source: "Hello" },
  ];
  const targetRecords = options.target ?? [];
  const sourceRange = options.sourceRange ?? "source.json";
  const targetRange = options.targetRange ?? "fr.json";
  return defineConfig({
    source: {
      schema: sourceSchema,
      read: () => ({
        scopes: [
          {
            range: sourceRange,
            enumeration: "complete",
            records: sourceRecords.map(
              ({ key, source, bodyAvailability = "available" }) => ({
                value: { key, source },
                bodyAvailability,
              }),
            ),
          },
        ],
      }),
    },
    keyOf: ({ key }) => key,
    translations: {
      languages: ["fr"],
      schema: translationSchema,
      unavailableSchema,
      contentSchema: jsonValueSchema,
      keyOf: ({ key }) => key,
      contentOf: ({ text }) => text,
      read: (_language, units) => ({
        scopes: [
          {
            range: targetRange,
            enumeration: "complete",
            covers: units.map(({ key }) => key),
            records: targetRecords.map(
              ({ key, text, bodyAvailability = "available" }) =>
                bodyAvailability === "available"
                  ? {
                      value: { key, text: text ?? "" },
                      bodyAvailability: "available" as const,
                    }
                  : {
                      value: { key, reason: "unreadable" },
                      bodyAvailability: "unavailable" as const,
                    },
            ),
          },
        ],
      }),
    },
    quality: {
      checks: options.checks ?? [
        createMissingTranslationChecker(),
        createSameTextChecker(),
      ],
    },
  });
}

void describe("缺译检查（missing-translation）", () => {
  void it("对已确认缺译发出错误诊断，可读空字符串、同文与首次草稿均通过", async () => {
    const missing = await runQa(
      createTestConfig({
        target: [],
        checks: [createMissingTranslationChecker()],
      }),
    );
    assert.equal(missing.diagnostics.length, 1);
    assert.deepEqual(missing.diagnostics[0], {
      checkId: "missing-translation",
      executionId: 0,
      severity: "error",
      object: { kind: "translation-unit", key: "greeting", language: "fr" },
      location: { key: "greeting", language: "fr", range: null },
      message: "尚未提供译文。",
      evidence: [],
      handling: { status: "active" },
    });

    for (const content of [
      "Bonjour",
      "",
      "Hello",
      { text: "Salut" },
    ] as const) {
      const saved = await runQa(
        createTestConfig({
          target: [{ key: "greeting", text: content }],
          checks: [createMissingTranslationChecker()],
        }),
      );
      assert.deepEqual(saved.diagnostics, []);

      const draft = await runQa(
        createTestConfig({
          target: [],
          checks: [createMissingTranslationChecker()],
        }),
        {
          candidates: [{ sourceKey: "greeting", language: "fr", content }],
        },
      );
      assert.deepEqual(draft.diagnostics, []);
    }
  });

  void it("已有记录但正文不可用时拒绝缺译判断，显式提供草稿时仍可通过", async () => {
    const config = createTestConfig({
      target: [{ key: "greeting", bodyAvailability: "unavailable" }],
      checks: [createMissingTranslationChecker()],
    });

    await assert.rejects(runQa(config), /缺少可靠的译文读取依据/u);

    const draft = await runQa(config, {
      candidates: [{ sourceKey: "greeting", language: "fr", content: "Salut" }],
    });
    assert.deepEqual(draft.diagnostics, []);
  });

  void it("读取范围不完整时非草稿运行拒绝调用，显式送检草稿仍可通过缺译检查", async () => {
    const partialConfig = defineConfig({
      source: {
        schema: sourceSchema,
        read: () => ({
          scopes: [
            {
              range: "source.json",
              enumeration: "complete",
              records: [
                {
                  value: { key: "greeting", source: "Hello" },
                  bodyAvailability: "available",
                },
              ],
            },
          ],
        }),
      },
      keyOf: ({ key }) => key,
      translations: {
        languages: ["fr"],
        schema: translationSchema,
        contentSchema: jsonValueSchema,
        keyOf: ({ key }) => key,
        contentOf: ({ text }) => text,
        read: (_language, units) => ({
          scopes: [
            {
              range: "fr.json",
              enumeration: "partial",
              covers: units.map(({ key }) => key),
              records: [],
            },
          ],
        }),
      },
      quality: {
        checks: [createMissingTranslationChecker(), createSameTextChecker()],
      },
    });

    await assert.rejects(runQa(partialConfig), /读取不完整/u);

    const draftOk = await runQa(partialConfig, {
      candidates: [{ sourceKey: "greeting", language: "fr", content: "" }],
    });
    assert.deepEqual(draftOk.diagnostics, []);

    const draftSame = await runQa(partialConfig, {
      candidates: [{ sourceKey: "greeting", language: "fr", content: "Hello" }],
    });
    assert.equal(draftSame.diagnostics.length, 1);
    assert.equal(draftSame.diagnostics[0]?.checkId, "same-text");
    assert.deepEqual(draftSame.diagnostics[0]?.location, {
      key: "greeting",
      language: "fr",
      range: null,
    });
  });
});

void describe("同文检查（same-text）", () => {
  void it("确认缺译时不额外产生同文诊断，原文或译文不可读及非字符串正文必须抛错", async () => {
    const missing = await runQa(
      createTestConfig({
        target: [],
        checks: [createSameTextChecker()],
      }),
    );
    assert.deepEqual(missing.diagnostics, []);

    await assert.rejects(
      runQa(
        createTestConfig({
          target: [{ key: "greeting", bodyAvailability: "unavailable" }],
          checks: [createSameTextChecker()],
        }),
      ),
      /无法读取候选正文以检查同文/u,
    );

    await assert.rejects(
      runQa(
        createTestConfig({
          source: [
            {
              key: "greeting",
              source: "Hello",
              bodyAvailability: "unavailable",
            },
          ],
          target: [{ key: "greeting", text: "Hello" }],
          checks: [createSameTextChecker()],
        }),
      ),
      /无法读取原文正文以检查同文/u,
    );

    for (const [source, target] of [
      [{ text: "Hello" }, "Hello"],
      ["Hello", { text: "Hello" }],
      [null, "Hello"],
      ["Hello", 123],
    ] as const) {
      await assert.rejects(
        runQa(
          createTestConfig({
            source: [{ key: "greeting", source }],
            target: [{ key: "greeting", text: target }],
            checks: [createSameTextChecker()],
          }),
        ),
        /字符串正文/u,
      );
    }
  });

  void it("精确比较字符串原文与候选，发出诊断时保留目标位置与原文证据范围", async () => {
    const matched = await runQa(
      createTestConfig({
        source: [{ key: "brand", source: "Lioni" }],
        target: [{ key: "brand", text: "Lioni" }],
        sourceRange: "en/common.json",
        targetRange: "fr/common.json",
        checks: [createSameTextChecker()],
      }),
    );
    assert.equal(matched.diagnostics.length, 1);
    const diagnostic = matched.diagnostics[0]!;
    assert.equal(diagnostic.checkId, "same-text");
    assert.equal(diagnostic.severity, "error");
    assert.deepEqual(diagnostic.object, {
      kind: "translation-unit",
      key: "brand",
      language: "fr",
    });
    assert.deepEqual(diagnostic.location, {
      key: "brand",
      language: "fr",
      range: "fr/common.json",
    });
    assert.deepEqual(diagnostic.evidence, [
      {
        role: "source",
        object: { kind: "source-unit", key: "brand" },
        location: { language: null, range: "en/common.json", key: "brand" },
        value: "Lioni",
      },
      {
        role: "target",
        object: { kind: "translation-unit", key: "brand", language: "fr" },
        location: { key: "brand", language: "fr", range: "fr/common.json" },
        value: "Lioni",
      },
    ]);

    // 首次草稿无现存译文时目标 range 为 null，原文证据仍保留原文范围。
    const firstDraft = await runQa(
      createTestConfig({
        source: [{ key: "brand", source: "Lioni" }],
        target: [],
        sourceRange: "en/common.json",
        checks: [createSameTextChecker()],
      }),
      {
        candidates: [{ sourceKey: "brand", language: "fr", content: "Lioni" }],
      },
    );
    assert.equal(firstDraft.diagnostics.length, 1);
    assert.deepEqual(firstDraft.diagnostics[0]?.location, {
      key: "brand",
      language: "fr",
      range: null,
    });
    assert.deepEqual(firstDraft.diagnostics[0]?.evidence[0]?.location, {
      language: null,
      range: "en/common.json",
      key: "brand",
    });

    // 空字符串对空字符串精确相等；与非空原文、大小写、空格和 Unicode 表示差异均不等。
    const bothEmpty = await runQa(
      createTestConfig({
        source: [{ key: "empty", source: "" }],
        target: [{ key: "empty", text: "" }],
        checks: [createSameTextChecker()],
      }),
    );
    assert.equal(bothEmpty.diagnostics.length, 1);

    for (const [source, target] of [
      ["Hello", ""],
      ["Open", "open"],
      ["Open", "Open "],
      ["caf\u00e9", "cafe\u0301"],
    ] as const) {
      const different = await runQa(
        createTestConfig({
          source: [{ key: "msg", source }],
          target: [{ key: "msg", text: target }],
          checks: [createSameTextChecker()],
        }),
      );
      assert.deepEqual(different.diagnostics, []);
    }
  });
});

void describe("独立启用两项规则与同步占位转换", () => {
  void it("支持分别独立开关规则，经正式同步补入原文占位后由缺译转为同文", async () => {
    const store = new Map<string, string>([["brand", "Lioni"]]);
    const config = defineConfig({
      source: {
        schema: sourceSchema,
        read: () => ({
          scopes: [
            {
              range: "source.json",
              enumeration: "complete",
              records: [
                {
                  value: { key: "button", source: "Open" },
                  bodyAvailability: "available",
                },
                {
                  value: { key: "brand", source: "Lioni" },
                  bodyAvailability: "available",
                },
              ],
            },
          ],
        }),
      },
      keyOf: ({ key }) => key,
      translations: {
        languages: ["fr"],
        schema: translationSchema,
        contentSchema: jsonValueSchema,
        keyOf: ({ key }) => key,
        contentOf: ({ text }) => text,
        read: (_language, units) => ({
          scopes: [
            {
              range: "fr.json",
              enumeration: "complete",
              covers: units.map(({ key }) => key),
              records: [...store.entries()].map(([key, text]) => ({
                value: { key, text },
                bodyAvailability: "available" as const,
              })),
            },
          ],
        }),
      },
      translationWriteback: {
        locateNewTarget: ({ sourceKey }) => ({
          status: "located",
          locator: sourceKey,
        }),
        locateExistingTarget: ({ identity }) => ({
          status: "located",
          locator: identity.key,
        }),
        write: ({ request, target }) => {
          if (typeof target.locator !== "string")
            throw new Error("译文键不可用。");
          if (request.operation === "delete") {
            store.delete(target.locator);
            return;
          }
          if (typeof request.content !== "string")
            throw new Error("占位正文必须是字符串。");
          store.set(target.locator, request.content);
        },
      },
      quality: {
        checks: [createMissingTranslationChecker(), createSameTextChecker()],
      },
    });

    const onlyMissing = await runQa(config, {
      checkIds: ["missing-translation"],
    });
    assert.deepEqual(
      onlyMissing.diagnostics.map(({ checkId, object }) => [
        checkId,
        object.key,
      ]),
      [["missing-translation", "button"]],
    );

    const onlySameText = await runQa(config, { checkIds: ["same-text"] });
    assert.deepEqual(
      onlySameText.diagnostics.map(({ checkId, object }) => [
        checkId,
        object.key,
      ]),
      [["same-text", "brand"]],
    );

    const beforeUpdate = await runQa(config);
    assert.deepEqual(
      beforeUpdate.diagnostics.map(({ checkId, object }) => [
        checkId,
        object.key,
      ]),
      [
        ["missing-translation", "button"],
        ["same-text", "brand"],
      ],
    );

    await update(config);
    assert.equal(store.get("button"), "Open");

    const afterUpdate = await runQa(config);
    assert.deepEqual(
      afterUpdate.diagnostics
        .map(({ checkId, object }) => [checkId, object.key])
        .sort((left, right) => left[1]!.localeCompare(right[1]!)),
      [
        ["same-text", "brand"],
        ["same-text", "button"],
      ],
    );
  });
});
