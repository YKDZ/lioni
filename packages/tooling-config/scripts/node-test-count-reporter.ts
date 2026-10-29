import * as z from "zod";

const executedTestEvent = z.object({
  type: z.enum(["test:pass", "test:fail"]),
  data: z.object({
    entryFile: z.string(),
    skip: z.unknown().optional(),
    todo: z.unknown().optional(),
    details: z.object({ type: z.literal("test") }),
  }),
});

/** 确认 Node 正式测试流至少执行一个业务用例，避免错误 glob 被误报为通过。 */
export default async function* requireExecutedTestCase(
  events: AsyncIterable<unknown>,
): AsyncGenerator<string> {
  let count = 0;
  for await (const event of events) {
    const parsed = executedTestEvent.safeParse(event);
    if (parsed.success && !parsed.data.data.skip && !parsed.data.data.todo)
      count += 1;
  }
  if (count === 0) {
    process.exitCode = 1;
    yield "没有执行任何 Node 业务测试用例；请检查测试 glob 与测试内容\n";
  }
}
