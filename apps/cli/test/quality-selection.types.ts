import { z } from "zod";

import {
  analyzeQuality,
  defineConfig,
  defineQualityCheck,
  type JsonValue,
  type QualityObject,
} from "../src/index.ts";

const sourceSchema = z.object({
  source: z.string(),
  context: z.object({ key: z.string() }),
});
const configurationSchema = z.object({ mode: z.literal("strict") });
type Unit = z.output<typeof sourceSchema>;

const checker = defineQualityCheck.withTypes<
  Unit,
  unknown,
  typeof configurationSchema,
  QualityObject,
  JsonValue
>()({
  id: "sdk/custom-check",
  version: "1",
  configurationSchema,
  configuration: { mode: "strict" },
  check: () => ({
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
  }),
});
const checkerId: "sdk/custom-check" = checker.id;
void checkerId;

const config = defineConfig.withTypes<Unit, typeof sourceSchema>()({
  source: { schema: sourceSchema, read: () => ({ scopes: [] }) },
  keyOf: (unit) => unit.context.key,
  quality: {
    checks: [checker],
    groups: { daily: ["sdk/custom-check"] },
  },
});

const selectedByGroup = analyzeQuality(config, { groups: ["daily"] });
const selectedById = analyzeQuality(config, {
  checkIds: ["sdk/custom-check"],
});
void selectedByGroup;
void selectedById;

// @ts-expect-error SDK consumers receive the same exact ID union.
analyzeQuality(config, { checkIds: ["sdk/custom-chek"] });
// @ts-expect-error SDK consumers receive the configured group-name union.
analyzeQuality(config, { groups: ["nightly"] });
