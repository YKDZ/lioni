import assert from "node:assert/strict";
import { Hash, type BinaryLike, type Encoding } from "node:crypto";

import {
  analyzeQuality,
  createMessageFamilyChecker,
  createQualityProfiler,
  defineConfig,
  type MessageFamilyInput,
  type QualityCheckResultCache,
} from "@lioni/lioni";
import { z } from "zod";

const unitSchema = z.object({ id: z.string(), source: z.string() });
const translationSchema = z.object({ id: z.string(), text: z.string() });
type Unit = z.output<typeof unitSchema>;
type Translation = z.output<typeof translationSchema>;

async function measure(size: number, shape: "small" | "large") {
  let projections = 0;
  let referenceVisits = 0;
  let hashBytes = 0;
  const units = Array.from({ length: size }, (_, index) => ({
    id: `message-${index}`,
    source: shape === "large" ? "Hello" : `Hello ${index}`,
  }));
  const translations = units.map(({ id }) => ({ id, text: "你好" }));
  function projection(
    sourceKey: string,
    source: string,
    target: string,
    saved: boolean,
  ): MessageFamilyInput {
    // 只观察 JSON 引用的实际读取，值与属性描述符保持不变。
    const ref = saved
      ? new Proxy(
          { sourceKey },
          {
            getOwnPropertyDescriptor(value, key) {
              referenceVisits++;
              return Reflect.getOwnPropertyDescriptor(value, key);
            },
          },
        )
      : { sourceKey };
    return {
      complete: true,
      groups: [
        {
          ref,
          scope: "ui",
          source: { language: "en", fragments: [{ ref, text: source }] },
          target: { language: "zh", fragments: [{ ref, text: target }] },
        },
      ],
    };
  }
  const checker = createMessageFamilyChecker<Unit, Translation, Unit, string>({
    id: "artifact-message-families",
    hostVersion: "artifact-v1",
    select: (input) =>
      input.sourceUnit === null
        ? {
            status: "incomplete",
            issue: { code: "sourceUnavailable", message: "找不到原文。" },
          }
        : {
            status: "selected",
            subject: {
              sourceUnit: input.sourceUnit,
              sourceKey: input.candidate.sourceKey,
              language: input.candidate.language,
              content: input.candidate.content,
            },
          },
    project: ({ subject }) =>
      projection(
        subject.sourceKey,
        subject.sourceUnit.unit.source,
        subject.content,
        false,
      ),
    reference: (reference, context) => {
      assert.equal("candidate" in context, false);
      assert.equal("sourceUnit" in context, false);
      projections++;
      assert.equal(reference.translation.bodyAvailability, "available");
      return projection(
        reference.sourceKey,
        reference.sourceUnit.unit.source,
        reference.translation.bodyAvailability === "available"
          ? reference.translation.content
          : "",
        true,
      );
    },
    fingerprintInput: () => null,
  });
  const entries = new Map<
    string,
    Awaited<ReturnType<QualityCheckResultCache["get"]>>
  >();
  const config = defineConfig({
    source: {
      schema: unitSchema,
      read: () => ({
        scopes: [
          {
            range: "en",
            enumeration: "complete",
            records: units.map((value) => ({
              value,
              bodyAvailability: "available",
            })),
          },
        ],
      }),
    },
    keyOf: ({ id }) => id,
    translations: {
      languages: ["zh"],
      keyOf: ({ id }) => id,
      schema: translationSchema,
      contentSchema: z.string(),
      contentOf: ({ text }) => text,
      read: () => ({
        scopes: [
          {
            range: "zh",
            enumeration: "complete",
            covers: units.map(({ id }) => id),
            records: translations.map((value) => ({
              value,
              bodyAvailability: "available",
            })),
          },
        ],
      }),
    },
    quality: {
      checks: [checker],
      resultCache: {
        get: async (key) => entries.get(key),
        set: async (key, value) => {
          entries.set(key, value);
        },
      },
    },
  });
  const samples = [];
  for (const cache of ["cold", "warm"]) {
    projections = 0;
    referenceVisits = 0;
    hashBytes = 0;
    const update = Hash.prototype.update;
    // 同时计量完整 QA 的哈希输入，避免只缓存一次摘要却逐候选重新序列化全族。
    Hash.prototype.update = function (data: BinaryLike, encoding?: Encoding) {
      hashBytes +=
        typeof data === "string"
          ? Buffer.byteLength(data, encoding)
          : data.byteLength;
      return Reflect.apply(
        update,
        this,
        encoding === undefined ? [data] : [data, encoding],
      ) as Hash;
    };
    const profiler = createQualityProfiler({ slowestCandidates: 0 });
    try {
      const result = await analyzeQuality(config, { profiler });
      assert.equal(
        result.status,
        shape === "large" ? "complete" : "not-applicable",
      );
      assert.deepEqual(result.diagnostics, []);
    } finally {
      Hash.prototype.update = update;
    }
    const report = profiler.report();
    const check = report.checks[0]!;
    assert.equal(projections, size);
    assert.equal(check.cache.reads.hit, cache === "warm" ? size : 0);
    assert.equal(check.executedRules, cache === "warm" ? 0 : size);
    samples.push({
      shape,
      size,
      cache,
      projections,
      referenceVisits,
      hashBytes,
      totalMs: report.totalMs,
      prepareMs: check.timings.find((item) => item.stage === "prepareInput")!
        .durationMs,
      executeMs:
        check.timings.find((item) => item.stage === "execute")?.durationMs ?? 0,
    });
  }
  return samples;
}

const samples = [];
for (const shape of ["small", "large"] as const) {
  const small = await measure(32, shape);
  const medium = await measure(64, shape);
  const large = await measure(128, shape);
  for (const cache of ["cold", "warm"]) {
    const previous = medium.find((item) => item.cache === cache)!;
    const current = large.find((item) => item.cache === cache)!;
    assert.ok(
      current.referenceVisits < previous.referenceVisits * 3,
      `${shape}/${cache} 的完整参照读取增长过快`,
    );
    assert.ok(
      current.hashBytes < previous.hashBytes * 3,
      `${shape}/${cache} 的完整 QA 指纹处理量增长过快`,
    );
  }
  samples.push(...small, ...medium, ...large);
}
process.stdout.write(`${JSON.stringify(samples)}\n`);
