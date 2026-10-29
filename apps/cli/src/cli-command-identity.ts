import * as z from "zod";

export type CliCommandIdentity = {
  readonly commandName: string;
  readonly version: string;
};

const commandNameSchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u,
    "命令名必须由小写 ASCII 字母、数字和单个连字符组成，并以字母开头。",
  );
const manifestSchema = z.object({
  bin: z
    .record(z.string(), z.literal("./dist/cli.js"))
    .refine(
      (bin) => Object.keys(bin).length === 1,
      "CLI 包必须恰好声明一个命令。",
    ),
  version: z.string().min(1).default("unpublished"),
});

export function validateCliCommandName(
  commandName: string,
  occupiedCommandNames: readonly string[] = [],
): string {
  const parsed = commandNameSchema.safeParse(commandName);
  if (!parsed.success) throw new TypeError(parsed.error.issues[0]!.message);
  if (occupiedCommandNames.includes(commandName)) {
    throw new Error(`CLI 命令名已被其他工作区包使用：${commandName}`);
  }
  return parsed.data;
}

export function cliCommandIdentity(
  manifest: unknown,
  occupiedCommandNames: readonly string[] = [],
): CliCommandIdentity {
  const parsed = manifestSchema.safeParse(manifest);
  if (!parsed.success) {
    throw new TypeError(
      parsed.error.issues
        .map(({ path, message }) => `${path.join(".")}: ${message}`)
        .join("；"),
    );
  }
  const [commandName] = Object.keys(parsed.data.bin);
  return {
    commandName: validateCliCommandName(commandName!, occupiedCommandNames),
    version: parsed.data.version,
  };
}
