import { rm } from "node:fs/promises";
import path from "node:path";

import {
  runQa,
  defineChecker,
  formatQualityReport,
  upsertQaSuppressionFromReport,
  type QualityRunResult,
} from "@lioni/lioni";
import * as z from "zod";

import config from "./lioni.config.ts";
import {
  readEvents,
  resetEvents,
  setSharedReadFails,
  setSharedRevision,
  setTermsLoaderMode,
} from "./state.ts";

type Capture<T> = {
  readonly result?: T;
  readonly report?: string;
  readonly error?: string;
  readonly events: readonly string[];
};

async function capture<T extends QualityRunResult>(
  operation: () => Promise<T>,
): Promise<Capture<T>> {
  resetEvents();
  try {
    const result = await operation();
    return {
      result,
      report: formatQualityReport(result),
      events: readEvents(),
    };
  } catch (error) {
    return {
      error:
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error),
      events: readEvents(),
    };
  }
}

function createLongLivedMemo() {
  const operations = new Map<
    object,
    { readonly keys: readonly unknown[]; readonly value: unknown }[]
  >();
  return {
    memo<TArguments extends readonly unknown[], TValue>(
      operation: (...args: TArguments) => TValue,
      options: {
        readonly key?: (...args: TArguments) => readonly unknown[];
      } = {},
    ): (...args: TArguments) => TValue {
      let entries = operations.get(operation);
      if (entries === undefined) {
        entries = [];
        operations.set(operation, entries);
      }
      const cache = entries;
      const keyOf = options.key ?? ((...args: TArguments) => args);
      return (...args) => {
        const keys = keyOf(...args);
        const hit = cache.find(
          (entry) =>
            entry.keys.length === keys.length &&
            entry.keys.every((key, index) => Object.is(key, keys[index])),
        );
        if (hit !== undefined) return hit.value as TValue;
        const value = operation(...args);
        cache.push({ keys, value });
        return value;
      };
    },
    dispose() {
      operations.clear();
    },
  };
}

const memo = createLongLivedMemo();
const suppressionFile = path.join(process.cwd(), "lioni.suppressions.yaml");
const cacheDirectory = path.join(process.cwd(), ".lioni");
await rm(suppressionFile, { force: true });
await rm(cacheDirectory, { recursive: true, force: true });

setSharedRevision("v1");
setSharedReadFails(false);
setTermsLoaderMode("none");

const full = await capture(() => runQa(config, { memo }));
const syntaxExecution = full.result?.checks.find(
  ({ checkId }) => checkId === "syntax",
)?.executions[0];
const suppressionStore = config.quality?.suppressionStore;
if (syntaxExecution === undefined || suppressionStore === undefined)
  throw new Error("无法从正式 QA 结果创建术语选择验收豁免。");
await upsertQaSuppressionFromReport({
  report: full.result,
  checkId: "syntax",
  executionId: syntaxExecution.executionId,
  id: "approved-syntax",
  reason: "制品选择场景验证缓存与豁免身份。",
  store: suppressionStore,
});

const direct = await capture(() =>
  runQa(config, { checkIds: ["syntax"], memo }),
);
const duplicateIds = await capture(() =>
  runQa(config, { checkIds: ["terms", "syntax", "terms"], memo }),
);
const groupUnion = await capture(() =>
  runQa(config, { groups: ["daily", "syntaxOnly"], memo }),
);
const termsOnly = await capture(() =>
  runQa(config, { checkIds: ["terms"], memo }),
);

const unknownId = await capture(() =>
  runQa(config, { checkIds: ["missing"] } as never),
);
const unknownGroup = await capture(() =>
  runQa(config, { groups: ["all"] } as never),
);
const emptyIds = await capture(() => runQa(config, { checkIds: [] }));
const emptyGroups = await capture(() => runQa(config, { groups: [] }));
const selectedEmptyGroup = await capture(() =>
  runQa(config, { groups: ["empty"] }),
);
const conflictingSelection = await capture(() =>
  runQa(config, { checkIds: ["syntax"], groups: ["daily"] } as never),
);
const invalidDirectoryConfig = {
  ...config,
  quality: {
    ...config.quality,
    groups: {
      ...config.quality?.groups,
      invalid: ["missing"],
    },
  },
} as unknown as typeof config;
const invalidDirectory = await capture(() =>
  runQa(invalidDirectoryConfig, { checkIds: ["syntax"] }),
);
const ungroupedConfig = {
  ...config,
  quality: {
    ...config.quality,
    groups: undefined,
  },
} as unknown as typeof config;
const ungroupedUnknownGroup = await capture(() =>
  runQa(ungroupedConfig, { groups: ["daily"] } as never),
);

