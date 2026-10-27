import { strict as assert } from "node:assert";
import { test } from "node:test";
import { canonicalize, hashResult, lineOverlap, preview, shortHash, sortJsonValue } from "../src/canonical.ts";

test("canonicalize: 属性顺序不同 → 同一规范形式", () => {
  const a = { b: 1, a: { d: 2, c: 3 }, list: [{ y: 1, x: 2 }] };
  const b = { list: [{ x: 2, y: 1 }], a: { c: 3, d: 2 }, b: 1 };
  assert.equal(canonicalize(a), canonicalize(b));
});

test("canonicalize: 值不同 → 不同规范形式", () => {
  assert.notEqual(canonicalize({ path: "a.ts" }), canonicalize({ path: "b.ts" }));
});

test("sortJsonValue 不改动原对象", () => {
  const input = { b: 1, a: 2 };
  sortJsonValue(input);
  assert.deepEqual(input, { b: 1, a: 2 });
});

test("hashResult: 同结果同哈希，任一字段变化即不同哈希", () => {
  const base = { isError: false, value: { rows: [1, 2] }, content: [{ type: "text", text: "hello" }] };
  const same = { isError: false, value: { rows: [1, 2] }, content: [{ type: "text", text: "hello" }] };
  const diff = { isError: false, value: { rows: [1, 3] }, content: [{ type: "text", text: "hello" }] };
  const err = { isError: true, error: "boom", content: [{ type: "text", text: "hello" }] };
  assert.equal(hashResult(base), hashResult(same));
  assert.notEqual(hashResult(base), hashResult(diff));
  assert.notEqual(hashResult(base), hashResult(err));
});

test("shortHash 稳定且为 16 位 hex", () => {
  const h = shortHash("abc");
  assert.equal(h, shortHash("abc"));
  assert.match(h, /^[0-9a-f]{16}$/);
});

test("lineOverlap: 相同 1，无关 0，部分重叠介于其间", () => {
  assert.equal(lineOverlap("a\nb\nc", "a\nb\nc"), 1);
  assert.equal(lineOverlap("a\nb", "c\nd"), 0);
  assert.equal(lineOverlap("", ""), 1);
  const partial = lineOverlap("a\nb\nc", "b\nc\nd");
  assert.ok(partial > 0 && partial < 1);
});

test("preview: 超长截断并标注省略数", () => {
  assert.equal(preview("abc", 3), "abc");
  assert.equal(preview("abcdef", 3), "abc… (+3 more chars)");
});
