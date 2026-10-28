import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  analyzeQuality,
  defineConfig,
  readComparisonSnapshot,
  readCompletion,
  readFacts,
  type FrameworkConfig,
  type QualityConfiguration,
} from "../src/index.ts";
import { defineTestQualityCheck } from "./quality-check-fixture.ts";
import {
  fixtureTranslationIdentity,
  schemaFromExamples,
  sourceSchemaFromExamples,
} from "./source-schema.ts";

type Unit = { readonly key: string; readonly source: string };
type Translation = { readonly key: string; readonly text: string };

function fixture(
  prepare?: QualityConfiguration<Unit, Translation, string>["prepare"],
) {
  const reads: string[] = [];
  const unit: Unit = { key: "save", source: "Save" };
  const config: FrameworkConfig<Unit, Translation, string> = defineConfig({
    source: {
      schema: sourceSchemaFromExamples(unit),
      read() {
        reads.push("source");
        return {
          scopes: [
            {
              range: "source",
              enumeration: "complete" as const,
              records: [
                { value: unit, bodyAvailability: "available" as const },
              ],
            },
          ],
        };
      },
    },
    keyOf: ({ key }) => key,
    translations: {
      languages: ["fr", "de", "ja"],
      schema: schemaFromExamples<Translation>({ key: "save", text: "" }),
      contentSchema: schemaFromExamples(""),
      identityOf: fixtureTranslationIdentity,
      contentOf: ({ text }) => text,
      matches: (source, translation) => source.key === translation.key,
      read(language, sourceUnits) {
        assert.equal(this, config.translations);
        reads.push(language);
        return {
          scopes: [
            {
              range: language,
              covers: sourceUnits.map(({ key }) => key),
              enumeration: "complete" as const,
              records:
                language === "de"
                  ? []
                  : [
                      {
                        value: { key: "save", text: `save-${language}` },
                        bodyAvailability: "available" as const,
                      },
                    ],
            },
          ],
        };
      },
    },
    completion: {
      criterion: "存在译文",
      resolveCompletion: ({ translations }) => translations.length > 0,
    },
    ...(prepare === undefined ? {} : { quality: { prepare } }),
  });
  return { config, reads };
}

void describe("本次执行的语言范围", () => {
  void it("仅读取选中语言，去重后按配置顺序执行，并保留 adapter 的 this", async () => {
    const { config, reads } = fixture();
    const facts = await readFacts(config, { languages: ["ja", "fr", "ja"] });
    assert.deepStrictEqual(reads, ["source", "fr", "ja"]);
    assert.deepStrictEqual(
      facts.translations.reads.map(({ language }) => language),
      ["fr", "ja"],
    );
    assert.deepStrictEqual(
      facts.associations.map(({ language, translationIndexes }) => ({
        language,
        translationIndexes,
      })),
      [
        { language: "fr", translationIndexes: [0] },
        { language: "ja", translationIndexes: [1] },
      ],
    );
    assert.deepStrictEqual(config.translations?.languages, ["fr", "de", "ja"]);

    reads.length = 0;
    const all = await readComparisonSnapshot(config);
    assert.deepStrictEqual(reads, ["source", "fr", "de", "ja"]);
    assert.equal(all.translations.reads.length, 3);

    reads.length = 0;
    const selected = await readComparisonSnapshot(config, {
      languages: ["ja"],
    });
    assert.deepStrictEqual(reads, ["source", "ja"]);
    assert.equal(selected.translations.records[0]?.identity.language, "ja");
  });

  void it("完成度只覆盖选中语言，空资源仍产生待译义务", async () => {
    const { config, reads } = fixture();
    const result = await readCompletion(config, { languages: ["de"] });
    assert.deepStrictEqual(reads, ["source", "de"]);
    assert.deepStrictEqual(result.completion.scope.targetLanguages, ["de"]);
    assert.equal(result.completion.scope.obligationCount, 1);
    assert.equal(result.completion.confirmedIncompleteCount, 1);
    assert.equal(result.completion.completionRate, 0);
  });

  void it("无效范围在读取源译资源前失败", async () => {
    for (const run of [
      readFacts,
      readComparisonSnapshot,
      readCompletion,
      analyzeQuality,
    ]) {
      for (const languages of [[], ["es"], ["fr", "es"]]) {
        const { config, reads } = fixture();
        await assert.rejects(run(config, { languages }), {
          name: "TypeError",
          message:
            languages.length === 0
              ? "本次执行的 languages 必须是非空语言列表。"
              : '目标语言 "es" 未在配置中声明。',
        });
        assert.deepStrictEqual(reads, []);
      }
    }
  });

  void it("QA 准备与检查都只收到本次语言，默认候选使用相同范围", async () => {
    const preparedLanguages: string[][] = [];
    const checkedLanguages: string[] = [];
    const { config, reads } = fixture((facts) => {
      preparedLanguages.push(
        facts.translations.reads.map(({ language }) => language),
      );
      return {
        checks: [
          defineTestQualityCheck<Unit, Translation, string>({
            id: "language-observer",
            configuration: {},
            check({ candidate }) {
              checkedLanguages.push(candidate.language);
              return {
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
              };
            },
          }),
        ],
      };
    });
    const result = await analyzeQuality(config, { languages: ["ja"] });
    assert.deepStrictEqual(reads, ["source", "ja"]);
    assert.deepStrictEqual(preparedLanguages, [["ja"]]);
    assert.deepStrictEqual(checkedLanguages, ["ja"]);
    assert.deepStrictEqual(
      result.candidates.map(({ language }) => language),
      ["ja"],
    );
    assert.deepStrictEqual(
      result.factCoverage.translations.map(({ language }) => language),
      ["ja"],
    );
  });

  void it("显式范围拒绝调用方或宿主准备的越界候选，省略范围保留外部候选支持", async () => {
    const outside = { sourceKey: "save", language: "ja", content: "保存" };
    const explicit = fixture();
    await assert.rejects(
      analyzeQuality(explicit.config, {
        languages: ["fr"],
        candidates: [outside],
      }),
      /译文候选语言 "ja" 不在本次执行范围内/,
    );

    const prepared = fixture(() => ({
      checks: [],
      request: { candidates: [outside], dependencies: {} },
    }));
    await assert.rejects(
      analyzeQuality(prepared.config, { languages: ["fr"] }),
      /译文候选语言 "ja" 不在本次执行范围内/,
    );
    const accepted = await analyzeQuality(explicit.config, {
      languages: ["ja"],
      candidates: [outside],
    });
    assert.deepStrictEqual(accepted.candidates, [outside]);

    const external = { ...outside, language: "es" };
    const unscoped = await analyzeQuality(explicit.config, {
      candidates: [external],
    });
    assert.deepStrictEqual(unscoped.candidates, [external]);
  });
});
