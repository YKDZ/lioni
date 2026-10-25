import assert from "node:assert/strict";
import { readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createMessageFamilyChecker, createTermChecker } from "@lioni/checks";
import type {
  MessageFamilyInput,
  MessageFamilyProjection,
} from "@lioni/checks";
import {
  analyzeQuality,
  applySemanticEdits,
  bindQualityCheck,
  defineConfig,
  prepareQualityConditionedSemanticEdit,
} from "@lioni/core";
import type {
  QualityCheckOutcome,
  QualityCheckProjectionInput,
  QualityCheckRuleInput,
  QualityCheckSelection,
  QualityObject,
  QualityException,
  SourceUnitFact,
  StandardSchemaV1,
  TranslationUnitInput,
} from "@lioni/core";
import { createMemoScope } from "@lioni/memo";
import {
  compileTerms,
  createTermbase,
  rejectForbiddenTranslation,
  requireAllowedTranslation,
  termComparisonInputSchema,
  termRulesConfigurationSchema,
} from "@lioni/terminology";
import type { TermComparisonInput } from "@lioni/terminology";
import {
  braceVariables,
  createTextAnalysis,
  segmentWords,
} from "@lioni/text-analysis";
import type { TemplateOptions, TextInput } from "@lioni/text-analysis";

const hostRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const locales = ["zh-CN", "zh-TW", "ja"] as const;
const mainTermKey = "Save";
const partialKey = "qa.control.partial.primary";
const familyPrimaryKey = "qa.control.family.primary";
const sourcePath = path.join(hostRoot, "src/lang/en.json");
const targetPath = path.join(hostRoot, "src/lang/zh-CN.json");
const partialKeys = new Set<string>();
let exceptions: readonly QualityException[] = [];

type Locale = (typeof locales)[number];
type SourceBody = {
  readonly text: string;
  readonly context: {
    readonly resource: "src/lang/en.json";
    readonly key: string;
    readonly kind: "uptime-kuma-locale" | "controlled-message";
  };
};
type TranslationBody = {
  readonly text: string;
  readonly language: string;
  readonly resourceKey: string;
};
type Unit = TranslationUnitInput & {
  readonly key: string;
  readonly source: SourceBody;
};
type Translation = {
  readonly key: string;
  readonly text: string;
  readonly language: string;
};
type Subject = {
  readonly sourceUnit: SourceUnitFact<Unit>;
  readonly sourceKey: string;
  readonly language: string;
  readonly sourceText: string;
  readonly content: TranslationBody;
};

const objectSchema = <T>(
  vendor: string,
  validate: (value: unknown) => value is T,
): StandardSchemaV1<T, T> => ({
  "~standard": {
    version: 1,
    vendor,
    validate(value) {
      return validate(value)
        ? { value }
        : { issues: [{ message: "宿主 QA 输入结构无效。" }] };
    },
  },
});

