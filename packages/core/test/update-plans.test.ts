import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createUpdatePlan,
  defineConfig,
  defaultCompare,
  previewUpdate,
  readFacts,
  readComparisonSnapshot,
  replaceComparisonBaseline,
  validateUpdatePlan,
  type ComparisonBaseline,
  type ComparisonBaselineStore,
  type FrameworkConfig,
  type StandardSchemaV1,
} from "../src/index.ts";
import {
  schemaFromExamples,
  sourceSchemaFromExamples,
} from "./source-schema.ts";

type Unit = { readonly id: string; readonly source: string };
type Translation = {
  readonly targetId: string;
  readonly sourceId: string;
  readonly text: string;
};
const stringSchema = schemaFromExamples<string>("example");
type Config = FrameworkConfig<Unit, Translation, string>;

function makeConfig(
  units: readonly Unit[],
  translations: readonly Translation[],
  options: {
    readonly sourceBodyAvailability?: "available" | "unavailable";
    readonly sourceToContent?: (source: string) => string;
    readonly updatePolicy?: Config["updatePolicy"];
    readonly compare?: Config["compare"];
    readonly onQuality?: () => void;
  } = {},
): Config {
  return defineConfig<
    Unit,
    StandardSchemaV1<Unit, Unit>,
    StandardSchemaV1<Translation, Translation>,
    never,
    typeof stringSchema
  >({
    source: {
      schema: sourceSchemaFromExamples<Unit>(
        { id: "example", source: "example" },
        ...units,
      ),
      read: () => ({
        scopes: [
          {
            range: "source/messages.json",
            enumeration: "complete",
            records: units.map((value) => ({
              value,
              bodyAvailability: options.sourceBodyAvailability ?? "available",
            })),
          },
        ],
      }),
    },
    keyOf: ({ id }) => id,
    translations: {
      languages: ["fr"],
      schema: schemaFromExamples<Translation>({
        targetId: "example",
        sourceId: "example",
        text: "example",
      }),
      contentSchema: stringSchema,
      identityOf: ({ targetId }) => ({ namespace: "messages", key: targetId }),
      contentOf: ({ text }) => text,
      matches: (unit, translation) => unit.id === translation.sourceId,
      read: (_language, sourceUnits) => ({
        scopes: [
          {
            range: "locales/fr.json",
            covers: sourceUnits.map(({ key }) => key),
            enumeration: "complete",
            records: translations.map((value) => ({
              value,
              bodyAvailability: "available" as const,
            })),
          },
        ],
      }),
    },
    ...(options.sourceToContent === undefined
      ? {}
      : { sourceToContent: options.sourceToContent }),
    ...(options.compare === undefined ? {} : { compare: options.compare }),
    ...(options.updatePolicy === undefined
      ? {}
      : { updatePolicy: options.updatePolicy }),
    createQualityRequest() {
      options.onQuality?.();
      throw new Error("预览不应加载 QA 输入。");
    },
  });
}

class MemoryBaselineStore implements ComparisonBaselineStore<
  Unit,
  Translation,
  string
> {
  baseline: ComparisonBaseline<Unit, Translation, string> | undefined;
  saves = 0;

  async load() {
    return structuredClone(this.baseline);
  }

  async save(baseline: ComparisonBaseline<Unit, Translation, string>) {
    this.saves += 1;
    this.baseline = structuredClone(baseline);
  }
}

async function storedSnapshot(
  units: readonly Unit[],
  translations: readonly Translation[],
): Promise<MemoryBaselineStore> {
  const config = makeConfig(units, translations);
  const snapshot = await readComparisonSnapshot(config);
  const store = new MemoryBaselineStore();
  store.baseline = replaceComparisonBaseline({ current: snapshot });
  return store;
}

