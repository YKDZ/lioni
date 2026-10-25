import type {
  TermComparisonInput,
  TermCorpusEntry,
  TermDiscoveryCorpus,
  TermbaseData,
} from "@lioni/terminology";

import {
  cfpaSelections,
  contentTypeSelection,
  kumaSelections,
} from "./manifest.ts";
import type { VerifiedSource } from "./source.ts";

type TableRow = Readonly<Record<string, string>>;

export type TextFacts = {
  readonly entries: number;
  readonly nonEmptyEntries: number;
  readonly distinctNonEmptyValues: number;
  readonly codepoints: number;
  readonly utf16Units: number;
};

export type CfpaPreparedInput = {
  readonly schemaVersion: 1;
  readonly id: "cfpa";
  readonly source: VerifiedSource;
  readonly corpora: Readonly<Record<string, TermDiscoveryCorpus>>;
  readonly comparison: TermComparisonInput;
  readonly referenceTermbase: TermbaseData;
  readonly facts: {
    readonly textByLanguage: Readonly<Record<string, TextFacts>>;
    readonly termTableRows: number;
    readonly convertedExpressionRecords: number;
    readonly semanticConceptCount: "not-evaluated";
    readonly nonEmptyEnglishChineseGroups: number;
    readonly missingChineseTargets: number;
  };
  readonly selections: typeof cfpaSelections;
  readonly contentTypes: typeof contentTypeSelection.cfpa;
};

export type KumaPreparedInput = {
  readonly schemaVersion: 1;
  readonly id: "kuma";
  readonly source: VerifiedSource;
  readonly corpora: Readonly<Record<string, TermDiscoveryCorpus>>;
  readonly facts: {
    readonly textByLanguage: Readonly<Record<string, TextFacts>>;
    readonly pairsByTarget: Readonly<
      Record<
        string,
        {
          readonly commonKeys: number;
          readonly nonEmptyPairs: number;
          readonly missingSourceKeys: number;
          readonly missingTargetValues: number;
          readonly identicalSourceTargetValues: number;
        }
      >
    >;
  };
  readonly selections: typeof kumaSelections;
  readonly contentTypes: typeof contentTypeSelection.kuma;
};

export type PreparedExternalInput = CfpaPreparedInput | KumaPreparedInput;

export type TransformedExternalInput =
  | Omit<CfpaPreparedInput, "source">
  | Omit<KumaPreparedInput, "source">;

export function transformedExternalInput(
  input: PreparedExternalInput,
): TransformedExternalInput {
  const { source: _source, ...transformed } = input;
  return transformed;
}

function parseDelimited(
  text: string,
  delimiter: string,
): readonly (readonly string[])[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') quoted = false;
      else field += character;
      continue;
    }
    if (character === '"' && field === "") quoted = true;
    else if (character === delimiter) {
      row.push(field);
      field = "";
    } else if (character === "\r" || character === "\n") {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += character;
  }
  if (quoted) throw new Error("外部 TSV 包含未结束的引号字段。");
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return Object.freeze(rows.map((record) => Object.freeze(record)));
}

function parseTsv(
  text: string,
  requiredHeaders: readonly string[],
): readonly TableRow[] {
  const [headers, ...rows] = parseDelimited(text, "\t");
  if (!headers || requiredHeaders.some((name) => !headers.includes(name)))
    throw new Error(`外部 TSV 缺少所需列：${requiredHeaders.join(", ")}`);
  const seenHeaders = new Set(headers);
  if (seenHeaders.size !== headers.length)
    throw new Error("外部 TSV 含重复表头。");
  return Object.freeze(
    rows
      .filter((row) => row.some((value) => value !== ""))
      .map((row, rowIndex) => {
        if (row.length !== headers.length)
          throw new Error(
            `外部 TSV 第 ${rowIndex + 2} 条记录列数错误：${row.length}/${headers.length}。`,
          );
        return Object.freeze(
          Object.fromEntries(
            headers.map((header, index) => [header, row[index]!]),
          ),
        );
      }),
  );
}

function codepoints(text: string): number {
  return Array.from(text).length;
}

function textFacts(entries: readonly TermCorpusEntry[]): TextFacts {
  const values = entries.map(({ fragments }) => fragments[0]?.text ?? "");
  const nonEmpty = values.filter((value) => value.trim() !== "");
  return Object.freeze({
    entries: entries.length,
    nonEmptyEntries: nonEmpty.length,
    distinctNonEmptyValues: new Set(nonEmpty).size,
    codepoints: values.reduce((sum, value) => sum + codepoints(value), 0),
    utf16Units: values.reduce((sum, value) => sum + value.length, 0),
  });
}

