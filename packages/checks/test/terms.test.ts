import assert from "node:assert/strict";
import { test } from "node:test";

import {
  analyzeQuality,
  createQualityException,
  defineConfig,
  readFacts,
  StandardSchemaContractError,
  type JsonValue,
  type QualityException,
  type QualityCheckResultCache,
  writeTranslationRequests,
  type TranslationWriteRequest,
} from "@lioni/core";
import {
  compileTerms,
  createTermbase,
  evaluateTerms,
  rejectForbiddenTranslation,
  requireAllowedTranslation,
  type TermComparisonInput,
  type CompiledTerms,
} from "@lioni/terminology";
import { createTextAnalysis, segmentWords } from "@lioni/text-analysis";
import { z } from "zod";

import { createTermChecker } from "../src/index.ts";

type SourceMessage = {
  readonly title: string;
  readonly notes: readonly string[];
};
type Unit = { readonly id: string; readonly source: SourceMessage };
type Body = { readonly visible: string; readonly hidden: string };
type Translation = { readonly id: string; readonly body: Body };

const sourceMessageSchema = z.object({
  title: z.string(),
  notes: z.array(z.string()).readonly(),
});
const unitSchema: z.ZodType<Unit, Unit> = z.object({
  id: z.string(),
  source: sourceMessageSchema,
});
const bodySchema: z.ZodType<Body, Body> = z.object({
  visible: z.string(),
  hidden: z.string(),
});
const translationSchema: z.ZodType<Translation, Translation> = z.object({
  id: z.string(),
  body: bodySchema,
});

