import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  FrameworkConfig,
  FrameworkFacts,
  StandardSchemaV1,
  TranslationIdentityParts,
} from "@lioni/core";
import { loadTermbaseYaml } from "@lioni/terminology/node";

import type {
  Unit,
  Translation,
  Body,
  Policy,
  Project,
  LanguageMetadata,
  MessagePolicy,
} from "./model.ts";
import { scanUsages } from "./usages.ts";

type InputFile = {
  url: URL;
  range: string;
  kind: "catalog" | "messages" | "metadata" | "policy";
  language?: string;
  raw: string;
};
export type KumaCatalog = {
  url: URL;
  raw: string;
  source: string;
  targets: readonly string[];
};
export type KumaFiles = { root: URL; catalog: KumaCatalog };
export type KumaFacts = FrameworkFacts<Unit, Translation, Body, never>;

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
  const raw = await readFile(url, "utf8");
  const parsed: unknown = JSON.parse(raw);
  return { url, raw, ...parseCatalog(parsed) };
}

function resourceUrl(catalog: KumaCatalog, language: string): URL {
  return new URL(`../${language}.json`, catalog.url);
}

function resourceRange(root: string, url: URL): string {
  return path.relative(root, fileURLToPath(url)).split(path.sep).join("/");
}

async function readResource(
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

/** 术语、元数据和调用点只在 QA 准备时加载；快照事实可直接作为本次资源输入。 */
export async function loadKumaQaProject(files: KumaFiles, facts?: KumaFacts) {
  const root = fileURLToPath(files.root);
  const inputs: InputFile[] = [];
  async function read(
    url: URL,
    kind: InputFile["kind"],
    language?: string,
  ): Promise<unknown> {
    const raw = await readFile(url, "utf8");
    inputs.push({
      url,
      range: path.relative(root, fileURLToPath(url)),
      kind,
      raw,
      ...(language === undefined ? {} : { language }),
    });
    return JSON.parse(raw);
  }
  inputs.push({
    url: files.catalog.url,
    range: resourceRange(root, files.catalog.url),
    kind: "catalog",
    raw: files.catalog.raw,
  });
  const { source: sourceLanguage, targets: targetLanguages } = files.catalog;
  const languages = [sourceLanguage, ...targetLanguages];
  const factTexts = new Map<string, Record<string, string>>();
  if (facts !== undefined) {
    const sourceTexts = Object.fromEntries(
      facts.source.units.map(({ key, unit }) => [key, unit.source.text]),
    );
    factTexts.set(sourceLanguage, sourceTexts);
    for (const language of targetLanguages) factTexts.set(language, {});
    for (const fact of facts.translations.records) {
      if (fact.bodyAvailability !== "available") continue;
      const texts = factTexts.get(fact.language);
      if (texts !== undefined) texts[fact.translation.key] = fact.content.text;
    }
  }
  const resources = new Map<
    string,
    { texts: Record<string, string>; range: string; metadata: LanguageMetadata }
  >();
  for (const language of languages) {
    const url = resourceUrl(files.catalog, language);
    const value =
      factTexts.get(language) ?? (await read(url, "messages", language));
    if (
      !record(value) ||
      !Object.values(value).every((entry) => typeof entry === "string")
    )
      throw new Error(`${language} 的消息资源必须是字符串映射。`);
    const texts = value as Record<string, string>;
    const metadata = await read(
      new URL(`./${language}.json`, files.catalog.url),
      "metadata",
      language,
    );
    if (!record(metadata))
      throw new Error(`${language} 的语言声明必须是对象。`);
    resources.set(language, {
      texts,
      range: resourceRange(root, url),
      metadata: metadata as LanguageMetadata,
    });
  }
  const shared = (await read(
    new URL("./messages.json", files.catalog.url),
    "policy",
  )) as MessagePolicy;
  if (
    !shared ||
    !record(shared.literals) ||
    !Array.isArray(shared.scopes) ||
    !Array.isArray(shared.usageScopes)
  )
    throw new Error("消息策略必须声明技术字面值、消息范围和调用点范围。");
  const terms = (
    await loadTermbaseYaml(new URL("./termbase/", files.catalog.url))
  ).data;
  const usages = await scanUsages(root);
  const source = resources.get(sourceLanguage)!;
  const policies: Policy[] = targetLanguages.map((targetLanguage) => {
    const target = resources.get(targetLanguage)!;
    return {
      ...shared,
      sourceLanguage,
      targetLanguage,
      sourceRange: source.range,
      targetRange: target.range,
      source: source.texts,
      target: target.texts,
      terms,
      usages,
      reviews: target.metadata.reviews ?? {},
      targetEquivalences: target.metadata.equivalences ?? [],
      ...(source.metadata.quantityProfile === undefined
        ? {}
        : { sourceQuantityProfile: source.metadata.quantityProfile }),
      ...(target.metadata.quantityProfile === undefined
        ? {}
        : { targetQuantityProfile: target.metadata.quantityProfile }),
      quantityUnitAliases: source.metadata.quantityUnitAliases ?? {},
      targetQuantityUnitAliases: target.metadata.quantityUnitAliases ?? {},
      quantityDefaultUnits: source.metadata.quantityDefaultUnits ?? {},
      targetQuantityDefaultUnits: target.metadata.quantityDefaultUnits ?? {},
      sourceQuantityIgnoredLiterals:
        source.metadata.quantityIgnoredLiterals ?? {},
      targetQuantityIgnoredLiterals:
        target.metadata.quantityIgnoredLiterals ?? {},
    };
  });
  return {
    policies,
    terms,
    usages,
    root,
    inputs,
    catalog: files.catalog.url,
  } satisfies Project & {
    root: string;
    inputs: InputFile[];
    catalog: URL;
  };
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
  (v): v is Body =>
    record(v) &&
    typeof v.text === "string" &&
    typeof v.language === "string" &&
    typeof v.resourceKey === "string",
);

/** 每次正式操作均重读 Kuma 原始 JSON；QA 资料由独立准备入口加载。 */
export function createKumaAdapter(files: KumaFiles) {
  const sourceUrl = resourceUrl(files.catalog, files.catalog.source);
  const sourceRange = resourceRange(fileURLToPath(files.root), sourceUrl);
  return {
    source: {
      schema: sourceSchema,
      read: async () => {
        const source = await readResource(sourceUrl, files.catalog.source);
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
      contentOf: (t) => ({
        text: t.text,
        language: t.language,
        resourceKey: t.key,
      }),
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
        const target = await readResource(url, language);
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
  } satisfies Pick<
    FrameworkConfig<Unit, Translation, Body>,
    "source" | "keyOf" | "translations"
  >;
}

export function createKumaQualityRequest(project: Project, facts: KumaFacts) {
  const sourceTexts = new Map(
    facts.source.units.map(({ key, unit }) => [key, unit.source.text]),
  );
  const targetTexts = new Map(
    facts.translations.records.flatMap((fact) =>
      fact.bodyAvailability === "available"
        ? [
            [
              `${fact.language}\u0000${fact.translation.key}`,
              fact.content.text,
            ] as const,
          ]
        : [],
    ),
  );
  return {
    candidates: project.policies.flatMap((policy) =>
      [
        ...new Set([
          ...sourceTexts.keys(),
          ...Object.keys(policy.target),
          ...project.usages.entries.map((usage) => usage.key),
        ]),
      ].map((key) => ({
        sourceKey: key,
        language: policy.targetLanguage,
        content: {
          text: targetTexts.get(`${policy.targetLanguage}\u0000${key}`) ?? "",
          language: policy.targetLanguage,
          resourceKey: key,
        },
      })),
    ),
    dependencies: {},
  };
}
