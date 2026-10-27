import { defineConfig } from "@lioni/core";
import { createFileQualityExceptionStore } from "@lioni/core/node";

import qaNoReadConfig from "./qa-no-read.config.ts";

export default defineConfig({
  ...qaNoReadConfig,
  qualityExceptionStore: createFileQualityExceptionStore(
    "custom.exceptions.yaml",
  ),
});
