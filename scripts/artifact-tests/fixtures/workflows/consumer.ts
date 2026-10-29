import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";

import {
  applyUpdatePlan,
  previewUpdate,
  readFacts,
  recordComparisonBaseline,
  validateTranslationWriteRequest,
  validateUpdatePlan,
  writeTranslationRequests,
  type TranslationWriteRequest,
  type TranslationWritebackAdapter,
  type UpdatePlan,
} from "@lioni/lioni";
import {
  createFileComparisonBaselineStore,
  createFileUpdatePlanStore,
} from "@lioni/lioni/node";
import * as z from "zod";

import config, { type Translation, type Unit } from "./lioni.config.ts";

const fileLocatorSchema = z.object({ file: z.string() });

type BatchAdapter = TranslationWritebackAdapter<Unit, Translation, string>;
type BatchWriteInput = Parameters<NonNullable<BatchAdapter["writeBatch"]>>[0];
type LocateExistingInput = Parameters<
  NonNullable<BatchAdapter["locateExistingTarget"]>
>[0];

const baseline = createFileComparisonBaselineStore<Unit, Translation, string>(
  "baseline.json",
);
const plans = createFileUpdatePlanStore("plan.json");
const mode = process.argv[2];
let result: unknown;
if (mode === "baseline")
  result = await recordComparisonBaseline(config, baseline);
else if (mode === "plan") {
  const plan = await previewUpdate(config, baseline);
  await plans.save(plan);
  result = plan.items.map((item) => [
    item.sourceKey ?? item.request?.expectedSource?.key,
    item.action,
  ]);
} else if (mode === "apply") {
  const plan = await plans.load();
  assert.ok(plan);
  validateUpdatePlan(plan);
  result = await applyUpdatePlan(
    plan as UpdatePlan<Unit, Translation, string>,
    config,
    () => process.argv[3] !== "reject",
  );
} else if (mode === "save-edit") {
  const facts = await readFacts(config);
  const source = facts.source.units.find(({ key }) => key === "A");
  const target = facts.translations.records.find(
    ({ translation }) => translation.id === "A",
  );
  assert.ok(source && target?.bodyAvailability === "available");
  const request: TranslationWriteRequest<string, Unit> = {
    operation: "write",
    target: { identity: target.identity },
    content: "人工修订 A",
    expectedSource: {
      presence: "present",
      key: source.key,
      unit: source.unit,
      content: source.unit.source,
      range: "source.json",
    },
    expectedTarget: {
      status: "present",
      identity: target.identity,
      content: target.content,
      range: "fr",
      record: target.translation,
    },
  };
  await writeFile("edit.json", JSON.stringify(request));
} else if (mode === "edit") {
  const request = await validateTranslationWriteRequest(
    JSON.parse(await readFile("edit.json", "utf8")),
    config,
  );
  result = await writeTranslationRequests([request], config);
} else if (mode === "batch-edit") {
  const facts = await readFacts(config);
  const requests: TranslationWriteRequest<string, Unit>[] = ["A", "B"].map(
    (id) => {
      const target = facts.translations.records.find(
        ({ translation }) => translation.id === id,
      );
      assert.ok(target?.bodyAvailability === "available");
      return {
        operation: "write",
        target: { identity: target.identity },
        content: `批量译文 ${id}`,
        expectedTarget: {
          status: "present",
          identity: target.identity,
          content: target.content,
          record: target.translation,
        },
      };
    },
  );
  const batchConfig = {
    ...config,
    translationWriteback: {
      ...config.translationWriteback!,
      locateExistingTarget({ translation }: LocateExistingInput) {
        return {
          status: "located" as const,
          locator: {
            file:
              translation.translation.writePath ??
              `fr/${translation.translation.id}.json`,
            key: translation.translation.id,
          },
        };
      },
      async writeBatch({ requests: writes }: BatchWriteInput) {
        const groups = new Map<string, Array<(typeof writes)[number]>>();
        for (const write of writes) {
          const locator = fileLocatorSchema.parse(write.target.locator);
          const group = groups.get(locator.file) ?? [];
          group.push(write);
          groups.set(locator.file, group);
        }
        for (const [filename, group] of groups) {
          const records = JSON.parse(
            await readFile(filename, "utf8"),
          ) as Translation[];
          for (const { request } of group) {
            if (!("identity" in request.target))
              throw new TypeError("测试写回需要现有译文身份。");
            const id = request.target.identity.key;
            const index = records.findIndex(
              (translation) => translation.id === id,
            );
            if (request.operation === "delete") records.splice(index, 1);
            else if (index === -1)
              records.push({ id, text: request.content, writePath: filename });
            else {
              const current = records[index];
              assert.ok(current);
              records[index] = { ...current, text: request.content };
            }
          }
          await writeFile(filename, JSON.stringify(records));
        }
      },
    },
  };
  result = await writeTranslationRequests(requests, batchConfig);
} else throw new Error(`未知工作流操作：${String(mode)}`);
process.stdout.write(JSON.stringify(result ?? null));