const sourceSchema = objectSchema<Unit>(
  "uptime-kuma-lioni-qa",
  (value): value is Unit =>
    isRecord(value) &&
    typeof value.key === "string" &&
    isRecord(value.source) &&
    typeof value.source.text === "string" &&
    isRecord(value.source.context) &&
    typeof value.source.context.key === "string" &&
    value.source.context.resource === "src/lang/en.json",
);
const translationSchema = objectSchema<Translation>(
  "uptime-kuma-lioni-qa",
  (value): value is Translation =>
    isRecord(value) &&
    typeof value.key === "string" &&
    typeof value.text === "string" &&
    typeof value.language === "string",
);
const contentSchema = objectSchema<TranslationBody>(
  "uptime-kuma-lioni-qa",
  (value): value is TranslationBody =>
    isRecord(value) &&
    typeof value.text === "string" &&
    typeof value.language === "string" &&
    typeof value.resourceKey === "string",
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readLocale(language: string): Promise<Record<string, string>> {
  const file = path.join(hostRoot, "src/lang", `${language}.json`);
  const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
  assert.ok(isRecord(parsed), `${file} 必须是 JSON 对象。`);
  for (const [key, value] of Object.entries(parsed))
    assert.equal(typeof value, "string", `${language}.${key} 必须是字符串。`);
  return parsed as Record<string, string>;
}

function body(
  text: string,
  language: string,
  resourceKey: string,
): TranslationBody {
  return { text, language, resourceKey };
}

function sourceUnit(key: string, text: string, controlled = false): Unit {
  return {
    key,
    source: {
      text,
      context: {
        resource: "src/lang/en.json",
        key,
        kind: controlled ? "controlled-message" : "uptime-kuma-locale",
      },
    },
  };
}

function readSourceUnits(source: Record<string, string>): Unit[] {
  return Object.entries(source)
    .filter(([, text]) => text.trim().length > 0)
    .map(([key, text]) => sourceUnit(key, text, key.startsWith("qa.control.")));
}

const termbase = createTermbase({
  concepts: [
    {
      id: "save-action",
      languages: [
        {
          language: "en",
          expressions: [{ id: "en-save", text: "Save", usage: "preferred" }],
        },
        {
          language: "zh-CN",
          expressions: [
            { id: "cn-save", text: "保存", usage: "preferred" },
            { id: "cn-save-allowed", text: "存盘", usage: "allowed" },
            {
              id: "cn-save-forbidden",
              text: "错误保存",
              usage: "forbidden",
            },
          ],
        },
        {
          language: "zh-TW",
          expressions: [
            { id: "tw-save", text: "儲存", usage: "preferred" },
            { id: "tw-save-allowed", text: "存檔", usage: "allowed" },
            {
              id: "tw-save-forbidden",
              text: "錯誤儲存",
              usage: "forbidden",
            },
          ],
        },
        {
          language: "ja",
          expressions: [
            { id: "ja-save", text: "保存", usage: "preferred" },
            { id: "ja-save-allowed", text: "セーブ", usage: "allowed" },
            {
              id: "ja-save-forbidden",
              text: "誤保存",
              usage: "forbidden",
            },
          ],
        },
      ],
    },
  ],
});

function templateOptions(): TemplateOptions {
  return {
    abstract: (token) =>
      token.kind === "variable" && token.identity !== undefined
        ? { kind: token.kind, identity: token.identity }
        : undefined,
  };
}

function makeQualityConfig(analysis: ReturnType<typeof createTextAnalysis>) {
  const terms = compileTerms(termbase, { analysis });
  const subjectFor = (input: {
    readonly candidate: {
      readonly sourceKey: string;
      readonly language: string;
      readonly content: TranslationBody;
    };
    readonly sourceUnit: SourceUnitFact<Unit> | null;
  }): QualityCheckSelection<Subject> => {
    if (input.sourceUnit === null) return { status: "not-applicable" };
    return {
      status: "selected",
      subject: {
        sourceUnit: input.sourceUnit,
        sourceKey: input.candidate.sourceKey,
        language: input.candidate.language,
        sourceText: input.sourceUnit.unit.source.text,
        content: input.candidate.content,
      },
    };
  };
  const projectTerms = (
    subject: Subject,
    inputContent: TranslationBody,
  ): TermComparisonInput => ({
    groups: [
      {
        ref: { sourceKey: subject.sourceKey, language: subject.language },
        source: {
          language: "en",
          ...(partialKeys.has(subject.sourceKey) ? { complete: false } : {}),
          fragments: [
            {
              ref: { resource: "src/lang/en.json", key: subject.sourceKey },
              text: subject.sourceText,
            },
          ],
        },
        target: {
          language: subject.language,
          fragments: [
            {
              ref: {
                resource: `src/lang/${subject.language}.json`,
                key: subject.sourceKey,
              },
              text: inputContent.text,
            },
          ],
        },
      },
    ],
  });
  const select = (input: {
    readonly candidate: {
      readonly sourceKey: string;
      readonly language: string;
      readonly content: TranslationBody;
    };
    readonly sourceUnit: SourceUnitFact<Unit> | null;
  }) => subjectFor(input);

  const terminology = [
    createTermChecker<Unit, Translation, Subject, TranslationBody>({
      terms,
      rule: requireAllowedTranslation(),
      select,
      project: (input) => ({
        status: "ready",
        value: projectTerms(input.subject, input.candidate.content),
      }),
    }),
    createTermChecker<Unit, Translation, Subject, TranslationBody>({
      terms,
      rule: rejectForbiddenTranslation(),
      select,
      project: (input) => ({
        status: "ready",
        value: projectTerms(input.subject, input.candidate.content),
      }),
    }),
  ];

  const messageFamily = createMessageFamilyChecker<
    Unit,
    Translation,
    Unit,
    TranslationBody
  >({
    select: (input) =>
      input.sourceUnit === null
        ? { status: "not-applicable" }
        : {
            status: "selected",
            subject: {
              sourceUnit: input.sourceUnit,
              sourceKey: input.candidate.sourceKey,
              language: input.candidate.language,
              content: input.candidate.content,
            },
          },
    project: (
      input: MessageFamilyProjection<
        Unit,
        Unit,
        Translation,
        TranslationBody,
        never
      >,
    ): MessageFamilyInput => {
      const isCandidate = input.kind === "candidate";
      const source = isCandidate
        ? input.subject.sourceUnit.unit.source.text
        : input.sourceUnit.unit.source.text;
      let content: TranslationBody;
      if (isCandidate) content = input.subject.content;
      else {
        if (input.translation.bodyAvailability !== "available")
          throw new Error("参照译文正文不可用。");
        content = input.translation.content;
      }
      const key = isCandidate ? input.subject.sourceKey : input.sourceKey;
      const language = isCandidate ? input.subject.language : input.language;
      const group = {
        ref: { sourceKey: key, language },
        scope: "uptime-kuma-ui",
        source: {
          language: "en",
          fragments: [
            { ref: { resource: "src/lang/en.json", key }, text: source },
          ],
        },
        target: {
          language,
          fragments: [
            {
              ref: { resource: `src/lang/${language}.json`, key },
              text: content.text,
            },
          ],
        },
      };
      if (isCandidate && partialKeys.has(key))
        return {
          complete: false,
          issues: [
            {
              code: "controlled-candidate-projection-incomplete",
              message: "受控候选还有未投影的关联片段。",
              sourceKey: key,
              language,
            },
          ],
          groups: [group],
        };
      return { groups: [group] };
    },
    analysis,
    sourceTemplate: templateOptions(),
    targetTemplate: templateOptions(),
  });

  const hostCheck = bindQualityCheck<
    Unit,
    Translation,
    typeof termRulesConfigurationSchema,
    typeof termComparisonInputSchema,
    Subject,
    QualityObject,
    TranslationBody
  >({
    id: "uptime-kuma/structured-resource-context",
    configurationSchema: termRulesConfigurationSchema,
    configuration: { rules: [] },
    inputSchema: termComparisonInputSchema,
    select,
    project: (
      input: QualityCheckProjectionInput<
        Unit,
        Translation,
        import("@lioni/terminology").TermRulesConfiguration,
        Subject,
        TranslationBody
      >,
    ) => ({
      status: "ready",
      value: projectTerms(input.subject, input.candidate.content),
    }),
    check: async (
      input: QualityCheckRuleInput<
        Unit,
        Translation,
        import("@lioni/terminology").TermRulesConfiguration,
        Subject,
        TermComparisonInput,
        TranslationBody
      >,
    ): Promise<QualityCheckOutcome<QualityObject>> => {
      const group = input.projected.groups[0];
      assert.ok(group);
      const sourceInput: TextInput = {
        text: group.source.fragments[0]!.text,
        language: group.source.language,
      };
      const targetInput: TextInput = {
        text: group.target.fragments[0]!.text,
        language: group.target.language,
      };
      const [sourceWords, targetWords] = await Promise.all([
        analysis.words(sourceInput, { memo: input.memo }),
        analysis.words(targetInput, { memo: input.memo }),
      ]);
      const mismatchedKey =
        input.candidate.content.resourceKey !== input.subject.sourceKey;
      const location = {
        language: input.subject.language,
        range: `src/lang/${input.subject.language}.json`,
        key: input.subject.sourceKey,
      };
      const diagnostics = mismatchedKey
        ? [
            {
              severity: "error" as const,
              object: {
                kind: "translation-unit",
                key: input.subject.sourceKey,
                language: input.subject.language,
                code: "resource-key-mismatch",
              },
              location,
              message: "候选正文的资源键与原文单元不一致。",
              evidence: [],
            },
          ]
        : [];
      const incomplete = !sourceWords.complete || !targetWords.complete;
      return {
        status: incomplete ? "incomplete" : "complete",
        diagnostics,
        issues: incomplete
          ? [
              {
                code: "word-analysis-incomplete",
                message: "宿主词界分析不完整。",
              },
            ]
          : [],
        coverage: {
          selected: 1,
          evaluated: incomplete ? 0 : 1,
          notApplicable: 0,
          incomplete: incomplete ? 1 : 0,
          failed: 0,
        },
      };
    },
  });

  const simpleCheck = bindQualityCheck<
    Unit,
    Translation,
    typeof termRulesConfigurationSchema,
    typeof termComparisonInputSchema,
    Subject,
    QualityObject,
    TranslationBody
  >({
    id: "uptime-kuma/simple-string-marker",
    configurationSchema: termRulesConfigurationSchema,
    configuration: { rules: [] },
    inputSchema: termComparisonInputSchema,
    select,
    project: (input) => ({
      status: "ready",
      value: projectTerms(input.subject, input.candidate.content),
    }),
    check: (input) => {
      const marker = input.projected.groups.some((group) =>
        group.target.fragments.some(({ text }) =>
          text.includes("[QA_SIMPLE_BLOCK]"),
        ),
      );
      const candidate = input.candidate;
      const diagnostics = marker
        ? [
            {
              severity: "error" as const,
              object: {
                kind: "translation-unit",
                key: candidate.sourceKey,
                language: candidate.language,
                code: "simple-marker",
              },
              location: {
                language: candidate.language,
                range: `src/lang/${candidate.language}.json`,
                key: candidate.sourceKey,
              },
              message: "译文包含受控禁止标记。",
              evidence: [],
            },
          ]
        : [];
      return {
        status: "complete",
        diagnostics,
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
  });

  return {
    terms,
    checks: [...terminology, messageFamily, hostCheck, simpleCheck],
    simpleCheck,
    config: defineConfig({
      source: {
        schema: sourceSchema,
        async read() {
          const source = await readLocale("en");
          return {
            scopes: [
              {
                range: "src/lang/en.json",
                enumeration: "complete",
                records: readSourceUnits(source).map((value) => ({
                  value,
                  bodyAvailability: "available" as const,
                })),
              },
            ],
          };
        },
      },
      keyOf: ({ key }) => key,
      translations: {
        languages: locales,
        schema: translationSchema,
        contentSchema,
        contentOf: (translation) =>
          body(translation.text, translation.language, translation.key),
        async read(language, sourceUnits) {
          assert.ok(
            locales.includes(language as Locale),
            `不支持语言 ${language}。`,
          );
          const resource = await readLocale(language);
          const records = Object.entries(resource)
            .filter(([, text]) => text.trim().length > 0)
            .map(([key, text]) => ({
              value: { key, text, language },
              bodyAvailability: "available" as const,
            }));
          return {
            scopes: [
              {
                range: `src/lang/${language}.json`,
                covers: sourceUnits.map(({ key }) => key),
                enumeration: "complete",
                records,
              },
            ],
          };
        },
        matches: (unit, translation) => unit.key === translation.key,
      },
      translationWriteback: {
        locateExistingTarget: ({ translation }) => ({
          status: "located",
          locator: {
            file: `src/lang/${translation.language}.json`,
            key: translation.translation.key,
          },
        }),
        locateNewTarget: ({ sourceUnit, language }) => ({
          status: "located",
          locator: {
            file: `src/lang/${language}.json`,
            key: sourceUnit.key,
          },
        }),
        dependencies: () => ({ host: "uptime-kuma", policy: "qa-v1" }),
        async write({ edit }) {
          if (edit.operation !== "write")
            throw new Error("本受控宿主场景不接受删除操作。");
          const locator = edit.target.locator;
          assert.ok(isRecord(locator));
          assert.equal(typeof locator.file, "string");
          assert.equal(typeof locator.key, "string");
          assert.equal(edit.content.resourceKey, edit.sourceKey);
          const file = path.join(hostRoot, locator.file as string);
          const current = await readLocale(edit.language);
          const next = {
            ...current,
            [locator.key as string]: edit.content.text,
          };
          const temporary = `${file}.lioni-qa.tmp`;
          await writeFile(temporary, `${JSON.stringify(next, null, 4)}\n`);
          await rename(temporary, file);
        },
      },
      qualityChecks: [...terminology, messageFamily, hostCheck, simpleCheck],
      createQualityRequest: () => ({
        candidates: [],
        dependencies: { host: "uptime-kuma-2.5.7", policy: "kuma-qa-v1" },
        exceptions,
      }),
    }),
  };
}

function createInstrumentedAnalysis() {
  const structures = new Map<string, number>();
  const words = new Map<string, number>();
  const identify = ({ text, language }: TextInput): string =>
    `${language}\0${text}`;
  const braceRecognizer = braceVariables();
  const analysis = createTextAnalysis({
    recognizers: [
      (input) => {
        const key = identify(input);
        structures.set(key, (structures.get(key) ?? 0) + 1);
        return braceRecognizer(input);
      },
    ],
    segmenter: (input) => {
      const key = identify(input);
      words.set(key, (words.get(key) ?? 0) + 1);
      return segmentWords(input);
    },
  });
  return {
    analysis,
    structures,
    words,
    clear() {
      structures.clear();
      words.clear();
    },
    count(map: Map<string, number>, language: string, text: string) {
      return map.get(`${language}\0${text}`) ?? 0;
    },
  };
}

async function runQuality(
  config: ReturnType<typeof makeQualityConfig>["config"],
  candidate: {
    readonly sourceKey: string;
    readonly language: string;
    readonly content: TranslationBody;
  },
) {
  const memo = createMemoScope();
  try {
    return await analyzeQuality(config, { candidates: [candidate], memo });
  } finally {
    memo.dispose();
  }
}

function diagnosticSummary(quality: Awaited<ReturnType<typeof runQuality>>) {
  return quality.diagnostics.map((diagnostic) => ({
    ruleId: diagnostic.ruleId,
    severity: diagnostic.severity,
    code: diagnostic.object.code ?? null,
    handling: diagnostic.handling.status,
  }));
}

async function installControlledCorpus(): Promise<{
  readonly sourceBytes: Buffer;
  readonly targetBytes: Buffer;
}> {
  const sourceBytes = await readFile(sourcePath);
  const targetBytes = await readFile(targetPath);
  const source = JSON.parse(sourceBytes.toString("utf8")) as Record<
    string,
    string
  >;
  const target = JSON.parse(targetBytes.toString("utf8")) as Record<
    string,
    string
  >;
  const familySource = "Request {service} failed with code {code}.";
  const partialSource = "Save {service} failed with code {code}.";
  const controlledSources: Record<string, string> = {
    [familyPrimaryKey]: familySource,
    "qa.control.family.reference-a": familySource,
    "qa.control.family.reference-b": familySource,
    [partialKey]: partialSource,
    "qa.control.partial.reference-a": partialSource,
    "qa.control.partial.reference-b": partialSource,
  };
  Object.assign(source, controlledSources);
  Object.assign(target, {
    [familyPrimaryKey]: "请求 {service} 失败，代码 {code}。",
    "qa.control.family.reference-a": "无法请求 {service}，代码 {code}。",
    "qa.control.family.reference-b": "请求 {service} 出错，代码 {code}。",
    [partialKey]: "保存 {service} 失败，代码 {code}。",
    "qa.control.partial.reference-a": "保存 {service} 失败，代码 {code}。",
    "qa.control.partial.reference-b": "保存 {service} 出错，代码 {code}。",
  });
  await writeFile(sourcePath, `${JSON.stringify(source, null, 4)}\n`);
  await writeFile(targetPath, `${JSON.stringify(target, null, 4)}\n`);
  return { sourceBytes, targetBytes };
}

async function restoreLocaleFiles(snapshot: {
  readonly sourceBytes: Buffer;
  readonly targetBytes: Buffer;
}): Promise<void> {
  await writeFile(sourcePath, snapshot.sourceBytes);
  await writeFile(targetPath, snapshot.targetBytes);
  partialKeys.clear();
  exceptions = [];
}

async function runNaturalCorpus() {
  const source = await readLocale("en");
  const sourceLocale = {
    resource: "src/lang/en.json",
    entries: Object.keys(source).length,
    nonemptyEntries: Object.values(source).filter(
      (text) => text.trim().length > 0,
    ).length,
  };
  const stats: Record<string, unknown> = {};
  const allPairedSources = new Set<string>();
  let allLocalePairs = 0;
  for (const language of locales) {
    const target = await readLocale(language);
    const pairs = Object.keys(source).filter(
      (key) =>
        source[key]!.trim().length > 0 && (target[key]?.trim().length ?? 0) > 0,
    );
    allLocalePairs += pairs.length;
    for (const key of pairs) allPairedSources.add(source[key]!);
    stats[language] = {
      localeEntries: Object.keys(target).length,
      nonemptyLocaleEntries: Object.values(target).filter(
        (text) => text.trim().length > 0,
      ).length,
      pairedNonemptyEntries: pairs.length,
      uniqueSourceStrings: new Set(pairs.map((key) => source[key]!)).size,
    };
  }

  const runs: Record<string, unknown> = {};
  for (const language of locales) {
    const instrumentation = createInstrumentedAnalysis();
    const constructed = makeQualityConfig(instrumentation.analysis);
    instrumentation.clear();
    const actualTranslation = (await readLocale(language))[mainTermKey];
    if (
      actualTranslation === undefined ||
      actualTranslation.trim().length === 0
    )
      throw new Error(`宿主 locale 缺少可用候选 ${language}.${mainTermKey}。`);
    const candidate = {
      sourceKey: mainTermKey,
      language,
      content: body(actualTranslation, language, mainTermKey),
    };
    const quality = await runQuality(constructed.config, candidate);
    assert.deepEqual(
      quality.checks.map(({ id }) => id),
      [
        "terminology/require-allowed-translation",
        "terminology/reject-forbidden-translation",
        "message-family-consistency",
        "uptime-kuma/structured-resource-context",
        "uptime-kuma/simple-string-marker",
      ],
    );
    assert.equal(
      instrumentation.count(instrumentation.structures, "en", "Save"),
      1,
    );
    assert.equal(instrumentation.count(instrumentation.words, "en", "Save"), 1);
    runs[language] = {
      selected: { key: mainTermKey, source: "Save", target: actualTranslation },
      status: quality.status,
      checks: quality.checks.map(({ id, status, diagnostics, issues }) => ({
        id,
        status,
        diagnostics: diagnostics.length,
        issues: issues.length,
      })),
      diagnostics: diagnosticSummary(quality),
      sharedAnalysis: {
        recognizedSourceInputs: instrumentation.count(
          instrumentation.structures,
          "en",
          "Save",
        ),
        segmentedSourceInputs: instrumentation.count(
          instrumentation.words,
          "en",
          "Save",
        ),
        distinctStructureInputs: instrumentation.structures.size,
        distinctWordInputs: instrumentation.words.size,
      },
    };
  }
  return {
    sourceLocale,
    localeStats: stats,
    allLocalePairs,
    uniqueSourceStringsAcrossTargets: allPairedSources.size,
    candidateRuns: runs,
  };
}

async function verifyNoAnalysisForConfigurationAndSimpleCheck() {
  const instrumentation = createInstrumentedAnalysis();
  const constructed = makeQualityConfig(instrumentation.analysis);
  assert.equal(
    instrumentation.structures.size,
    0,
    "配置构造不得触发结构识别。",
  );
  assert.equal(instrumentation.words.size, 0, "配置构造不得触发分词。");

  const emptyQuality = await analyzeQuality(constructed.config, {
    candidates: [],
  });
  assert.equal(emptyQuality.candidates.length, 0);
  assert.equal(instrumentation.structures.size, 0, "空候选不得触发结构识别。");
  assert.equal(instrumentation.words.size, 0, "空候选不得触发分词。");

  const simpleOnly = defineConfig({
    ...constructed.config,
    qualityChecks: [constructed.simpleCheck],
  });
  const simpleResult = await runQuality(simpleOnly, {
    sourceKey: mainTermKey,
    language: "zh-CN",
    content: body("保存 [QA_SIMPLE_BLOCK]", "zh-CN", mainTermKey),
  });
  assert.ok(
    simpleResult.diagnostics.some(
      ({ ruleId }) => ruleId === "uptime-kuma/simple-string-marker",
    ),
  );
  assert.equal(
    instrumentation.structures.size,
    0,
    "简单检查不得触发结构识别。",
  );
  assert.equal(instrumentation.words.size, 0, "简单检查不得触发分词。");

  const noChecks = defineConfig({ ...constructed.config, qualityChecks: [] });
  const noCheckResult = await runQuality(noChecks, {
    sourceKey: mainTermKey,
    language: "zh-CN",
    content: body("保存", "zh-CN", mainTermKey),
  });
  assert.equal(noCheckResult.checks.length, 0);
  assert.equal(
    instrumentation.structures.size,
    0,
    "关闭检查能力不得触发结构识别。",
  );
  assert.equal(instrumentation.words.size, 0, "关闭检查能力不得触发分词。");
  return {
    configConstruction: "未触发分析",
    emptyCandidates: "未触发分析",
    simpleCheck: "产生受控发现，未触发语言分析",
    noChecks: "未触发分析",
  };
}

async function verifyControlledCandidateAndWriteback() {
  const snapshot = await installControlledCorpus();
  try {
    const instrumentation = createInstrumentedAnalysis();
    const constructed = makeQualityConfig(instrumentation.analysis);

    const partialCandidate = {
      sourceKey: partialKey,
      language: "zh-CN",
      content: body(
        "错误保存 {service} 崩溃，代码 {code}。",
        "zh-CN",
        partialKey,
      ),
    };
    partialKeys.add(partialKey);
    const partialQuality = await runQuality(
      constructed.config,
      partialCandidate,
    );
    assert.equal(partialQuality.status, "incomplete");
    assert.ok(
      partialQuality.diagnostics.some(
        ({ ruleId }) => ruleId === "terminology/reject-forbidden-translation",
      ),
      "部分原文中仍应保留已知术语违规。",
    );
    assert.ok(
      partialQuality.diagnostics.some(
        ({ ruleId }) => ruleId === "message-family-consistency",
      ),
      "部分投影中仍应保留已知消息族差异。",
    );
    const partialGate = await prepareQualityConditionedSemanticEdit(
      constructed.config,
      {
        candidate: partialCandidate,
        condition: (quality) =>
          quality.status === "complete" &&
          !quality.diagnostics.some(
            ({ severity, handling }) =>
              severity === "error" && handling.status === "active",
          ),
      },
    );
    if (partialGate.status !== "rejected")
      throw new Error("不完整的受控候选未被宿主条件拒绝。");
    assert.equal(partialGate.quality.status, "incomplete");
    partialKeys.delete(partialKey);

    const forbiddenCandidate = {
      sourceKey: mainTermKey,
      language: "zh-CN",
      content: body("错误保存", "zh-CN", mainTermKey),
    };
    const forbidden = await runQuality(constructed.config, forbiddenCandidate);
    assert.ok(
      forbidden.diagnostics.some(
        ({ ruleId, handling }) =>
          ruleId === "terminology/reject-forbidden-translation" &&
          handling.status === "active",
      ),
      "禁用表达应形成活动诊断。",
    );
    const rejected = await prepareQualityConditionedSemanticEdit(
      constructed.config,
      {
        candidate: forbiddenCandidate,
        condition: (quality) =>
          quality.status === "complete" &&
          !quality.diagnostics.some(
            ({ severity, handling }) =>
              severity === "error" && handling.status === "active",
          ),
      },
    );
    assert.equal(rejected.status, "rejected");

    exceptions = [
      {
        id: "kuma-qa-review-save",
        ruleId: "terminology/reject-forbidden-translation",
        scope: {
          object: { kind: "translation", key: mainTermKey, language: "zh-CN" },
        },
        reason: "用于核实宿主例外映射；不作为写入许可。",
      },
    ];
    const excepted = await runQuality(constructed.config, forbiddenCandidate);
    assert.ok(
      excepted.diagnostics.some(
        ({ ruleId, handling }) =>
          ruleId === "terminology/reject-forbidden-translation" &&
          handling.status === "excepted",
      ),
      "宿主例外应保留原始发现并标记例外处理。",
    );
    exceptions = [];

    const newText = "无法连接 {service}，代码 {code}。";
    const writeCandidate = {
      sourceKey: familyPrimaryKey,
      language: "zh-CN",
      content: body(newText, "zh-CN", familyPrimaryKey),
    };
    const conditionResult = await prepareQualityConditionedSemanticEdit(
      constructed.config,
      {
        candidate: writeCandidate,
        condition: (quality) =>
          quality.status === "complete" &&
          !quality.diagnostics.some(
            ({ severity, handling }) =>
              severity === "error" && handling.status === "active",
          ),
      },
    );
    if (conditionResult.status !== "passed")
      throw new Error("完整且无活动 error 的受控候选未通过宿主条件。");
    if (conditionResult.preparation.status !== "prepared")
      throw new Error("宿主条件通过后未能准备语义编辑。");
    assert.ok(
      conditionResult.quality.diagnostics.some(
        ({ ruleId, severity }) =>
          ruleId === "message-family-consistency" && severity === "warning",
      ),
      "消息族差异应按 warning 呈现，宿主条件允许无 error 的完整候选。",
    );
    const applied = await applySemanticEdits(
      [conditionResult.preparation.edit],
      constructed.config,
    );
    assert.equal(applied.results[0]?.status, "written");
    const reread = await readLocale("zh-CN");
    assert.equal(reread[familyPrimaryKey], newText);
    assert.equal(
      applied.results[0]?.after?.translations.find(
        ({ language }) => language === "zh-CN",
      )?.content?.text,
      newText,
      "core 正式写回链路的回读事实应确认新正文。",
    );

    const heterogeneousCandidate = {
      sourceKey: mainTermKey,
      language: "zh-CN",
      content: body("保存", "zh-CN", "wrong-resource-key"),
    };
    const heterogeneousNegative = await runQuality(
      constructed.config,
      heterogeneousCandidate,
    );
    assert.ok(
      heterogeneousNegative.diagnostics.some(
        ({ ruleId, object }) =>
          ruleId === "uptime-kuma/structured-resource-context" &&
          object.code === "resource-key-mismatch",
      ),
      "异构正文的资源键错配应形成宿主自定义诊断。",
    );

    return {
      controlledCorpus: {
        sourceKeys: [
          familyPrimaryKey,
          "qa.control.family.reference-a",
          "qa.control.family.reference-b",
          partialKey,
          "qa.control.partial.reference-a",
          "qa.control.partial.reference-b",
        ],
        partial: {
          status: partialQuality.status,
          diagnostics: diagnosticSummary(partialQuality),
          issues: partialQuality.checks.flatMap(({ issues }) =>
            issues.map(({ code }) => code),
          ),
          writeCondition: partialGate.status,
        },
        forbiddenCandidate: {
          status: forbidden.status,
          diagnostics: diagnosticSummary(forbidden),
          writeCondition: rejected.status,
          exception: diagnosticSummary(excepted),
        },
        hostConditionedWrite: {
          status: conditionResult.status,
          warningCount: conditionResult.quality.diagnostics.filter(
            ({ severity }) => severity === "warning",
          ).length,
          applyStatus: applied.results[0]?.status,
          rereadValue: reread[familyPrimaryKey],
        },
        heterogeneousBody: {
          shape: "{ text, language, resourceKey }",
          positive: "资源键等于候选 sourceKey",
          negativeDiagnostics: diagnosticSummary(heterogeneousNegative),
        },
      },
    };
  } finally {
    await restoreLocaleFiles(snapshot);
  }
}

async function main(): Promise<void> {
  const originalSource = await readFile(sourcePath);
  const originalTarget = await readFile(targetPath);
  const natural = await runNaturalCorpus();
  const noAnalysis = await verifyNoAnalysisForConfigurationAndSimpleCheck();
  let controls: Awaited<
    ReturnType<typeof verifyControlledCandidateAndWriteback>
  >;
  try {
    controls = await verifyControlledCandidateAndWriteback();
  } catch (error) {
    await writeFile(sourcePath, originalSource);
    await writeFile(targetPath, originalTarget);
    throw error;
  }
  const report = {
    host: {
      name: "Uptime Kuma",
      version: "2.5.7",
      commit: "d54e4619e52553416e292549f435cc7e57330c29",
      applicationBuildStarted: false,
      applicationServerStarted: false,
      verification: "本地化 QA 工具链与宿主资源读写；未构建或启动应用。",
    },
    policy: {
      source: "src/lang/en.json",
      targets: locales.map((language) => `src/lang/${language}.json`),
      sourceKeySelected: mainTermKey,
      emptyValues: "读取并配对时剔除空字符串，不使用英文回退填充。",
      messageFamilyScope:
        "uptime-kuma-ui，同一原文签名形成组；受控槽位为命名花括号变量。",
      writeCondition:
        "仅允许完整且无活动 error 的候选；warning 可由宿主政策接受。",
    },
    natural,
    noAnalysis,
    ...controls,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

await main();
