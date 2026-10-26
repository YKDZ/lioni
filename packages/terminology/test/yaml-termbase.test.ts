import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  assembleTermbaseYaml,
  parseTermbaseYaml,
  TermContractError,
  TermbaseYamlError,
} from "@lioni/terminology";
import { loadTermbaseYaml } from "@lioni/terminology/node";

void describe("默认 YAML 术语库", () => {
  void it("按文件名组装语言段，并保留缺少的语言", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "lioni-termbase-"));
    try {
      await writeFile(
        path.join(directory, "concepts.yaml"),
        [
          "concepts:",
          "  server:",
          "    subjectFields: [service]",
          "    sourceRefs:",
          "      - resource: src/lang/en.json",
          "        key: Server",
          "  port: {}",
          "",
        ].join("\n"),
      );
      await writeFile(
        path.join(directory, "en.yaml"),
        [
          "concepts:",
          "  server:",
          "    expressions:",
          "      - id: server-en",
          "        text: Server",
          "        usage: preferred",
          "  port:",
          "    expressions:",
          "      - id: port-en",
          "        text: Port",
          "        usage: preferred",
          "",
        ].join("\n"),
      );
      await writeFile(
        path.join(directory, "zh-CN.yaml"),
        [
          "concepts:",
          "  server:",
          "    expressions:",
          "      - id: server-zh",
          "        text: 服务器",
          "        usage: preferred",
          "",
        ].join("\n"),
      );
      await writeFile(path.join(directory, "ja.yaml"), "");

      const termbase = await loadTermbaseYaml(directory);
      assert.equal(termbase.concepts.length, 2);
      assert.deepEqual(
        termbase
          .getConcept("server")
          ?.languages.map(({ language }) => language),
        ["en", "zh-CN"],
      );
      assert.equal(
        termbase.getExpression("server", "server-zh")?.expression.text,
        "服务器",
      );
      assert.deepEqual(termbase.getConcept("server")?.subjectFields, [
        "service",
      ]);
      assert.deepEqual(termbase.getConcept("server")?.sourceRefs, [
        { resource: "src/lang/en.json", key: "Server" },
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  void it("完整解析原型保留名对应的语言文件", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "lioni-termbase-"));
    try {
      await writeFile(
        path.join(directory, "concepts.yaml"),
        "concepts:\n  server: {}\n",
      );
      await writeFile(
        path.join(directory, "en.yaml"),
        [
          "concepts:",
          "  server:",
          "    expressions:",
          "      - id: server-en",
          "        text: Server",
          "        usage: preferred",
          "",
        ].join("\n"),
      );
      await writeFile(path.join(directory, "__proto__.yaml"), "concepts: [\n");

      await assert.rejects(
        () => loadTermbaseYaml(directory),
        (error) =>
          error instanceof TermbaseYamlError &&
          error.stage === "parse" &&
          error.issues.some((issue) => issue.file === "__proto__.yaml"),
      );

      await writeFile(
        path.join(directory, "__proto__.yaml"),
        [
          "concepts:",
          "  server:",
          "    expressions:",
          "      - id: server-proto",
          "        text: Prototype",
          "        usage: preferred",
          "",
        ].join("\n"),
      );
      const termbase = await loadTermbaseYaml(directory);
      assert.equal(
        termbase.getExpression("server", "server-proto")?.language,
        "__proto__",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  void it("特殊概念身份可合法缺少某种语言表达", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "lioni-termbase-"));
    const ids = ["constructor", "toString", "__proto__"];
    try {
      await writeFile(
        path.join(directory, "concepts.yaml"),
        [
          "concepts:",
          ...ids.map((id) => `  ${JSON.stringify(id)}: {}`),
          "",
        ].join("\n"),
      );
      await writeFile(
        path.join(directory, "en.yaml"),
        [
          "concepts:",
          ...ids.flatMap((id) => [
            `  ${JSON.stringify(id)}:`,
            "    expressions:",
            `      - id: ${JSON.stringify(`${id}-en`)}`,
            `        text: ${id}`,
            "        usage: preferred",
          ]),
          "",
        ].join("\n"),
      );
      await writeFile(path.join(directory, "ja.yaml"), "");

      const termbase = await loadTermbaseYaml(directory);

      for (const id of ids) {
        assert.deepEqual(
          termbase.getConcept(id)?.languages.map(({ language }) => language),
          ["en"],
        );
        assert.equal(termbase.getExpression(id, `${id}-en`)?.language, "en");
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  void it("拒绝语言文件引用未登记的概念", () => {
    const parsed = parseTermbaseYaml({
      concepts: "concepts:\n  known: {}\n",
      languages: {
        en: [
          "concepts:",
          "  unknown:",
          "    expressions:",
          "      - id: unknown-en",
          "        text: Unknown",
          "        usage: preferred",
          "",
        ].join("\n"),
      },
    });

    assert.throws(
      () => assembleTermbaseYaml(parsed),
      (error) =>
        error instanceof TermbaseYamlError &&
        error.stage === "assemble" &&
        error.issues.some((issue) => issue.code === "unknown-concept"),
    );
  });

  void it("拒绝在语言文件里再次声明语言", () => {
    const parsed = parseTermbaseYaml({
      concepts: "concepts:\n  server: {}\n",
      languages: {
        en: [
          "concepts:",
          "  server:",
          "    language: zh-CN",
          "    expressions:",
          "      - id: server-en",
          "        text: Server",
          "        usage: preferred",
          "",
        ].join("\n"),
      },
    });

    assert.throws(
      () => assembleTermbaseYaml(parsed),
      (error) =>
        error instanceof TermbaseYamlError &&
        error.stage === "assemble" &&
        error.issues.some((issue) => issue.code === "language-in-file"),
    );
  });

  void it("拒绝重复 YAML 键并复用原生资料校验", () => {
    assert.throws(
      () =>
        parseTermbaseYaml({
          concepts: "concepts:\n  server: {}\n  server: {}\n",
          languages: {},
        }),
      (error) =>
        error instanceof TermbaseYamlError &&
        error.stage === "parse" &&
        error.issues.length > 0,
    );

    const sameExpressionId = parseTermbaseYaml({
      concepts: "concepts:\n  server: {}\n",
      languages: {
        en: [
          "concepts:",
          "  server:",
          "    expressions:",
          "      - id: shared",
          "        text: Server",
          "        usage: preferred",
          "",
        ].join("\n"),
        fr: [
          "concepts:",
          "  server:",
          "    expressions:",
          "      - id: shared",
          "        text: Serveur",
          "        usage: preferred",
          "",
        ].join("\n"),
      },
    });
    assert.throws(
      () => assembleTermbaseYaml(sameExpressionId),
      (error) =>
        error instanceof TermContractError &&
        error.issues.some((issue) => issue.code === "duplicate-expression-id"),
    );

    const noLanguage = parseTermbaseYaml({
      concepts: "concepts:\n  server: {}\n",
      languages: {},
    });
    assert.throws(
      () => assembleTermbaseYaml(noLanguage),
      (error) =>
        error instanceof TermContractError &&
        error.issues.some((issue) => issue.code === "invalid-languages"),
    );

    const emptyExpressions = parseTermbaseYaml({
      concepts: "concepts:\n  server: {}\n",
      languages: { en: "concepts:\n  server:\n    expressions: []\n" },
    });
    assert.throws(
      () => assembleTermbaseYaml(emptyExpressions),
      (error) =>
        error instanceof TermContractError &&
        error.issues.some((issue) => issue.code === "invalid-expressions"),
    );
  });

  void it("拒绝非文本映射键且接受文本数字概念身份", () => {
    assert.throws(
      () =>
        parseTermbaseYaml({
          concepts: [
            "concepts:",
            "  1:",
            "    note: first",
            '  "1":',
            "    note: second",
            "",
          ].join("\n"),
          languages: {
            en: [
              "concepts:",
              '  "1":',
              "    expressions:",
              "      - id: numeric-en",
              "        text: Numeric",
              "        usage: preferred",
              "",
            ].join("\n"),
          },
        }),
      (error) =>
        error instanceof TermbaseYamlError &&
        error.stage === "parse" &&
        error.issues.some((issue) => issue.code === "non-string-key"),
    );

    const parsed = parseTermbaseYaml({
      concepts: ["concepts:", '  "1":', "    note: retained", ""].join("\n"),
      languages: {
        en: [
          "concepts:",
          '  "1":',
          "    expressions:",
          "      - id: numeric-en",
          "        text: Numeric",
          "        usage: preferred",
          "",
        ].join("\n"),
      },
    });
    const termbase = assembleTermbaseYaml(parsed);

    assert.equal(termbase.concepts.length, 1);
    assert.equal(termbase.getConcept("1")?.id, "1");
    assert.equal(termbase.getConcept("1")?.note, "retained");
  });
});
