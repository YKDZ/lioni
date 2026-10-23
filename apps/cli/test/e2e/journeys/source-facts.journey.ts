import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import type { CliJourney } from "../journey.ts";

const journey: CliJourney = {
  name: "source-facts",
  modes: ["source", "distribution"],
  async setup({ workDir }) {
    await writeFile(
      path.join(workDir, "l10n.config.ts"),
      `export default {
  source: {
    readUnits: () => [{
      source: "Save",
      context: { file: "src/messages.ts", line: 18, screenshot: "shots/save.png" }
    }]
  },
  keyOf: (unit) => \`${"${unit.context.file}"}:${"${unit.context.line}"}\`
};
`,
    );
    await writeFile(
      path.join(workDir, "duplicate.config.ts"),
      `export default {
  source: {
    readUnits: () => [
      { source: "Save", context: { file: "src/messages.ts", line: 18 } },
      { source: "Submit", context: { file: "src/messages.ts", line: 18 } }
    ]
  },
  keyOf: (unit) => \`${"${unit.context.file}"}:${"${unit.context.line}"}\`
};
`,
    );
  },
  commands() {
    return [
      {
        name: "structured source facts",
        args: ["facts", "l10n.config.ts"],
      },
      {
        name: "readable source facts",
        args: ["facts", "l10n.config.ts", "--output-format", "text"],
      },
      {
        name: "duplicate source identity",
        args: ["facts", "duplicate.config.ts"],
      },
      { name: "help", args: ["--help"] },
      { name: "version", args: ["--version"] },
    ];
  },
  async assertions({ results }) {
    const structured = results[0];
    const readable = results[1];
    const duplicate = results[2];
    assert.equal(
      structured?.exitCode,
      0,
      `${structured?.stdout ?? ""}${structured?.stderr ?? ""}`,
    );
    assert.equal(structured?.stderr, "");
    const result = JSON.parse(structured?.stdout ?? "") as {
      data: {
        version: string;
        units: readonly {
          key: string;
          unit: {
            source: string;
            context: { file: string; line: number; screenshot: string };
          };
        }[];
      };
    };
    assert.match(result.data.version, /^sha256:[a-f0-9]{64}$/u);
    assert.deepEqual(result.data.units, [
      {
        key: "src/messages.ts:18",
        unit: {
          source: "Save",
          context: {
            file: "src/messages.ts",
            line: 18,
            screenshot: "shots/save.png",
          },
        },
      },
    ]);
    assert.equal(readable?.exitCode, 0);
    assert.equal(readable?.stderr, "");
    assert.ok(readable?.stdout.includes(result.data.version));
    assert.match(readable?.stdout ?? "", /src\/messages\.ts:18/u);
    assert.ok(readable?.stdout.includes('"source":"Save"'));
    assert.match(readable?.stdout ?? "", /shots\/save\.png/u);
    assert.equal(duplicate?.exitCode, 1);
    assert.equal(duplicate?.stdout, "");
    assert.partialDeepStrictEqual(JSON.parse(duplicate?.stderr ?? ""), {
      kind: "failure",
      variant: "duplicateIdentity",
      data: { key: "src/messages.ts:18" },
    });
    assert.equal(results[3]?.exitCode, 0);
    assert.match(results[3]?.stdout ?? "", /facts/u);
    assert.equal(results[4]?.exitCode, 0);
    assert.equal(results[4]?.stdout, "l10n 0.0.0\n");
  },
};

export default journey;
