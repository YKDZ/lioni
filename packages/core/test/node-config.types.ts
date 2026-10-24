import { readSourceFacts } from "../src/index.ts";
import { loadConfig } from "../src/node.ts";

const dynamicFacts = loadConfig("host.config.ts").then((loaded) =>
  loaded.use(async (config) => {
    const facts = await readSourceFacts(config);
    const source = facts.units[0]?.unit.source;
    // @ts-expect-error 动态加载不能承诺调用者指定的原文业务类型。
    const text: string = source;
    void text;
  }),
);

// @ts-expect-error loadConfig 不接受调用者声明的业务泛型。
void loadConfig<{ readonly source: string }>("host.config.ts");
void dynamicFacts;
