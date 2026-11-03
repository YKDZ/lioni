import { createHash } from "node:crypto";

import { snapshotJsonValue } from "@lioni/core";

import { messageFamilyEvidenceKey } from "./message-families.ts";

type Leaf = {
  readonly kind: "leaf";
  readonly key: string;
  readonly digest: string;
};
type Branch = {
  readonly kind: "branch";
  readonly key: string;
  readonly bit: number;
  readonly left: Node;
  readonly right: Node;
  readonly digest: string;
};
type Node = Leaf | Branch;

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function bitAt(key: string, bit: number): number {
  return (
    (Number.parseInt(key[Math.floor(bit / 4)]!, 16) >> (3 - (bit % 4))) & 1
  );
}

function firstDifference(left: string, right: string): number {
  let bit = 0;
  while (bit < 256 && bitAt(left, bit) === bitAt(right, bit)) bit++;
  return bit;
}

function branch(bit: number, left: Node, right: Node): Branch {
  return {
    kind: "branch",
    bit,
    left,
    right,
    key: left.key,
    digest: hash(JSON.stringify([bit, left.digest, right.digest])),
  };
}

function insert(node: Node | undefined, leaf: Leaf): Node {
  if (node === undefined) return leaf;
  let representative = node;
  while (representative.kind === "branch") {
    representative =
      bitAt(leaf.key, representative.bit) === 0
        ? representative.left
        : representative.right;
  }
  const difference = firstDifference(leaf.key, representative.key);
  function replace(current: Node): Node {
    if (current.kind === "leaf") {
      if (difference === 256) return leaf;
      return bitAt(leaf.key, difference) === 0
        ? branch(difference, leaf, current)
        : branch(difference, current, leaf);
    }
    if (difference < current.bit) {
      return bitAt(leaf.key, difference) === 0
        ? branch(difference, leaf, current)
        : branch(difference, current, leaf);
    }
    return bitAt(leaf.key, current.bit) === 0
      ? branch(current.bit, replace(current.left), current.right)
      : branch(current.bit, current.left, replace(current.right));
  }
  if (node.kind === "leaf" && difference < 256) {
    return bitAt(leaf.key, difference) === 0
      ? branch(difference, leaf, node)
      : branch(difference, node, leaf);
  }
  return replace(node);
}

function remove(node: Node | undefined, key: string): Node | undefined {
  if (node === undefined) return undefined;
  if (node.kind === "leaf") return node.key === key ? undefined : node;
  if (bitAt(key, node.bit) === 0) {
    const left = remove(node.left, key);
    return left === undefined
      ? node.right
      : left === node.left
        ? node
        : branch(node.bit, left, node.right);
  }
  const right = remove(node.right, key);
  return right === undefined
    ? node.left
    : right === node.right
      ? node
      : branch(node.bit, node.left, right);
}

/**
 * 按稳定关联身份构造规范化摘要树；形状由身份摘要决定，与输入顺序无关。
 * 候选只重算被替代物理记录涉及的路径，删除叶子后压缩路径，结果等同于从剩余成员重新构造。
 */
export class MessageFamilyBasis {
  private root: Node | undefined;

  constructor(entries: Iterable<readonly [string, unknown]>) {
    for (const [key, value] of entries)
      this.root = insert(this.root, this.leaf(key, value));
  }

  private leaf(key: string, value: unknown): Leaf {
    const validated = snapshotJsonValue(value, "消息族共享依据");
    return {
      kind: "leaf",
      key: hash(key),
      digest: hash(messageFamilyEvidenceKey([key, validated])),
    };
  }

  /** 替换关联的候选视图；undefined 表示该关联在排除旧记录后不再提供依据。 */
  withChanges(changes: Iterable<readonly [string, unknown]>): string {
    let root = this.root;
    for (const [key, value] of changes) {
      root =
        value === undefined
          ? remove(root, hash(key))
          : insert(root, this.leaf(key, value));
    }
    return root?.digest ?? hash("empty-message-family-basis");
  }
}
