import { isMap, isPair, isScalar, isSeq, parseDocument } from "yaml";
import { z } from "zod";

import { createTermbase, type Termbase } from "./data.ts";

export type TermbaseYamlFiles = {
  readonly concepts: string;
  readonly languages: Readonly<Record<string, string>>;
};

export type TermbaseYamlIssue = {
  readonly code: string;
  readonly file: string;
  readonly message: string;
};

export class TermbaseYamlError extends TypeError {
  readonly stage: "parse" | "validation";
  readonly issues: readonly TermbaseYamlIssue[];

  constructor(
    stage: TermbaseYamlError["stage"],
    issues: readonly TermbaseYamlIssue[],
    options?: ErrorOptions,
  ) {
    super(issues.map(({ message }) => message).join("；"), options);
    this.name = "TermbaseYamlError";
    this.stage = stage;
    this.issues = Object.freeze([...issues]);
  }
}

/** 在内存中解析概念与语言 YAML，并返回经过领域校验的术语库。 */
export function parseTermbaseYaml(files: TermbaseYamlFiles): Termbase {
  const concepts = parseMapping(files.concepts, "concepts.yaml");
  const languages = Object.fromEntries(
    Object.entries(files.languages).map(([language, contents]) => [
      language,
      parseMapping(contents, `${language}.yaml`, true),
    ]),
  );
  const parsed = { concepts, languages };
  const unknownConcepts = Object.entries(parsed.languages).flatMap(
    ([language, declarations]) =>
      Object.keys(declarations)
        .filter((id) => !Object.hasOwn(parsed.concepts, id))
        .map((id) => ({
          code: "unknown-concept",
          file: `${language}.yaml`,
          message: `${language}.yaml 引用了未在 concepts.yaml 登记的概念：${id}。`,
        })),
  );
  const declaredLanguages = Object.entries(parsed.languages).flatMap(
    ([language, declarations]) =>
      Object.entries(declarations)
        .filter(([, declaration]) => Object.hasOwn(declaration, "language"))
        .map(([id]) => ({
          code: "language-in-file",
          file: `${language}.yaml`,
          message: `${language}.yaml 中的概念 ${id} 不得重复声明语言；语言由文件名确定。`,
        })),
  );
  const assemblyIssues = [...unknownConcepts, ...declaredLanguages];
  if (assemblyIssues.length)
    throw new TermbaseYamlError("validation", assemblyIssues);

  const assembledConcepts = Object.entries(parsed.concepts).map(
    ([id, metadata]) => {
      const languages = Object.entries(parsed.languages).flatMap(
        ([language, declarations]) => {
          if (!Object.hasOwn(declarations, id)) return [];
          const declaration = declarations[id]!;
          return [{ ...declaration, language }];
        },
      );
      return { ...metadata, id, languages };
    },
  );
  return createTermbase({ concepts: assembledConcepts });
}

const mappingSchema = z.record(z.string(), z.unknown());
const documentSchema = z.object({ concepts: mappingSchema });
const declarationsSchema = z.array(z.tuple([z.string(), mappingSchema]));

function parseMapping(
  contents: string,
  file: string,
  emptyAllowed = false,
): Readonly<Record<string, Record<string, unknown>>> {
  const document = parseDocument(contents, {
    uniqueKeys: true,
    version: "1.2",
    schema: "core",
  });
  if (document.errors.length > 0)
    throw new TermbaseYamlError(
      "parse",
      document.errors.map((error) => ({
        code: error.code,
        file,
        message: `${file}：${error.message}`,
      })),
    );
  if (emptyAllowed && document.contents === null) return {};
  rejectNonStringMappingKeys(document.contents, file);
  const value: unknown = document.toJS({ maxAliasCount: 100 });
  if (
    emptyAllowed &&
    mappingSchema.safeParse(value).success &&
    Object.keys(value as object).length === 0
  )
    return {};
  const result = documentSchema.safeParse(value);
  if (!result.success)
    throw new TermbaseYamlError(
      "parse",
      result.error.issues.map((issue) => ({
        code: "invalid-document",
        file,
        message: `${file} ${issue.path.join(".")}：${issue.message}`,
      })),
    );
  // 按原始键值项验证，避免 record 跳过 __proto__ 对应的声明。
  const concepts = (value as z.infer<typeof documentSchema>).concepts;
  const entries = Object.entries(concepts);
  const declarations = declarationsSchema.safeParse(entries);
  if (!declarations.success)
    throw new TermbaseYamlError(
      "parse",
      declarations.error.issues.map((issue) => ({
        code: "invalid-declaration",
        file,
        message: `${file} concepts.${entries[Number(issue.path[0])]?.[0] ?? String(issue.path[0])}：${issue.message}`,
      })),
    );
  return concepts as Record<string, Record<string, unknown>>;
}

function rejectNonStringMappingKeys(node: unknown, file: string): void {
  if (isMap(node)) {
    for (const pair of node.items) {
      rejectMappingKey(pair.key, file);
      rejectNonStringMappingKeys(pair.value, file);
    }
    return;
  }
  if (isSeq(node)) {
    for (const item of node.items) rejectNonStringMappingKeys(item, file);
    return;
  }
  if (isPair(node)) {
    rejectMappingKey(node.key, file);
    rejectNonStringMappingKeys(node.value, file);
  }
}

function rejectMappingKey(key: unknown, file: string): void {
  if (isScalar(key) && typeof key.value === "string") return;
  throw new TermbaseYamlError("parse", [
    {
      code: "non-string-key",
      file,
      message: `${file} 中的映射键必须是文本。`,
    },
  ]);
}
