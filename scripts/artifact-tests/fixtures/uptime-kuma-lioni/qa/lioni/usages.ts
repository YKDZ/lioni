import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { parse as parseScript, parseExpression } from "@babel/parser";
import { baseParse } from "@vue/compiler-dom";
import { parse as parseSfc } from "@vue/compiler-sfc";

import type { Usage, UsageIndex } from "./model.ts";
type Node = { type: string | number; [key: string]: unknown };
const node = (v: unknown): v is Node =>
  v !== null && typeof v === "object" && "type" in v;
function walk(value: unknown, visit: (n: Node) => void): void {
  if (Array.isArray(value)) {
    for (const v of value) walk(v, visit);
    return;
  }
  if (!node(value)) return;
  visit(value);
  for (const [key, child] of Object.entries(value))
    if (!["loc", "tokens", "comments", "errors"].includes(key))
      walk(child, visit);
}
function literal(v: unknown): string | undefined {
  if (!node(v)) return undefined;
  if (v.type === "StringLiteral") return String(v.value);
  if (
    v.type === "TemplateLiteral" &&
    Array.isArray(v.expressions) &&
    v.expressions.length === 0 &&
    Array.isArray(v.quasis)
  )
    return String((v.quasis[0] as { value: { cooked: string } }).value.cooked);
  return undefined;
}
function name(v: unknown): string | undefined {
  return node(v) && v.type === "Identifier" ? String(v.name) : literal(v);
}
function supplied(args: readonly unknown[]): {
  supplied: string[];
  parametersKnown: boolean;
} {
  const result: string[] = [];
  let known = true;
  for (const arg of args) {
    if (!node(arg)) {
      known = false;
      continue;
    }
    if (arg.type === "NumericLiteral") {
      result.push("plural", "named:n", "named:count");
      continue;
    }
    if (arg.type === "ArrayExpression" && Array.isArray(arg.elements)) {
      arg.elements.forEach((item, i) => {
        if (node(item) && item.type === "SpreadElement") known = false;
        else result.push(`list:${i}`);
      });
      continue;
    }
    if (arg.type !== "ObjectExpression" || !Array.isArray(arg.properties)) {
      known = false;
      continue;
    }
    for (const property of arg.properties) {
      if (
        !node(property) ||
        property.type !== "ObjectProperty" ||
        property.computed
      ) {
        known = false;
        continue;
      }
      const key = name(property.key);
      if (!key) {
        known = false;
        continue;
      }
      if (
        key === "named" &&
        node(property.value) &&
        property.value.type === "ObjectExpression"
      ) {
        const nested = supplied([property.value]);
        result.push(...nested.supplied);
        known &&= nested.parametersKnown;
      } else if (
        key === "list" &&
        node(property.value) &&
        property.value.type === "ArrayExpression"
      ) {
        const nested = supplied([property.value]);
        result.push(...nested.supplied);
        known &&= nested.parametersKnown;
      } else if (key === "plural") {
        if (numericPlural(property.value))
          result.push("plural", "named:n", "named:count");
        else known = false;
      } else result.push(`named:${key}`);
    }
  }
  return { supplied: [...new Set(result)], parametersKnown: known };
}
function numericPlural(value: unknown): boolean {
  if (!node(value)) return false;
  if (value.type === "NumericLiteral") return true;
  return value.type === "StringLiteral" && Number.isFinite(Number(value.value));
}
function numericPluralExpression(expression: unknown): boolean {
  return (
    node(expression) &&
    typeof expression.content === "string" &&
    (() => {
      try {
        return numericPlural(
          parseExpression(expression.content, { plugins: ["typescript"] }),
        );
      } catch {
        return false;
      }
    })()
  );
}
/** 从真正的 JS/Vue AST 提取静态调用；动态键与解析限制单独留证。 */
export function extractUsages(text: string, file: string): UsageIndex {
  const entries: Usage[] = [],
    unresolved: { file: string; expression: string }[] = [],
    errors: { file: string; message: string }[] = [];
  const script = (code: string, expression = false) => {
    try {
      const ast = expression
        ? parseExpression(code, { plugins: ["typescript"] })
        : parseScript(code, {
            sourceType: "unambiguous",
            plugins: ["typescript", "jsx"],
            errorRecovery: false,
          });
      walk(ast, (n) => {
        if (n.type !== "CallExpression" && n.type !== "OptionalCallExpression")
          return;
        const callee = n.callee;
        const called =
          node(callee) &&
          (callee.type === "Identifier"
            ? ["$t", "t", "$tc", "tc"].includes(String(callee.name))
            : (callee.type === "MemberExpression" ||
                callee.type === "OptionalMemberExpression") &&
              ["$t", "$tc", "t", "tc"].includes(name(callee.property) ?? ""));
        if (!called || !Array.isArray(n.arguments)) return;
        const key = literal(n.arguments[0]);
        if (key === undefined) {
          unresolved.push({
            file,
            expression: code.slice(
              Number(n.start ?? 0),
              Number(n.end ?? code.length),
            ),
          });
          return;
        }
        entries.push({
          key,
          file,
          kind: "call",
          ...supplied(n.arguments.slice(1)),
        });
      });
    } catch (error) {
      errors.push({
        file,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };
  if (!file.endsWith(".vue")) {
    script(text);
    return { entries, unresolved, errors };
  }
  const { descriptor, errors: sfcErrors } = parseSfc(text, { filename: file });
  for (const error of sfcErrors) errors.push({ file, message: String(error) });
  for (const block of [descriptor.script, descriptor.scriptSetup])
    if (block) script(block.content);
  if (descriptor.template) {
    try {
      const template = baseParse(descriptor.template.content);
      walk(template, (n) => {
        if (
          n.type === 5 &&
          node(n.content) &&
          typeof n.content.content === "string"
        )
          script(n.content.content, true);
        if (
          n.type === 7 &&
          node(n.exp) &&
          typeof n.exp.content === "string" &&
          /(?:\$?t|\$?tc)\s*\(/u.test(n.exp.content)
        )
          script(n.exp.content, true);
        if (n.type !== 1 || n.tag !== "i18n-t" || !Array.isArray(n.props))
          return;
        const attr = n.props.find(
          (p) => node(p) && p.type === 6 && p.name === "keypath",
        ) as Node | undefined;
        const bound = n.props.find(
          (p) =>
            node(p) &&
            p.type === 7 &&
            p.name === "bind" &&
            node(p.arg) &&
            p.arg.content === "keypath",
        ) as Node | undefined;
        let key = node(attr?.value) ? String(attr.value.content) : undefined;
        if (!key && node(bound?.exp) && typeof bound.exp.content === "string")
          try {
            key = literal(parseExpression(bound.exp.content));
          } catch {}
        if (!key) {
          unresolved.push({ file, expression: "动态 i18n-t keypath" });
          return;
        }
        const params: string[] = [];
        const children = Array.isArray(n.children) ? n.children : [];
        let named = false,
          known = true;
        for (const child of children) {
          if (!node(child) || child.type !== 1 || !Array.isArray(child.props))
            continue;
          for (const prop of child.props) {
            if (node(prop) && prop.type === 7 && prop.name === "slot") {
              named = true;
              if (node(prop.arg) && prop.arg.isStatic)
                params.push(`named:${String(prop.arg.content)}`);
              else known = false;
            }
          }
        }
        if (!named)
          children
            .filter(
              (child) =>
                !(
                  node(child) &&
                  child.type === 2 &&
                  !String(child.content).trim()
                ),
            )
            .forEach((_c, i) => params.push(`list:${i}`));
        const plural = n.props.find(
          (p) =>
            node(p) &&
            ((p.type === 6 && p.name === "plural") ||
              (p.type === 7 &&
                p.name === "bind" &&
                node(p.arg) &&
                p.arg.content === "plural")),
        );
        if (plural) {
          const staticValue =
            node(plural) && plural.type === 6 && node(plural.value)
              ? plural.value.content
              : undefined;
          const boundExpression =
            node(plural) && plural.type === 7 ? plural.exp : undefined;
          if (
            (typeof staticValue === "string" &&
              Number.isFinite(Number(staticValue))) ||
            numericPluralExpression(boundExpression)
          )
            params.push("plural", "named:n", "named:count");
          else known = false;
        }
        entries.push({
          key,
          file,
          kind: "component",
          supplied: params,
          parametersKnown: known,
        });
      });
    } catch (error) {
      errors.push({
        file,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { entries, unresolved, errors };
}
export async function scanUsages(hostRoot: string): Promise<UsageIndex> {
  const output: {
    entries: Usage[];
    unresolved: { file: string; expression: string }[];
    errors: { file: string; message: string }[];
  } = { entries: [], unresolved: [], errors: [] };
  async function scan(directory: string) {
    for (const entry of (
      await readdir(directory, { withFileTypes: true })
    ).toSorted((a, b) => a.name.localeCompare(b.name))) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) await scan(filename);
      else if (/\.(?:vue|js|ts)$/u.test(entry.name)) {
        const result = extractUsages(
          await readFile(filename, "utf8"),
          path.relative(hostRoot, filename),
        );
        output.entries.push(...result.entries);
        output.unresolved.push(...result.unresolved);
        output.errors.push(...result.errors);
      }
    }
  }
  await scan(path.join(hostRoot, "src"));
  return output;
}
