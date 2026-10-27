import { defineConfig } from "@lioni/core";
import { createFileQualityExceptionStore } from "@lioni/core/node";

import qaConfig from "./qa.config.ts";

export default defineConfig({
  ...qaConfig,
  qualityExceptionStore: createFileQualityExceptionStore(
    "custom.exceptions.yaml",
  ),
});