function createScenario(
  options: {
    readonly countTermBoundary?: boolean;
    readonly narrowFingerprint?: boolean;
    readonly loadTerms?: () => Promise<CompiledTerms>;
    readonly resultCache?: QualityCheckResultCache;
  } = {},
) {
  let storedBody: Body = { visible: "工作区", hidden: "作业区" };
  let sourceTitle = "workspace";
  let otherText = "消息 B";
  let exceptions: readonly QualityException[] = [];
  let invalidProjection = false;
  let targetComplete = true;
  let segmentationCalls = 0;
  let termBoundaryCalls = 0;
  const termAnalysis = createTextAnalysis({
    segmenter(input) {
      segmentationCalls += 1;
      return segmentWords(input);
    },
  });
  const terms = compileTerms(
    createTermbase({
      concepts: [
        {
          id: "workspace",
          languages: [
            {
              language: "en",
              expressions: [
                { id: "workspace-en", text: "workspace", usage: "preferred" },
              ],
            },
            {
              language: "zh",
              expressions: [
                { id: "workspace-zh", text: "工作区", usage: "allowed" },
                { id: "workspace-old", text: "作业区", usage: "forbidden" },
              ],
            },
          ],
        },
        {
          id: "log",
          languages: [
            {
              language: "en",
              expressions: [{ id: "log-en", text: "log", usage: "preferred" }],
            },
            {
              language: "zh",
              expressions: [
                { id: "log-zh", text: "日志", usage: "allowed" },
                { id: "log-record", text: "记录", usage: "forbidden" },
              ],
            },
          ],
        },
        {
          id: "record",
          languages: [
            {
              language: "en",
              expressions: [
                { id: "record-en", text: "record", usage: "preferred" },
              ],
            },
            {
              language: "zh",
              expressions: [
                { id: "record-zh", text: "记录", usage: "allowed" },
              ],
            },
          ],
        },
      ],
    }),
    {
      analysis: termAnalysis,
      policyFor: (entry) =>
        options.countTermBoundary && entry.language === "zh"
          ? {
              id: "count-term-boundary",
              boundary: () => {
                termBoundaryCalls += 1;
                return true;
              },
            }
          : undefined,
    },
  );

  const project = ({
    candidate,
    sourceUnit,
  }: {
    readonly candidate: { readonly content: Body };
    readonly sourceUnit: { readonly unit: Unit } | null;
  }) => {
    if (invalidProjection)
      return {
        status: "ready" as const,
        value: { groups: [{}] } as unknown as TermComparisonInput,
      };
    if (sourceUnit === null)
      return {
        status: "incomplete" as const,
        issue: { code: "source-unavailable", message: "原文不可用。" },
      };
    return {
      status: "ready" as const,
      value: {
        groups: [
          {
            ref: "workspace",
            source: {
              language: "en",
              fragments: [
                { ref: "source-title", text: sourceUnit.unit.source.title },
              ],
            },
            target: {
              language: "zh",
              fragments: [
                { ref: "target-visible", text: candidate.content.visible },
              ],
              ...(targetComplete ? {} : { complete: false }),
            },
          },
        ],
      } satisfies TermComparisonInput,
    };
  };

  const checks = [
    createTermChecker<Unit, Translation, string, Body>({
      hostVersion: "terms-test-v1",
      terms: options.loadTerms ?? terms,
      ...(options.narrowFingerprint
        ? {
            fingerprintInput: ({ projected, candidate }) => ({
              projected,
              sourceKey: candidate.sourceKey,
              language: candidate.language,
            }),
          }
        : {}),
      rule: requireAllowedTranslation(),
      select: ({ candidate }) => ({
        status: "selected",
        subject: candidate.sourceKey,
      }),
      project,
      location: ({ ref, language, sourceKey }) => ({
        language,
        range: { file: "locale.json", ref },
        key: sourceKey,
      }),
    }),
    createTermChecker<Unit, Translation, string, Body>({
      hostVersion: "terms-test-v1",
      terms: options.loadTerms ?? terms,
      ...(options.narrowFingerprint
        ? {
            fingerprintInput: ({ projected, candidate }) => ({
              projected,
              sourceKey: candidate.sourceKey,
              language: candidate.language,
            }),
          }
        : {}),
      rule: rejectForbiddenTranslation(),
      select: ({ candidate }) => ({
        status: "selected",
        subject: candidate.sourceKey,
      }),
      project,
      location: ({ ref, language, sourceKey }) => ({
        language,
        range: { file: "locale.json", ref },
        key: sourceKey,
      }),
    }),
  ];

  const config = defineConfig({
    source: {
      schema: unitSchema,
      read: () => ({
        scopes: [
          {
            range: "messages.json",
            enumeration: "complete",
            records: [
              {
                value: {
                  id: "workspace",
                  source: {
                    title: sourceTitle,
                    notes: ["ignored source text"],
                  },
                },
                bodyAvailability: "available",
              },
              {
                value: { id: "other", source: { title: "other", notes: [] } },
                bodyAvailability: "available",
              },
            ],
          },
        ],
      }),
    },
    keyOf: ({ id }) => id,
    translations: {
      languages: ["zh"],
      keyOf: (translation) => ({
        namespace: "messages",
        key: translation.id,
      }),
      schema: translationSchema,
      contentSchema: bodySchema,
      contentOf: ({ body }) => body,
      read: (_language, sourceUnits) => ({
        scopes: [
          {
            range: "locale.json",
            enumeration: targetComplete ? "complete" : "partial",
            covers: sourceUnits.map(({ key }) => key),
            records: [
              {
                value: { id: "workspace", body: storedBody },
                bodyAvailability: "available",
              },
              {
                value: {
                  id: "other",
                  body: { visible: otherText, hidden: "" },
                },
                bodyAvailability: "available",
              },
            ],
          },
        ],
      }),
      matches: (unit, translation) => unit.id === translation.id,
    },
    translationWriteback: {
      locateExistingTarget: () => ({
        status: "located",
        locator: { file: "locale.json", key: "workspace" },
      }),
      locateNewTarget: () => ({
        status: "notWritable",
        reason: "本场景仅修改已有译文。",
      }),
      write: ({ request }) => {
        if (request.operation === "write") storedBody = request.content;
      },
    },
    quality: {
      ...(options.resultCache === undefined
        ? {}
        : { resultCache: options.resultCache }),
      exceptionStore: {
        async load() {
          return exceptions;
        },
        async upsert(exception) {
          exceptions = [
            ...exceptions.filter(({ id }) => id !== exception.id),
            exception,
          ];
        },
      },
      checks,
      buildCandidates: () => [
        {
          sourceKey: "workspace",
          language: "zh",
          content: { visible: "工作区", hidden: "作业区" },
        },
      ],
    },
  });

  return {
    config,
    terms,
    setOtherText: (value: string) => {
      otherText = value;
    },
    setSourceTitle: (value: string) => {
      sourceTitle = value;
    },
    setInvalidProjection: (value: boolean) => {
      invalidProjection = value;
    },
    setTargetComplete: (value: boolean) => {
      targetComplete = value;
    },
    setExceptions: (value: readonly QualityException[]) => {
      exceptions = value;
    },
    storedBody: () => storedBody,
    segmentationCalls: () => segmentationCalls,
    termBoundaryCalls: () => termBoundaryCalls,
  };
}

