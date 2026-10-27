import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  FrameworkConfig,
  StandardSchemaV1,
  TranslationIdentity,
  TranslationIdentityParts,
  TranslationWriteRequest,
  TranslationWritebackResolution,
} from "@lioni/core";

import type {
  KumaCatalog,
  KumaFiles,
  Unit,
  Translation,
  Body,
} from "./model.ts";

function parseCatalog(value: unknown): Pick<KumaCatalog, "source" | "targets"> {
  if (
    !record(value) ||
    typeof value.source !== "string" ||
    !Array.isArray(value.targets) ||
    !value.targets.length ||
    !value.targets.every((v) => typeof v === "string") ||
    new Set(value.targets).size !== value.targets.length ||
    value.targets.includes(value.source)
  ) {
    throw new Error("语言目录声明必须包含一个源语言及互不重复的目标语言。");
  }
  return { source: value.source, targets: value.targets as string[] };
}

export async function loadKumaCatalog(url: URL): Promise<KumaCatalog> {
  const parsed: unknown = JSON.parse(await readFile(url, "utf8"));
  return { url, ...parseCatalog(parsed) };
}

export function resourceUrl(catalog: KumaCatalog, language: string): URL {
  return new URL(`../${language}.json`, catalog.url);
}

export function resourceRange(root: string, url: URL): string {
  return path.relative(root, fileURLToPath(url)).split(path.sep).join("/");
}

export async function readKumaMessages(
  url: URL,
  language: string,
): Promise<Record<string, string>> {
  const value: unknown = JSON.parse(await readFile(url, "utf8"));
  if (
    !record(value) ||
    !Object.values(value).every((entry) => typeof entry === "string")
  )
    throw new Error(`${language} 的消息资源必须是字符串映射。`);
  return value as Record<string, string>;
}

const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
function schema<T>(validate: (v: unknown) => v is T): StandardSchemaV1<T, T> {
  return {
    "~standard": {
      version: 1,
      vendor: "kuma-localization",
      validate: (v) =>
        validate(v)
          ? { value: v }
          : { issues: [{ message: "Kuma 检查输入结构无效。" }] },
    },
  };
}
const sourceSchema = schema<Unit>(
  (v): v is Unit =>
    record(v) &&
    typeof v.key === "string" &&
    record(v.source) &&
    typeof v.source.text === "string",
);
const translationSchema = schema<Translation>(
  (v): v is Translation =>
    record(v) &&
    typeof v.key === "string" &&
    typeof v.text === "string" &&
    typeof v.language === "string",
);
const contentSchema = schema<Body>(
  (v): v is Body => record(v) && typeof v.text === "string",
);