function decodeCfpaLineBreaks(text: string): string {
  return text.replaceAll("\\n", "\n");
}

function cfpaCorpus(
  language: string,
  rows: readonly TableRow[],
  column: string,
): TermDiscoveryCorpus {
  const seenKeys = new Set<string>();
  const entries = rows.map((row) => {
    const ref = row.key;
    if (ref === undefined || seenKeys.has(ref))
      throw new Error(`CFPA 文本快照存在空或重复 key：${String(ref)}。`);
    seenKeys.add(ref);
    const value = row[column];
    if (value === undefined) throw new Error(`CFPA 文本快照缺少列 ${column}。`);
    return Object.freeze({
      ref,
      fragments: Object.freeze([
        Object.freeze({ ref, text: decodeCfpaLineBreaks(value) }),
      ]),
    });
  });
  return Object.freeze({ language, entries: Object.freeze(entries) });
}

function cfpaTermbase(
  termRows: readonly {
    readonly file: string;
    readonly rows: readonly TableRow[];
  }[],
): { readonly data: TermbaseData; readonly expressionRecords: number } {
  const concepts = [];
  let expressionRecords = 0;
  for (const { file, rows } of termRows) {
    for (const [index, row] of rows.entries()) {
      const english = row.en;
      const chinese = row.zh;
      if (
        english === undefined ||
        english.trim() === "" ||
        chinese === undefined
      )
        throw new Error(`CFPA 术语表行缺少 en 或 zh：${file}:${index + 2}。`);
      const variants = chinese
        .split(cfpaSelections.referenceTerms.variantSeparator)
        .map((text) => text.trim());
      if (!variants.length || variants.some((text) => text === ""))
        throw new Error(`CFPA 术语表包含空译法：${file}:${index + 2}。`);
      expressionRecords += 1 + variants.length;
      concepts.push({
        id: `${file}:${index + 2}`,
        metadata: {
          sourceTable: file,
          sourceComment: row.comment ?? "",
          sourceReason: row.reason ?? "",
          usageAssumption: "allowed-for-open-reference-coverage-only",
        },
        sourceRefs: [{ file, row: index + 2 }],
        languages: [
          {
            language: "en",
            expressions: [
              { id: "en", text: english, usage: "allowed" as const },
            ],
          },
          {
            language: "zh-CN",
            expressions: variants.map((text, variantIndex) => ({
              id: `zh-${variantIndex}`,
              text,
              usage: "allowed" as const,
            })),
          },
        ],
      });
    }
  }
  return {
    data: Object.freeze({
      metadata: {
        source: "CFPAOrg/Glossary fixed English/Chinese open reference tables",
        usageAssumption:
          "all mapped to allowed; not a gold label or project policy",
      },
      concepts: Object.freeze(concepts),
    }),
    expressionRecords,
  };
}

export async function convertCfpaSource(
  source: VerifiedSource,
  readText: (relativePath: string) => Promise<string>,
): Promise<CfpaPreparedInput> {
  const textRows = parseTsv(await readText("Vanilla/latest.tsv"), [
    "key",
    ...Object.values(cfpaSelections.text.columns),
  ]);
  if (textRows.length !== 8559)
    throw new Error(
      `CFPA 固定文本行数不符：期望 8559，实际 ${textRows.length}。`,
    );
  const corpora = Object.fromEntries(
    Object.entries(cfpaSelections.text.columns).map(([language, column]) => [
      language,
      cfpaCorpus(language, textRows, column),
    ]),
  );
  const textByLanguage = Object.fromEntries(
    Object.entries(corpora).map(([language, corpus]) => [
      language,
      textFacts(corpus.entries),
    ]),
  );

  const termFiles = cfpaSelections.referenceTerms.files;
  const termRows = await Promise.all(
    termFiles.map(async (file) => ({
      file,
      rows: parseTsv(await readText(file), ["en", "zh", "reason", "comment"]),
    })),
  );
  const { data: referenceTermbase, expressionRecords } = cfpaTermbase(termRows);
  const comparisonGroups = textRows.flatMap((row) => {
    const sourceText = row.en_us;
    const targetText = row.zh_cn;
    const key = row.key;
    if (
      sourceText === undefined ||
      sourceText.trim() === "" ||
      key === undefined
    )
      return [];
    const targetAvailable =
      targetText !== undefined && targetText.trim() !== "";
    return [
      {
        ref: key,
        source: {
          language: "en",
          fragments: [{ ref: key, text: decodeCfpaLineBreaks(sourceText) }],
        },
        target: {
          language: "zh-CN",
          fragments: targetAvailable
            ? [{ ref: key, text: decodeCfpaLineBreaks(targetText) }]
            : [],
          ...(targetAvailable ? {} : { complete: false }),
        },
      },
    ];
  });
  const missingChineseTargets = comparisonGroups.filter(
    ({ target }) => target.complete === false,
  ).length;
  return Object.freeze({
    schemaVersion: 1,
    id: "cfpa",
    source,
    corpora: Object.freeze(corpora),
    comparison: Object.freeze({ groups: Object.freeze(comparisonGroups) }),
    referenceTermbase,
    facts: Object.freeze({
      textByLanguage: Object.freeze(textByLanguage),
      termTableRows: termRows.reduce((sum, file) => sum + file.rows.length, 0),
      convertedExpressionRecords: expressionRecords,
      semanticConceptCount: "not-evaluated",
      nonEmptyEnglishChineseGroups:
        comparisonGroups.length - missingChineseTargets,
      missingChineseTargets,
    }),
    selections: cfpaSelections,
    contentTypes: contentTypeSelection.cfpa,
  });
}