void test("术语检查只投影宿主选定的 JSON 字段，并复用同次 QA 识别", async () => {
  const scenario = createScenario();
  assert.equal(scenario.segmentationCalls(), 0);

  const accepted = await analyzeQuality(scenario.config);
  assert.equal(accepted.status, "complete");
  assert.deepEqual(accepted.diagnostics, []);
  assert.equal(scenario.segmentationCalls(), 1);

  const candidate = {
    sourceKey: "workspace",
    language: "zh",
    content: { visible: "作业区", hidden: "工作区" },
  };
  const checked = await analyzeQuality(scenario.config, {
    candidates: [candidate],
  });
  assert.equal(scenario.segmentationCalls(), 2);
  const input: TermComparisonInput = {
    groups: [
      {
        ref: "workspace",
        source: {
          language: "en",
          fragments: [{ ref: "source-title", text: "workspace" }],
        },
        target: {
          language: "zh",
          fragments: [{ ref: "target-visible", text: "作业区" }],
        },
      },
    ],
  };
  const independent = await evaluateTerms(scenario.terms, input);

  assert.deepEqual(
    checked.diagnostics.map((diagnostic) => diagnostic.object.code),
    independent.problems.map((problem) => problem.code),
  );
  assert.deepEqual(
    checked.diagnostics.map(({ object }) => object.code),
    ["missing-allowed-translation", "forbidden-translation"],
  );
  assert.equal(scenario.segmentationCalls(), 3);
  assert.ok(
    checked.diagnostics.some((diagnostic) =>
      diagnostic.evidence.some(
        (item) =>
          item.role === "target-term" &&
          item.location.range !== undefined &&
          JSON.stringify(item.location.span) ===
            JSON.stringify({ start: 0, end: 3 }),
      ),
    ),
  );
});

void test("两项术语规则复用同次 QA 术语识别", async () => {
  const scenario = createScenario({ countTermBoundary: true });

  const result = await analyzeQuality(scenario.config);

  assert.equal(result.status, "complete");
  assert.equal(scenario.segmentationCalls(), 1);
  assert.equal(scenario.termBoundaryCalls(), 1);
});

