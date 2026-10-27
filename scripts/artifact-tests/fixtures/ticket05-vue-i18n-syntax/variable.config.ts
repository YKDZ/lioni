import { createConfig, createVariableChecker } from "./lioni.config.ts";

export default createConfig("{name} {name}", "{name}", [
  createVariableChecker(),
]);