const expectedKumaKeyCounts = Object.freeze({
  en: 1631,
  "zh-CN": 1738,
  "zh-TW": 1264,
  ja: 1297,
});

export async function convertKumaSource(
  source: VerifiedSource,
  readText: (relativePath: string) => Promise<string>,
): Promise<KumaPreparedInput> {
  const parsed = Object.fromEntries(
    await Promise.all(
      Object.entries(kumaSelections.locales).map(
        async ([language, filename]) => {
          const value: unknown = JSON.parse(await readText(filename));
          if (
            typeof value !== "object" ||
            value === null ||
            Array.isArray(value)
          )
            throw new Error(`Kuma ${language} 资源必须是平面 JSON 对象。`);
          const strings = Object.entries(value).map(([key, text]) => {
            if (typeof text !== "string")
              throw new Error(`Kuma ${language} 资源值不是字符串：${key}。`);
            return [key, text] as const;
          });
          if (
            strings.length !==
            expectedKumaKeyCounts[
              language as keyof typeof expectedKumaKeyCounts
            ]
          )
            throw new Error(
              `Kuma ${language} key 数不符：期望 ${expectedKumaKeyCounts[language as keyof typeof expectedKumaKeyCounts]}，实际 ${strings.length}。`,
            );
          return [language, Object.freeze(strings)];
        },
      ),
    ),
  ) as Record<string, readonly (readonly [string, string])[]>;
  const corpora = Object.fromEntries(
    Object.entries(parsed).map(([language, rows]) => [
      language,
      Object.freeze({
        language,
        entries: Object.freeze(
          rows.map(([ref, text]) =>
            Object.freeze({
              ref,
              fragments: Object.freeze([Object.freeze({ ref, text })]),
            }),
          ),
        ),
      }),
    ]),
  );
  const textByLanguage = Object.fromEntries(
    Object.entries(corpora).map(([language, corpus]) => [
      language,
      textFacts(corpus.entries),
    ]),
  );
  const english = new Map(parsed.en);
  const pairsByTarget = Object.fromEntries(
    Object.entries(parsed)
      .filter(([language]) => language !== "en")
      .map(([language, rows]) => {
        const target = new Map(rows);
        const commonKeys = [
          ...new Set([...english.keys(), ...target.keys()]),
        ].filter((key) => english.has(key) && target.has(key));
        const nonEmptyPairs = commonKeys.filter(
          (key) => english.get(key)?.trim() && target.get(key)?.trim(),
        );
        const identicalSourceTargetValues = nonEmptyPairs.filter(
          (key) => english.get(key) === target.get(key),
        ).length;
        return [
          language,
          Object.freeze({
            commonKeys: commonKeys.length,
            nonEmptyPairs: nonEmptyPairs.length,
            missingSourceKeys: rows.filter(([key]) => !english.has(key)).length,
            missingTargetValues: commonKeys.filter(
              (key) => !target.get(key)?.trim(),
            ).length,
            identicalSourceTargetValues,
          }),
        ];
      }),
  );
  return Object.freeze({
    schemaVersion: 1,
    id: "kuma",
    source,
    corpora: Object.freeze(corpora),
    facts: Object.freeze({
      textByLanguage: Object.freeze(textByLanguage),
      pairsByTarget: Object.freeze(pairsByTarget),
    }),
    selections: kumaSelections,
    contentTypes: contentTypeSelection.kuma,
  });
}