void test("QA 例外保留术语发现，宿主条件控制语义编辑", async () => {
  const scenario = createScenario();
  const candidate = {
    sourceKey: "workspace",
    language: "zh",
    content: { visible: "作业区", hidden: "工作区" },
  };
  const facts = await readFacts(scenario.config);
  const sourceUnit = facts.source.units.find(({ key }) => key === "workspace");
  const sourceScope =
    sourceUnit === undefined
      ? undefined
      : facts.source.read.scopes[sourceUnit.scopeIndex];
  const translation = facts.translations.records[0];
  assert.ok(sourceUnit);
  assert.ok(sourceScope);
  assert.ok(translation && translation.bodyAvailability === "available");
  if (
    sourceUnit === undefined ||
    sourceScope === undefined ||
    translation === undefined ||
    translation.bodyAvailability !== "available"
  )
    return;
  const request: TranslationWriteRequest<Body, Unit> = {
    operation: "write",
    target: { identity: translation.identity },
    content: candidate.content,
    expectedSource: {
      presence: "present",
      key: sourceUnit.key,
      unit: sourceUnit.unit,
      content: sourceUnit.unit.source,
      range: sourceScope.range as JsonValue,
    },
    expectedTarget: {
      status: "present",
      identity: translation.identity,
      content: translation.content,
      range: "locale.json",
      record: translation.translation,
    },
  };
  const rejectedQuality = await analyzeQuality(scenario.config, {
    candidates: [candidate],
  });
  const rejected = await writeTranslationRequests(
    [request],
    scenario.config,
    () => rejectedQuality.diagnostics.length === 0,
  );
  assert.equal(rejected.results[0]?.status, "conflict");
  assert.deepEqual(
    rejectedQuality.diagnostics.map((diagnostic) => [
      diagnostic.object.code,
      diagnostic.handling.status,
    ]),
    [
      ["missing-allowed-translation", "active"],
      ["forbidden-translation", "active"],
    ],
  );
  assert.equal(scenario.storedBody().visible, "工作区");

  const missingAllowedExecution = rejectedQuality.checks
    .find(
      ({ checkId }) => checkId === "terminology/require-allowed-translation",
    )
    ?.executions.find(
      ({ sourceKey, language }) =>
        sourceKey === "workspace" && language === "zh",
    );
  const forbiddenExecution = rejectedQuality.checks
    .find(
      ({ checkId }) => checkId === "terminology/reject-forbidden-translation",
    )
    ?.executions.find(
      ({ sourceKey, language }) =>
        sourceKey === "workspace" && language === "zh",
    );
  assert.ok(missingAllowedExecution);
  assert.ok(forbiddenExecution);
  scenario.setExceptions([
    createQualityException({
      id: "allow-missing-term-review",
      reason: "本地化审校接受此项候选。",
      execution: missingAllowedExecution,
    }),
    createQualityException({
      id: "allow-forbidden-term-review",
      reason: "本地化审校接受此项候选。",
      execution: forbiddenExecution,
    }),
  ]);
  const passedQuality = await analyzeQuality(scenario.config, {
    candidates: [candidate],
  });
  assert.deepEqual(
    passedQuality.checks.map(({ version }) => version),
    [
      "checks.terminology-rule/v2+terms-test-v1",
      "checks.terminology-rule/v2+terms-test-v1",
    ],
  );
  assert.deepEqual(
    passedQuality.diagnostics.map((diagnostic) => diagnostic.object.code),
    ["missing-allowed-translation", "forbidden-translation"],
  );
  assert.deepEqual(
    passedQuality.diagnostics.map((diagnostic) => diagnostic.handling.status),
    ["excepted", "excepted"],
  );
  const applied = await writeTranslationRequests(
    [request],
    scenario.config,
    () =>
      passedQuality.diagnostics.length === 2 &&
      passedQuality.diagnostics.every(
        (diagnostic) => diagnostic.handling.status === "excepted",
      ),
  );
  assert.equal(applied.results[0]?.status, "written");
  assert.equal(scenario.storedBody().visible, "作业区");
});

void test("log/record 允许命中可满足要求，禁用归属仍保持局部不确定", async () => {
  const scenario = createScenario();
  scenario.setSourceTitle("log record");
  const candidate = {
    sourceKey: "workspace",
    language: "zh",
    content: { visible: "日志与记录", hidden: "作业区" },
  };
  const checked = await analyzeQuality(scenario.config, {
    candidates: [candidate],
  });
  const independent = await evaluateTerms(scenario.terms, {
    groups: [
      {
        ref: "workspace",
        source: {
          language: "en",
          fragments: [{ ref: "source-title", text: "log record" }],
        },
        target: {
          language: "zh",
          fragments: [{ ref: "target-visible", text: "日志与记录" }],
        },
      },
    ],
  });

  assert.equal(checked.status, "incomplete");
  assert.equal(independent.status, "incomplete");
  assert.deepEqual(checked.diagnostics, []);
  assert.deepEqual(independent.problems, []);
  const byConcept = (left: readonly unknown[], right: readonly unknown[]) =>
    String(left[0]).localeCompare(String(right[0]));
  assert.deepEqual(
    checked.checks
      .flatMap((check) => check.issues)
      .map((issue) => [
        issue.object?.conceptId,
        issue.object?.ruleId,
        issue.code,
      ])
      .sort(byConcept),
    independent.issues
      .map((issue) => [issue.conceptId, issue.ruleId, issue.code])
      .sort(byConcept),
  );
  assert.deepEqual(
    independent.issues.map((issue) => [
      issue.conceptId,
      issue.ruleId,
      issue.code,
    ]),
    [
      ["log", "reject-forbidden-translation", "ambiguous-target"],
      ["record", "require-allowed-translation", "ambiguous-target"],
    ],
  );
});

void test("部分译文范围保留确定禁用诊断并标记不完整", async () => {
  const scenario = createScenario();
  scenario.setTargetComplete(false);
  const result = await analyzeQuality(scenario.config, {
    candidates: [
      {
        sourceKey: "workspace",
        language: "zh",
        content: { visible: "作业区", hidden: "工作区" },
      },
    ],
  });

  assert.equal(result.status, "incomplete");
  assert.deepEqual(
    result.diagnostics.map((diagnostic) => diagnostic.object.code),
    ["forbidden-translation"],
  );
  assert.ok(result.checks.some((check) => check.status === "incomplete"));
  assert.ok(
    result.checks
      .flatMap((check) => check.issues)
      .some((issue) => issue.code === "incomplete-target-scope"),
  );
});

