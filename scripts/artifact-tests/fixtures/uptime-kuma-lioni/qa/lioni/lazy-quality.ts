import { isDeepStrictEqual } from "node:util";

import { VUE_I18N_MESSAGE_COMPILER_VERSION } from "@lioni/checks";
import {
  defineQualityCheck,
  type QualityCheckDefinition,
  type QualityCheckOutcome,
  type QualityObject,
} from "@lioni/core";

import type { KumaFacts } from "./adapter.ts";
import type { Body, Project, Translation, Unit } from "./model.ts";

type CheckDefinition = QualityCheckDefinition<
  Unit,
  Translation,
  QualityObject,
  Body,
  never
>;
type PreparedCheck = Awaited<ReturnType<CheckDefinition["prepare"]>>;
type Input = Parameters<PreparedCheck["prepareInput"]>[0];
type Loader = (facts: KumaFacts) => Promise<Project>;
type Factory = (project: Project) => readonly CheckDefinition[];

const configurations = [
  ["kuma/resource-contract", { version: 1 }, "kuma/resource-contract/v1"],
  [
    "vue-i18n/source-syntax",
    { compilerVersion: VUE_I18N_MESSAGE_COMPILER_VERSION },
    `checks.vue-i18n/source-syntax/v1+@intlify/message-compiler@${VUE_I18N_MESSAGE_COMPILER_VERSION}+kuma-source-syntax-v1`,
  ],
  [
    "vue-i18n/target-syntax",
    { compilerVersion: VUE_I18N_MESSAGE_COMPILER_VERSION },
    `checks.vue-i18n/target-syntax/v1+@intlify/message-compiler@${VUE_I18N_MESSAGE_COMPILER_VERSION}+kuma-target-syntax-v1`,
  ],
  [
    "vue-i18n/variable-correspondence",
    {
      compilerVersion: VUE_I18N_MESSAGE_COMPILER_VERSION,
      comparison: "branch-variable-count-patterns-v1",
    },
    `checks.vue-i18n/variable-correspondence/v1+@intlify/message-compiler@${VUE_I18N_MESSAGE_COMPILER_VERSION}+kuma-variable-correspondence-v1`,
  ],
  [
    "kuma/vue-message-call-arguments",
    { version: 1 },
    `kuma/vue-message-call-arguments/v1+@intlify/message-compiler@${VUE_I18N_MESSAGE_COMPILER_VERSION}+usage-scan-v1`,
  ],
  [
    "kuma/vue-message-link-target-exists",
    { version: 1 },
    `kuma/vue-message-link-target-exists/v1+@intlify/message-compiler@${VUE_I18N_MESSAGE_COMPILER_VERSION}`,
  ],
  [
    "kuma/vue-message-link-cycle",
    { version: 1 },
    `kuma/vue-message-link-cycle/v1+@intlify/message-compiler@${VUE_I18N_MESSAGE_COMPILER_VERSION}`,
  ],
  ["kuma/protected-literals", { version: 1 }, "kuma/protected-literals/v1"],
  [
    "kuma/quantities",
    { version: 1 },
    `kuma/quantities/v2+@intlify/message-compiler@${VUE_I18N_MESSAGE_COMPILER_VERSION}`,
  ],
  [
    "terminology/require-allowed-translation",
    { rules: ["require-allowed-translation"] },
    `checks.terminology-rule/v1+kuma-terminology/v2+@intlify/message-compiler@${VUE_I18N_MESSAGE_COMPILER_VERSION}`,
  ],
  [
    "terminology/reject-forbidden-translation",
    { rules: ["reject-forbidden-translation"] },
    `checks.terminology-rule/v1+kuma-terminology/v2+@intlify/message-compiler@${VUE_I18N_MESSAGE_COMPILER_VERSION}`,
  ],
  [
    "message-family-consistency",
    { limits: { maxCategories: 6, maxSourcesPerCategory: 3 } },
    `checks.message-family-consistency/v1+kuma-message-family/v2+@intlify/message-compiler@${VUE_I18N_MESSAGE_COMPILER_VERSION}`,
  ],
] as const;

const configSchema = {
  "~standard": {
    version: 1 as const,
    vendor: "kuma-localization",
    validate(value: unknown) {
      return value !== null && typeof value === "object"
        ? { value: value as { version: 1 } }
        : { issues: [{ message: "Kuma QA 配置无效。" }] };
    },
  },
};

/** 复用 Lioni 的 prepare 边界，并按本次 facts 快照共享 QA 资料。 */
export function createLazyKumaQualityChecks(
  loadProject: Loader,
  createChecks: Factory,
): CheckDefinition[] {
  const definitionsByProject = new WeakMap<
    Project,
    ReadonlyMap<string, CheckDefinition>
  >();
  const preparedByFacts = new WeakMap<
    KumaFacts,
    Map<string, Promise<PreparedCheck>>
  >();

  function definitions(project: Project): ReadonlyMap<string, CheckDefinition> {
    let value = definitionsByProject.get(project);
    if (value === undefined) {
      value = new Map(createChecks(project).map((check) => [check.id, check]));
      if (
        value.size !== configurations.length ||
        configurations.some(([id]) => !value!.has(id))
      )
        throw new Error("Kuma QA 检查器清单与按需接入声明不一致。");
      definitionsByProject.set(project, value);
    }
    return value;
  }

  return configurations.map(([id, configuration, version]) => {
    const placeholder = defineQualityCheck<
      Unit,
      Translation,
      typeof configSchema,
      QualityObject,
      Body,
      never
    >({
      id,
      version,
      configurationSchema: configSchema,
      configuration: { version: 1 },
      check: async (): Promise<QualityCheckOutcome> => ({
        status: "not-applicable",
        diagnostics: [],
        issues: [],
        coverage: {
          selected: 1,
          evaluated: 0,
          notApplicable: 1,
          incomplete: 0,
          failed: 0,
        },
      }),
    });
    return {
      ...placeholder,
      async prepare(): Promise<PreparedCheck> {
        return {
          configuration,
          version,
          async prepareInput(input: Input) {
            const facts = input.facts as KumaFacts;
            let byId = preparedByFacts.get(facts);
            if (byId === undefined) {
              byId = new Map();
              preparedByFacts.set(facts, byId);
            }
            let prepared = byId.get(id);
            if (prepared === undefined) {
              prepared = (async () => {
                const project = await loadProject(facts);
                const definition = definitions(project).get(id);
                if (definition === undefined)
                  throw new Error(`Kuma QA 缺少 ${id} 检查器。`);
                if (definition.version !== version)
                  throw new Error(`Kuma QA ${id} 实现版本与按需声明不一致。`);
                const value = await definition.prepare();
                if (
                  value.version !== version ||
                  !isDeepStrictEqual(value.configuration, configuration)
                )
                  throw new Error(`Kuma QA ${id} 配置与按需声明不一致。`);
                return value;
              })();
              byId.set(id, prepared);
            }
            return (await prepared).prepareInput(input);
          },
        };
      },
    } satisfies CheckDefinition;
  });
}
