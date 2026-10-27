import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { extractVueI18nUsages } from "@lioni/vue-i18n";
import type { VueI18nUsageIndex } from "@lioni/vue-i18n";

export async function loadKumaUsages(root: string): Promise<VueI18nUsageIndex> {
  const output: {
    entries: VueI18nUsageIndex["entries"][number][];
    unresolved: VueI18nUsageIndex["unresolved"][number][];
    errors: VueI18nUsageIndex["errors"][number][];
  } = { entries: [], unresolved: [], errors: [] };

  async function scan(directory: string): Promise<void> {
    const entries = (
      await readdir(directory, { withFileTypes: true })
    ).toSorted((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await scan(filename);
      } else if (/\.(?:vue|js|ts)$/u.test(entry.name)) {
        const usages = extractVueI18nUsages(
          await readFile(filename, "utf8"),
          path.relative(root, filename).split(path.sep).join("/"),
        );
        output.entries.push(...usages.entries);
        output.unresolved.push(...usages.unresolved);
        output.errors.push(...usages.errors);
      }
    }
  }

  await scan(path.join(root, "src"));
  return output;
}
