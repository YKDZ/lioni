import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    cli: "src/cli.ts",
    index: "src/index.ts",
    node: "src/node.ts",
  },
  format: "esm",
  target: "node26",
  fixedExtension: false,
  dts: { build: true },
  clean: true,
  failOnWarn: true,
  deps: {
    alwaysBundle: [/^@lioni\//u],
    dts: { alwaysBundle: [/^@lioni\//u] },
  },
});
