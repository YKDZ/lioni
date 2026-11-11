import { rm } from "node:fs/promises";
import path from "node:path";

import {
  analyzeQuality,
  formatQualityReport,
  upsertQualityExceptionFromReport,
  type QualityRunResult,
} from "@lioni/lioni";

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
const exceptionFile = path.join(process.cwd(), "lioni.exceptions.yaml");
const cacheDirectory = path.join(process.cwd(), ".lioni");
await rm(exceptionFile, { force: true });
await rm(cacheDirectory, { recursive: true, force: true });

setSharedRevision("v1");
setSharedReadFails(false);
setTermsLoaderMode("none");

const full = await capture(() => analyzeQuality(config, { memo }));
const syntaxExecution = full.result?.checks.find(
  ({ checkId }) => checkId === "syntax",
)?.executions[0];
const exceptionStore = config.quality?.exceptionStore;
if (syntaxExecution === undefined || exceptionStore === undefined)
  throw new Error("无法从正式 QA 结果创建术语选择验收例外。");
await upsertQualityExceptionFromReport({
  report: full.result,
  checkId: "syntax",
  executionId: syntaxExecution.executionId,
  id: "approved-syntax",
  reason: "制品选择场景验证缓存与例外身份。",
  store: exceptionStore,
});

const direct = await capture(() =>
  analyzeQuality(config, { checkIds: ["syntax"], memo }),
);
const duplicateIds = await capture(() =>
  analyzeQuality(config, { checkIds: ["terms", "syntax", "terms"], memo }),
);
const groupUnion = await capture(() =>
  analyzeQuality(config, { groups: ["daily", "syntaxOnly"], memo }),
);
const termsOnly = await capture(() =>
  analyzeQuality(config, { checkIds: ["terms"], memo }),
);

const unknownId = await capture(() =>
  analyzeQuality(config, { checkIds: ["missing"] } as never),
);
const unknownGroup = await capture(() =>
  analyzeQuality(config, { groups: ["all"] } as never),
);
const emptyIds = await capture(() => analyzeQuality(config, { checkIds: [] }));
const emptyGroups = await capture(() => analyzeQuality(config, { groups: [] }));
const selectedEmptyGroup = await capture(() =>
  analyzeQuality(config, { groups: ["empty"] }),
);
const conflictingSelection = await capture(() =>
  analyzeQuality(config, { checkIds: ["syntax"], groups: ["daily"] } as never),
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
  analyzeQuality(invalidDirectoryConfig, { checkIds: ["syntax"] }),
);
const ungroupedConfig = {
  ...config,
  quality: {
    ...config.quality,
    groups: undefined,
  },
} as unknown as typeof config;
const ungroupedUnknownGroup = await capture(() =>
  analyzeQuality(ungroupedConfig, { groups: ["daily"] } as never),
);

const noProvidedCandidates = await capture(() =>
  analyzeQuality(config, { candidates: [], memo }),
);
const explicitCandidates = await capture(() =>
  analyzeQuality(config, {
    candidates: [
      { sourceKey: "save", language: "fr", content: "Enregistrer 1 fichier" },
    ],
    memo,
  }),
);

setSharedRevision("v2");
const changedDependency = await capture(() =>
  analyzeQuality(config, { checkIds: ["syntax"], memo }),
);

setSharedRevision("v3");
setTermsLoaderMode("failure");
const isolatedLoaderFailure = await capture(() =>
  analyzeQuality(config, { memo }),
);
setTermsLoaderMode("none");

setSharedRevision("v4");
setSharedReadFails(true);
const sharedLoaderFailure = await capture(() =>
  analyzeQuality(config, { memo }),
);
setSharedReadFails(false);
setTermsLoaderMode("contract-error");
const loaderContractError = await capture(() =>
  analyzeQuality(config, { memo }),
);
setTermsLoaderMode("reader-contract-error");
const readerContractError = await capture(() =>
  analyzeQuality(config, { memo }),
);
setTermsLoaderMode("none");

const evidence = {
  full,
  direct,
  duplicateIds,
  groupUnion,
  termsOnly,
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
  loaderContractError,
  readerContractError,
};

process.stdout.write(JSON.stringify(evidence));