const noProvidedCandidates = await capture(() =>
  runQa(config, { candidates: [], memo }),
);
const explicitCandidates = await capture(() =>
  runQa(config, {
    candidates: [
      { sourceKey: "save", language: "fr", content: "Enregistrer 1 fichier" },
    ],
    memo,
  }),
);

setSharedRevision("v2");
const changedDependency = await capture(() =>
  runQa(config, { checkIds: ["syntax"], memo }),
);

setSharedRevision("v3");
setTermsLoaderMode("failure");
const isolatedLoaderFailure = await capture(() => runQa(config, { memo }));
setTermsLoaderMode("none");

setSharedRevision("v4");
setSharedReadFails(true);
const sharedLoaderFailure = await capture(() => runQa(config, { memo }));
setSharedReadFails(false);
setTermsLoaderMode("reader-contract-error");
const readerContractError = await capture(() => runQa(config, { memo }));
setTermsLoaderMode("none");
setSharedRevision("v1");

const withCleanExecutions = await capture(() =>
  runQa(config, { includeCleanExecutions: true, memo }),
);
const explicitAllChecks = await capture(() =>
  runQa(config, { checkIds: ["unlisted", "terms", "syntax"], memo }),
);
const groupedAllConfig = {
  ...config,
  quality: {
    ...config.quality,
    groups: {
      daily: ["terms", "syntax"] as const,
      syntaxOnly: ["syntax"] as const,
      empty: [] as const,
      rest: ["unlisted"] as const,
    },
  },
};
const groupedAllChecks = await capture(() =>
  runQa(groupedAllConfig, { groups: ["daily", "rest"], memo }),
);

const translations = config.translations;
if (translations === undefined)
  throw new Error("check-selection 配置缺少 translations 适配器。");

const incompleteTranslationRead = await capture(() =>
  runQa({
    ...config,
    translations: {
      ...translations,
      read: (_language, sourceUnits) => ({
        scopes: [
          {
            range: "partial-fr.json",
            enumeration: "partial",
            covers: sourceUnits.map(({ key }) => key),
            records: [],
          },
        ],
      }),
    },
  }),
);

const prepareFailure = await capture(() =>
  runQa({
    ...config,
    quality: {
      checks: [
        defineChecker({
          id: "prepare-boom",
          version: "1",
          inputSchema: z.string(),
          prepare() {
            throw new Error("准备阶段缺材料");
          },
          check: () => [],
        }),
      ],
    },
  }),
);

const checkFailure = await capture(() =>
  runQa({
    ...config,
    quality: {
      checks: [
        defineChecker({
          id: "check-boom",
          version: "1",
          inputSchema: z.string(),
          prepare: ({ association }) => association.sourceKey,
          check() {
            throw new Error("执行阶段崩溃");
          },
        }),
      ],
    },
  }),
);

const evidence = {
  full,
  direct,
  duplicateIds,
  groupUnion,
  termsOnly,
  withCleanExecutions,
  explicitAllChecks,
  groupedAllChecks,
  incompleteTranslationRead,
  prepareFailure,
  checkFailure,
  invalidSelections: {
    unknownId,
    unknownGroup,
    emptyIds,
    emptyGroups,
    selectedEmptyGroup,
    conflictingSelection,
    invalidDirectory,
    ungroupedUnknownGroup,
  },
  candidates: {
    noProvidedCandidates,
    explicitCandidates,
  },
  changedDependency,
  isolatedLoaderFailure,
  sharedLoaderFailure,
  readerContractError,
};

process.stdout.write(JSON.stringify(evidence));