/** 每次正式操作均重读 Kuma 原始 JSON；QA 资料由独立准备入口加载。 */
export function createKumaAdapter(files: KumaFiles) {
  const sourceUrl = resourceUrl(files.catalog, files.catalog.source);
  const root = fileURLToPath(files.root);
  const sourceRange = resourceRange(root, sourceUrl);
  function targetLocation(identity: TranslationIdentity) {
    if (!files.catalog.targets.includes(identity.language)) return undefined;
    const url = resourceUrl(files.catalog, identity.language);
    const range = resourceRange(root, url);
    return identity.namespace === range
      ? { url, range, language: identity.language, key: identity.key }
      : undefined;
  }
  function writerLocator(value: unknown): WriterLocator {
    if (
      !record(value) ||
      typeof value.language !== "string" ||
      typeof value.key !== "string"
    )
      throw new Error("Kuma JSON 写入目标定位无效。");
    if (!files.catalog.targets.includes(value.language))
      throw new Error(`Kuma JSON 写入目标语言未配置：${value.language}`);
    return { language: value.language, key: value.key };
  }
  async function writeRequest(
    request: TranslationWriteRequest<Body, Unit>,
    target: { readonly kind: "existing" | "create"; readonly locator: unknown },
  ): Promise<void> {
    const locator = writerLocator(target.locator);
    const url = resourceUrl(files.catalog, locator.language);
    const current = await readKumaMessages(url, locator.language);
    if (request.operation === "write") {
      if ("sourceKey" in request.target) {
        if (
          target.kind !== "create" ||
          request.target.language !== locator.language ||
          request.target.sourceKey !== locator.key ||
          request.expectedTarget.status !== "missing"
        )
          throw new Error("Kuma JSON 新建目标与请求不匹配。");
        if (Object.hasOwn(current, locator.key))
          throw new Error(`Kuma JSON 新建目标已存在：${locator.key}`);
      } else {
        const location = targetLocation(request.target.identity);
        if (
          target.kind !== "existing" ||
          location === undefined ||
          location.language !== locator.language ||
          location.key !== locator.key ||
          request.expectedTarget.status !== "present"
        )
          throw new Error("Kuma JSON 现有目标与请求不匹配。");
        if (
          !Object.hasOwn(current, locator.key) ||
          current[locator.key] !== request.expectedTarget.content.text
        )
          throw new Error(`Kuma JSON 现有目标正文已变化：${locator.key}`);
        if (
          request.expectedTarget.range !== undefined &&
          request.expectedTarget.range !== location.range
        )
          throw new Error(`Kuma JSON 现有目标范围已变化：${locator.key}`);
      }
      Object.defineProperty(current, locator.key, {
        configurable: true,
        enumerable: true,
        value: request.content.text,
        writable: true,
      });
    } else {
      const location = targetLocation(request.target.identity);
      if (
        target.kind !== "existing" ||
        location === undefined ||
        location.language !== locator.language ||
        location.key !== locator.key
      )
        throw new Error("Kuma JSON 删除目标与请求不匹配。");
      if (
        !Object.hasOwn(current, locator.key) ||
        current[locator.key] !== request.expectedTarget.content.text
      )
        throw new Error(`Kuma JSON 删除目标正文已变化：${locator.key}`);
      if (
        request.expectedTarget.range !== undefined &&
        request.expectedTarget.range !== location.range
      )
        throw new Error(`Kuma JSON 删除目标范围已变化：${locator.key}`);
      delete current[locator.key];
    }
    await writeJsonAtomically(url, current);
  }
  return {
    source: {
      schema: sourceSchema,
      read: async () => {
        const source = await readKumaMessages(sourceUrl, files.catalog.source);
        return {
          scopes: [
            {
              range: sourceRange,
              enumeration: "complete" as const,
              records: Object.entries(source).map(([key, text]) => ({
                value: { key, source: { text } },
                bodyAvailability: "available" as const,
              })),
            },
          ],
        };
      },
    },
    keyOf: ({ key }) => key,
    translations: {
      languages: [...files.catalog.targets],
      schema: translationSchema,
      contentSchema,
      contentOf: (t) => ({ text: t.text }),
      identityOf: (
        translation: Translation,
        language: string,
      ): TranslationIdentityParts => ({
        namespace: resourceRange(
          fileURLToPath(files.root),
          resourceUrl(files.catalog, language),
        ),
        key: translation.key,
      }),
      read: async (language, units) => {
        if (!files.catalog.targets.includes(language))
          throw new Error(`未配置目标语言 ${language}。`);
        const url = resourceUrl(files.catalog, language);
        const target = await readKumaMessages(url, language);
        return {
          scopes: [
            {
              range: resourceRange(fileURLToPath(files.root), url),
              covers: units.map((u) => u.key),
              enumeration: "complete" as const,
              records: Object.entries(target).map(([key, text]) => ({
                value: { key, text, language },
                bodyAvailability: "available" as const,
              })),
            },
          ],
        };
      },
      matches: (u, t) => u.key === t.key,
    },
    translationWriteback: {
      locateExistingTarget: ({ identity, translation }) => {
        const location = targetLocation(identity);
        if (
          location === undefined ||
          translation.translation.key !== identity.key ||
          translation.translation.language !== identity.language
        )
          return {
            status: "notWritable",
            reason: "Kuma JSON 目标身份与资源位置不匹配。",
          } satisfies TranslationWritebackResolution;
        return {
          status: "located",
          locator: { language: location.language, key: location.key },
        } satisfies TranslationWritebackResolution;
      },
      locateNewTarget: ({ sourceKey, sourceUnit, language }) => {
        if (
          !files.catalog.targets.includes(language) ||
          sourceUnit.key !== sourceKey
        )
          return {
            status: "notWritable",
            reason: "Kuma JSON 新建目标与源单元身份不匹配。",
          } satisfies TranslationWritebackResolution;
        return {
          status: "located",
          locator: { language, key: sourceKey },
        } satisfies TranslationWritebackResolution;
      },
      write: ({ request, target }) => writeRequest(request, target),
    },
  } satisfies Pick<
    FrameworkConfig<Unit, Translation, Body>,
    "source" | "keyOf" | "translations" | "translationWriteback"
  >;
}

type WriterLocator = { readonly language: string; readonly key: string };

async function writeJsonAtomically(
  url: URL,
  value: Readonly<Record<string, string>>,
): Promise<void> {
  const filename = fileURLToPath(url);
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 4)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    await rename(temporary, filename);
  } finally {
    await rm(temporary, { force: true });
  }
}
