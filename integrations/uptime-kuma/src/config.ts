import { defineConfig } from "@lioni/core";

import { createKumaAdapter, loadKumaCatalog } from "./adapter.ts";
import type { KumaFiles } from "./model.ts";
import { prepareKumaQuality } from "./quality.ts";

export { loadKumaCatalog };
export type { KumaCatalog, KumaFiles } from "./model.ts";

export function createKumaConfig(files: KumaFiles) {
  return defineConfig({
    ...createKumaAdapter(files),
    sourceToContent: (source) => ({ text: source.text }),
    quality: {
      prepare: (facts) => prepareKumaQuality(files, facts),
    },
  });
}
