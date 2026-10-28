import assert from "node:assert/strict";

import { analyzeQuality, readCompletion, readFacts } from "@lioni/core";

import config from "./lioni.config.ts";

const facts = await readFacts(config);
assert.equal(facts.source.units.length, 2);
assert.equal((await readCompletion(config)).completion.status, "complete");
const quality = await analyzeQuality(config);
assert.equal(quality.status, "complete");
assert.equal(quality.diagnostics.length, 1);
process.stdout.write(JSON.stringify(facts));
