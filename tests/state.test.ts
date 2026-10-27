import { strict as assert } from "node:assert";
import { test } from "node:test";
import { validateSettings } from "../src/config.ts";
import { createAgentState, decidePreCall, observePostCall, tracked, type GuardSettings } from "../src/state.ts";

const settings: GuardSettings = validateSettings({
  repeatLimit: 2,
  escapeRuns: 1,
  noticeOnly: false,
  include: [],
  exclude: ["todo_write", "job_output"],
  searchTools: ["grep"],
  scopeFields: ["path", "include"],
  unscopedSearch: "deny",
  argumentsPreviewChars: 300
});

function runCall(state: ReturnType<typeof createAgentState>, key: string, hash: string, s = settings) {
  return observePostCall(state, key, "grep", '{"pattern":"x"}', hash, `result-${hash}`, s);
}

test("首次执行：允许且无提醒", () => {
  const state = createAgentState();
  const key = "k1";
  assert.equal(decidePreCall(state, key, "grep", "{}", { path: "src" }, settings).action, "allow");
  const obs = runCall(state, key, "H1");
  assert.equal(obs.fresh, true);
  assert.equal(obs.notice, undefined);
});

test("第二次同结果：放行并给出预告性提醒", () => {
  const state = createAgentState();
  const key = "k1";
  runCall(state, key, "H1");
  assert.equal(decidePreCall(state, key, "grep", "{}", { path: "src" }, settings).action, "allow");
  const obs = runCall(state, key, "H1");
  assert.equal(obs.fresh, false);
  assert.equal(obs.runs, 2);
  assert.match(obs.notice ?? "", /next identical call will be blocked/);
});

test("第三次请求：拒绝并携带逃生口", () => {
  const state = createAgentState();
  const key = "k1";
  runCall(state, key, "H1");
  runCall(state, key, "H1");
  const decision = decidePreCall(state, key, "grep", "{}", { path: "src" }, settings);
  assert.equal(decision.action, "deny");
  if (decision.action === "deny") {
    assert.equal(decision.kind, "repeat");
    assert.match(decision.reason, /executed 2 times/);
    assert.match(decision.reason, /one more time and it will be executed exactly once/);
    assert.match(decision.reason, /result-H1/); // 上一份结果摘要回填
  }
});

test("逃生执行：放行一次；结果仍相同 → 永久锁定", () => {
  const state = createAgentState();
  const key = "k1";
  runCall(state, key, "H1");
  runCall(state, key, "H1");
  decidePreCall(state, key, "grep", "{}", { path: "src" }, settings); // 拒绝一次

  const escape = decidePreCall(state, key, "grep", "{}", { path: "src" }, settings);
  assert.equal(escape.action, "allow"); // 逃生口恰好一次

  const obs = runCall(state, key, "H1");
  assert.equal(obs.lockedNow, true);

  const after = decidePreCall(state, key, "grep", "{}", { path: "src" }, settings);
  assert.equal(after.action, "deny");
  if (after.action === "deny") assert.equal(after.kind, "locked");
});

test("逃生执行结果不同（世界变了）→ 链重置，不再拒绝", () => {
  const state = createAgentState();
  const key = "k1";
  runCall(state, key, "H1");
  runCall(state, key, "H1");
  decidePreCall(state, key, "grep", "{}", { path: "src" }, settings);
  assert.equal(decidePreCall(state, key, "grep", "{}", { path: "src" }, settings).action, "allow");

  const obs = runCall(state, key, "H2"); // 新结果
  assert.equal(obs.fresh, true);
  assert.equal(obs.runs, 1);
  assert.equal(decidePreCall(state, key, "grep", "{}", { path: "src" }, settings).action, "allow");
});

test("结果在第二次就变化：永不触发拒绝（轮询安全）", () => {
  const state = createAgentState();
  const key = "poll";
  runCall(state, key, "H1");
  runCall(state, key, "H2");
  runCall(state, key, "H3");
  assert.equal(decidePreCall(state, key, "grep", "{}", { path: "src" }, settings).action, "allow");
});

test("不同参数各自独立计数", () => {
  const state = createAgentState();
  runCall(state, "kA", "H1");
  runCall(state, "kB", "H1");
  assert.equal(decidePreCall(state, "kA", "grep", "{}", { path: "src" }, settings).action, "allow");
});

test("escapeRuns=0：无逃生口，第二次请求即锁定", () => {
  const strict: GuardSettings = { ...settings, escapeRuns: 0 };
  const state = createAgentState();
  const key = "k1";
  runCall(state, key, "H1", strict);
  runCall(state, key, "H1", strict);
  const first = decidePreCall(state, key, "grep", "{}", { path: "src" }, strict);
  assert.equal(first.action, "deny");
  const second = decidePreCall(state, key, "grep", "{}", { path: "src" }, strict);
  assert.equal(second.action, "deny");
  if (second.action === "deny") assert.equal(second.kind, "locked");
});

test("D5 无边界 grep 拒绝；带 path/include 放行", () => {
  const state = createAgentState();
  const unscoped = decidePreCall(state, "kX", "grep", "{}", { pattern: "foo" }, settings);
  assert.equal(unscoped.action, "deny");
  if (unscoped.action === "deny") {
    assert.equal(unscoped.kind, "unscoped");
    assert.match(unscoped.reason, /Unscoped `grep` blocked/);
  }
  assert.equal(decidePreCall(state, "kY", "grep", "{}", { pattern: "foo", path: "src" }, settings).action, "allow");
  assert.equal(decidePreCall(state, "kZ", "grep", "{}", { pattern: "foo", include: "*.ts" }, settings).action, "allow");
  assert.equal(decidePreCall(state, "kW", "read", "{}", {}, settings).action, "allow"); // 非搜索工具不受 D5 约束
});

test("unscopedSearch=allow 时 D5 不拦截", () => {
  const relaxed: GuardSettings = { ...settings, unscopedSearch: "allow" };
  assert.equal(decidePreCall(createAgentState(), "kX", "grep", "{}", { pattern: "foo" }, relaxed).action, "allow");
});

test("include/exclude 跟踪判定", () => {
  assert.equal(tracked("todo_write", settings), false);
  assert.equal(tracked("job_output", settings), false);
  assert.equal(tracked("grep", settings), true);
  const only: GuardSettings = { ...settings, include: [/grep/] };
  assert.equal(tracked("read", only), false);
  assert.equal(tracked("grep", only), true);
});

test("validateSettings fail-loud", () => {
  assert.throws(() => validateSettings({ ...settings, repeatLimit: 1, include: [], exclude: [], searchTools: [], scopeFields: ["path"] }), /repeatLimit/);
  assert.throws(() => validateSettings({ ...settings, escapeRuns: -1, include: [], exclude: [], searchTools: [], scopeFields: ["path"] }), /escapeRuns/);
  assert.throws(() => validateSettings({ ...settings, unscopedSearch: "x", include: [], exclude: [], searchTools: [], scopeFields: ["path"] }), /unscopedSearch/);
  assert.throws(() => validateSettings({ ...settings, scopeFields: [], include: [], exclude: [], searchTools: [] }), /scopeFields/);
});
