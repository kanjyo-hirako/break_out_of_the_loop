/**
 * 参数规范化、结果哈希与文本摘要工具（纯函数，无宿主依赖）。
 */

import { createHash } from "node:crypto";

/**
 * 深度按键排序，使仅属性顺序不同的两个参数对象规范化为同一形式。
 * 输入域为 `JSON.parse` 的值域（或畸形 JSON 时的原始字符串），因此
 * 无需处理 bigint、循环引用与 `undefined`。
 */
export function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) sorted[key] = sortJsonValue(record[key]);
    return sorted;
  }
  return value;
}

/** 调用参数的规范字符串：深度键排序后序列化。 */
export function canonicalize(argumentsValue: unknown): string {
  return JSON.stringify(sortJsonValue(argumentsValue));
}

/** 稳定哈希（sha256 hex 前 16 位，用于身份判据与日志展示）。 */
export function shortHash(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex").slice(0, 16);
}

/**
 * 工具结果的内容指纹：对 `value`（成功）或 `error`（失败）与渲染投影
 * `content` 一并哈希。任何字段变化都产生新指纹。
 */
export function hashResult(result: {
  isError: boolean;
  value?: unknown;
  error?: unknown;
  content: Array<{ type: string; text?: string }>;
}): string {
  const material = JSON.stringify({
    isError: result.isError,
    payload: result.isError ? result.error : result.value,
    content: result.content.map((block) => ({ type: block.type, text: block.text }))
  });
  return shortHash(material);
}

/** 结果文本视图（用于摘要与相似度）。 */
export function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .map((block) => (block.text === undefined ? "" : block.text))
    .join("\n")
    .trim();
}

/** 头部截断预览，标注省略字符数。 */
export function preview(text: string, cap: number): string {
  if (text.length <= cap) return text;
  return `${text.slice(0, cap)}… (+${text.length - cap} more chars)`;
}

/** 将 `*` 通配模式编译为锚定正则（其余正则元字符按字面匹配）。 */
export function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, String.raw`\$&`);
  return new RegExp(`^${escaped.replaceAll("*", ".*")}$`);
}

/**
 * 行集合 Jaccard 重叠度：`|A∩B| / |A∪B|`，用于近似重复（D2）判据。
 * 空对空视为 1（完全相同），空对非空视为 0。
 */
export function lineOverlap(a: string, b: string): number {
  const setA = new Set(a.split("\n").map((line) => line.trim()).filter(Boolean));
  const setB = new Set(b.split("\n").map((line) => line.trim()).filter(Boolean));
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const line of setA) if (setB.has(line)) intersection++;
  return intersection / (setA.size + setB.size - intersection);
}