void describe("业务更新计划与预览", () => {
  void it("无基线时为充分确认的缺译生成原文占位，并只返回可恢复计划", async () => {
    const store = new MemoryBaselineStore();
    let qualityCalls = 0;
    const config = makeConfig([{ id: "welcome", source: "Welcome" }], [], {
      sourceToContent: (source) => `待译：${source}`,
      onQuality: () => {
        qualityCalls += 1;
      },
    });

    const plan = await previewUpdate(config, store);
    const item = plan.items.find(({ action }) => action === "write");

    assert.equal(plan.format, "lioni.update-plan/v1");
    assert.equal(item?.request?.operation, "write");
    assert.deepStrictEqual(item?.request, {
      operation: "write",
      target: { sourceKey: "welcome", language: "fr" },
      content: "待译：Welcome",
      expectedSource: {
        presence: "present",
        key: "welcome",
        unit: { id: "welcome", source: "Welcome" },
        content: "Welcome",
        range: "source/messages.json",
      },
      expectedTarget: { status: "missing" },
    });
    assert.equal(item?.reason.length > 0, true);
    assert.equal(qualityCalls, 0);
    assert.equal(store.saves, 0);

    const restored = JSON.parse(JSON.stringify(plan)) as unknown;
    assert.doesNotThrow(() => validateUpdatePlan(restored));
    assert.deepStrictEqual(
      (restored as typeof plan).items[0]?.request,
      item?.request,
    );
  });

  void it("原文正文不可用时默认策略不生成占位写入", async () => {
    const config = makeConfig([{ id: "welcome", source: "Welcome" }], [], {
      sourceBodyAvailability: "unavailable",
      sourceToContent: (source) => `待译：${source}`,
    });

    const plan = await previewUpdate(config);
    const item = plan.items.find(({ sourceKey }) => sourceKey === "welcome");

    assert.equal(item?.action, "blocked");
    assert.equal(item?.request, undefined);
    assert.equal(item?.after, undefined);
    assert.match(item?.reason ?? "", /原文正文不可用/);
  });

  void it("原文变化时保留已有译文，包括仍等于旧原文的正文", async () => {
    const store = await storedSnapshot(
      [{ id: "welcome", source: "Welcome" }],
      [{ targetId: "target-welcome", sourceId: "welcome", text: "Welcome" }],
    );
    const config = makeConfig(
      [{ id: "welcome", source: "Welcome back" }],
      [{ targetId: "target-welcome", sourceId: "welcome", text: "Welcome" }],
      { sourceToContent: (source) => source },
    );

    const plan = await previewUpdate(config, store);
    const item = plan.items.find(
      ({ target }) => target?.key === "target-welcome",
    );

    assert.equal(item?.action, "retain");
    assert.match(item?.reason ?? "", /保留/);
    assert.equal(item?.changes.source?.status, "modified");
    assert.equal(item?.changes.source?.previous?.unit.source, "Welcome");
    assert.equal(item?.changes.source?.current?.unit.source, "Welcome back");
  });

  void it("只为有历史关联且原文充分确认移除的未改目标规划删除", async () => {
    const store = await storedSnapshot(
      [{ id: "welcome", source: "Welcome" }],
      [{ targetId: "target-welcome", sourceId: "welcome", text: "Bienvenue" }],
    );
    const config = makeConfig(
      [],
      [{ targetId: "target-welcome", sourceId: "welcome", text: "Bienvenue" }],
    );

    const plan = await previewUpdate(config, store);
    const item = plan.items.find(
      ({ target }) => target?.key === "target-welcome",
    );

    assert.equal(item?.action, "delete");
    assert.deepStrictEqual(item?.request, {
      operation: "delete",
      target: {
        identity: {
          language: "fr",
          namespace: "messages",
          key: "target-welcome",
        },
      },
      expectedSource: {
        presence: "absent",
        key: "welcome",
        range: "source/messages.json",
      },
      expectedTarget: {
        status: "present",
        identity: {
          language: "fr",
          namespace: "messages",
          key: "target-welcome",
        },
        content: "Bienvenue",
        range: "locales/fr.json",
        record: {
          targetId: "target-welcome",
          sourceId: "welcome",
          text: "Bienvenue",
        },
      },
    });
    assert.equal(item?.changes.source?.status, "removed");
    const restored = JSON.parse(JSON.stringify(plan)) as unknown;
    assert.doesNotThrow(() => validateUpdatePlan(restored));
    assert.deepStrictEqual(
      (restored as typeof plan).items.find(
        ({ target }) => target?.key === "target-welcome",
      )?.request,
      item?.request,
    );
  });

  void it("历史原文移除后目标关联发生变化时保留目标", async () => {
    const store = await storedSnapshot(
      [{ id: "welcome", source: "Welcome" }],
      [{ targetId: "target-welcome", sourceId: "welcome", text: "Bienvenue" }],
    );
    const config = makeConfig(
      [],
      [
        {
          targetId: "target-welcome",
          sourceId: "another-source",
          text: "Bienvenue",
        },
      ],
    );

    const plan = await previewUpdate(config, store);
    const item = plan.items.find(
      ({ target }) => target?.key === "target-welcome",
    );

    assert.equal(item?.action, "retain");
    assert.match(item?.reason ?? "", /匹配|关联/);
    assert.equal(item?.request, undefined);
  });

  void it("无原文历史的目标独有项保留，并完整报告多匹配冲突", async () => {
    const config = makeConfig(
      [{ id: "welcome", source: "Welcome" }],
      [
        { targetId: "first", sourceId: "welcome", text: "一" },
        { targetId: "second", sourceId: "welcome", text: "二" },
        { targetId: "orphan", sourceId: "missing", text: "孤立项" },
      ],
      { sourceToContent: (source) => source },
    );

    const plan = await previewUpdate(config);

    const conflict = plan.items.find(({ action }) => action === "review");
    const orphan = plan.items.find(({ target }) => target?.key === "orphan");
    assert.equal(conflict?.action, "review");
    assert.match(conflict?.reason ?? "", /冲突|多条/);
    assert.equal(conflict?.changes.translations.length, 2);
    assert.equal(orphan?.action, "retain");
    assert.match(orphan?.reason ?? "", /历史|原文/);
  });

  void it("两次基线之间新增、补缺后又移除的原文不会伪造删除历史", async () => {
    const store = await storedSnapshot([], []);
    const config = makeConfig(
      [],
      [{ targetId: "new-target", sourceId: "new-source", text: "人工译文" }],
    );

    const plan = await previewUpdate(config, store);
    const item = plan.items.find(({ target }) => target?.key === "new-target");

    assert.equal(item?.action, "retain");
    assert.match(item?.reason ?? "", /没有充分的历史原文关联依据/);
    assert.equal(item?.request, undefined);
  });

  void it("不以相同身份键代替宿主提供的历史源译关联", async () => {
    const store = await storedSnapshot(
      [{ id: "same", source: "Historical source" }],
      [{ targetId: "same", sourceId: "another-source", text: "保留我" }],
    );
    const config = makeConfig(
      [],
      [{ targetId: "same", sourceId: "another-source", text: "保留我" }],
    );

    const plan = await previewUpdate(config, store);
    const item = plan.items.find(({ target }) => target?.key === "same");

    assert.equal(plan.comparisons.sourceChanges[0]?.status, "removed");
    assert.equal(item?.action, "retain");
    assert.match(item?.reason ?? "", /没有充分的历史原文关联依据/);
  });

  void it("策略一次接收整组比较与关联事实", async () => {
    let batchSize = 0;
    const config = makeConfig(
      [
        { id: "one", source: "One" },
        { id: "two", source: "Two" },
      ],
      [],
      {
        sourceToContent: (source) => source,
        updatePolicy: (input) => {
          batchSize = input.current.source.units.length;
          return input.current.associations.map((association) => {
            const sourceChange = input.comparisons.sourceChanges.find(
              ({ key }) => key === association.sourceKey,
            );
            return {
              action: "retain" as const,
              sourceKey: association.sourceKey,
              language: association.language,
              changes: {
                ...(sourceChange === undefined ? {} : { source: sourceChange }),
                translations: [],
              },
              reason: "由整组策略处理。",
            };
          });
        },
      },
    );

    const plan = await previewUpdate(config);

    assert.equal(batchSize, 2);
    assert.equal(plan.items.length, 2);
    assert.ok(plan.items.every(({ action }) => action === "retain"));
  });

  void it("可组合读取事实、显式比较与纯计划计算入口", async () => {
    const sourceToContent = (source: string) => `待译：${source}`;
    const config = makeConfig([{ id: "welcome", source: "Welcome" }], [], {
      sourceToContent,
    });
    const current = await readFacts(config);
    const comparisons = defaultCompare({
      previous: undefined,
      current: {
        version: current.version,
        source: current.source,
        translations: current.translations,
      },
    });

    const plan = await createUpdatePlan({
      current,
      comparisons,
      associations: { previous: [], current: current.associations },
      sourceToContent,
      contentSchema: stringSchema,
    });

    assert.equal(plan.items[0]?.action, "write");
    assert.equal(plan.items[0]?.request?.operation, "write");
    assert.equal(plan.items[0]?.after?.content, "待译：Welcome");
  });

  void it("预览采用配置的比较器，失败时不回退到默认比较", async () => {
    let compareCalls = 0;
    const config = makeConfig([{ id: "welcome", source: "Welcome" }], [], {
      compare(input) {
        compareCalls += 1;
        return defaultCompare(input);
      },
    });

    await previewUpdate(config);
    assert.equal(compareCalls, 1);

    const failingConfig = makeConfig(
      [{ id: "welcome", source: "Welcome" }],
      [],
      {
        compare() {
          compareCalls += 1;
          throw new Error("自定义比较失败");
        },
      },
    );
    await assert.rejects(previewUpdate(failingConfig), /自定义比较失败/);
    assert.equal(compareCalls, 2);
  });

  void it("按身份字段值读取自定义比较结果而不依赖对象属性顺序", async () => {
    const store = await storedSnapshot(
      [{ id: "welcome", source: "Welcome" }],
      [{ targetId: "target-welcome", sourceId: "welcome", text: "Bienvenue" }],
    );
    const config = makeConfig(
      [],
      [{ targetId: "target-welcome", sourceId: "welcome", text: "Bienvenue" }],
      {
        compare(input) {
          const result = defaultCompare(input);
          return {
            ...result,
            translationChanges: result.translationChanges.map((change) => ({
              ...change,
              identity: {
                key: change.identity.key,
                namespace: change.identity.namespace,
                language: change.identity.language,
              },
            })),
          };
        },
      },
    );

    const plan = await previewUpdate(config, store);
    const item = plan.items.find(
      ({ target }) => target?.key === "target-welcome",
    );

    assert.equal(item?.action, "delete");
    assert.equal(item?.changes.translations[0]?.status, "unchanged");
  });
});