void test("术语投影不符合 Standard Schema 时保持正式契约错误", async () => {
  const scenario = createScenario();
  scenario.setInvalidProjection(true);

  await assert.rejects(
    analyzeQuality(scenario.config),
    (error) =>
      error instanceof StandardSchemaContractError &&
      error.kind === "schema-mismatch" &&
      error.valueDescription.includes("投影输入"),
  );
});

void test("术语工厂显式收窄依据后仅相关变化影响例外，默认仍包含完整事实", async () => {
  for (const narrowFingerprint of [false, true]) {
    const scenario = createScenario({ narrowFingerprint });
    const candidates = [
      {
        sourceKey: "workspace",
        language: "zh",
        content: { visible: "作业区", hidden: "工作区" },
      },
    ];
    const run = () => analyzeQuality(scenario.config, { candidates });
    const first = await run();
    scenario.setExceptions(
      first.checks.flatMap((check) =>
        check.executions.map((execution) =>
          createQualityException({
            id: execution.checkId,
            reason: "接受消息 A 的译法",
            execution,
          }),
        ),
      ),
    );
    assert.deepEqual(
      (await run()).exceptionApplicability.map((item) => item.status),
      ["applicable", "applicable"],
    );
    scenario.setOtherText("修改消息 B");
    const unrelated = await run();
    assert.deepEqual(
      unrelated.exceptionApplicability.map((item) => item.status),
      narrowFingerprint
        ? ["applicable", "applicable"]
        : ["basis-changed", "basis-changed"],
    );
    assert.deepEqual(
      unrelated.diagnostics.map((item) => item.handling.status),
      narrowFingerprint ? ["excepted", "excepted"] : ["active", "active"],
    );
    scenario.setSourceTitle("workspace changed");
    assert.deepEqual(
      (await run()).exceptionApplicability.map((item) => item.status),
      ["basis-changed", "basis-changed"],
    );
    scenario.setSourceTitle("workspace");
    scenario.setOtherText("消息 B");
    assert.deepEqual(
      (await run()).exceptionApplicability.map((item) => item.status),
      ["applicable", "applicable"],
    );
  }
});

void test("术语工厂以本次异步加载的资料绑定指纹和计算，缓存不能掩盖资料变化", async () => {
  let reads = 0;
  const original = createScenario().terms;
  let terms = original;
  const stored = new Map<
    string,
    Awaited<ReturnType<QualityCheckResultCache["get"]>>
  >();
  let hits = 0;
  const scenario = createScenario({
    narrowFingerprint: true,
    loadTerms: async () => {
      reads++;
      return terms;
    },
    resultCache: {
      async get(key) {
        const value = stored.get(key);
        if (value) hits++;
        return value;
      },
      async set(key, value) {
        stored.set(key, value);
      },
    },
  });
  const candidates = [
    {
      sourceKey: "workspace",
      language: "zh",
      content: { visible: "作业区", hidden: "工作区" },
    },
  ];
  const run = () => analyzeQuality(scenario.config, { candidates });
  const first = await run();
  assert.equal(reads, 2);
  scenario.setExceptions(
    first.checks.flatMap((check) =>
      check.executions.map((execution) =>
        createQualityException({
          id: execution.checkId,
          reason: "接受消息 A 的译法",
          execution,
        }),
      ),
    ),
  );
  scenario.setOtherText("修改消息 B");
  const cached = await run();
  assert.equal(hits, 2);
  assert.equal(reads, 4);
  assert.deepEqual(
    cached.diagnostics.map((item) => item.handling.status),
    ["excepted", "excepted"],
  );
  terms = compileTerms(createTermbase({ concepts: [] }));
  const changed = await run();
  assert.equal(reads, 6);
  assert.equal(hits, 2);
  assert.deepEqual(changed.diagnostics, []);
  assert.deepEqual(
    changed.exceptionApplicability.map((item) => item.status),
    ["basis-changed", "basis-changed"],
  );
  terms = original;
  assert.deepEqual(
    (await run()).diagnostics.map((item) => item.handling.status),
    ["excepted", "excepted"],
  );
  assert.equal(reads, 8);
  assert.equal(hits, 4);
});
