import { strict as assert } from "node:assert";
import { test } from "node:test";
import { validateSettings } from "../src/config.ts";
import { collectStrings, createAgentState, decidePreCall, observePostCall, tracked, type GuardSettings } from "../src/state.ts";

const baseConfig = {
  repeatLimit: 2,
  escapeRuns: 1,
  noticeOnly: false,
  include: [],
  exclude: ["todo_write", "job_output"],
  searchTools: ["grep"],
  scopeFields: ["path", "include"],
  unscopedSearch: "deny",
  argumentsPreviewChars: 300,
  overlapThreshold: 0.9,
  overlapWindow: 10,
  errorWatchSteps: 3,
  remedialTools: ["read"],
  anchorWindow: 5,
  replayDetection: true,
  minReplayChars: 100,
  circuitBreakAfter: 6
};

const settings: GuardSettings = validateSettings(baseConfig);

function runCall(
  state: ReturnType<typeof createAgentState>,
  key: string,
  hash: string,
  s = settings,
  extra: { text?: string; isError?: boolean; argsStrings?: string[]; tool?: string } = {}
) {
  return observePostCall(
    state,
    key,
    extra.tool ?? "grep",
    '{"pattern":"x"}',
    hash,
    extra.text ?? `result-${hash}`,
    extra.isError ?? false,
    extra.argsStrings ?? [],
    s
  );
}

// ── D1 零信息量重复 ──────────────────────────────────────────────────────────

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

// ── D5 无边界搜索 ────────────────────────────────────────────────────────────

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

// ── D2 结果重叠 ──────────────────────────────────────────────────────────────

test("D2 不同参数反复拿到近乎相同的结果 → 重叠提醒", () => {
  const state = createAgentState();
  const textA = "task one at 1550\ntask two at 1755\ntask three at 1897\nend of list";
  const obs1 = runCall(state, "kA", "HA", settings, { text: textA });
  assert.equal(obs1.overlap, undefined);
  const obs2 = runCall(state, "kB", "HB", settings, { text: textA });
  assert.match(obs2.overlap ?? "", /overlap 100%/);
  assert.match(obs2.overlap ?? "", /re-searching information already present/);
});

test("D2 重叠低于阈值不提醒", () => {
  const state = createAgentState();
  runCall(state, "kA", "HA", settings, { text: "alpha\nbeta\ngamma\ndelta" });
  const obs = runCall(state, "kB", "HB", settings, { text: "epsilon\nzeta\neta\ntheta" });
  assert.equal(obs.overlap, undefined);
});

test("D2 同 key 的精确重复不重复报（归 D1 管）", () => {
  const state = createAgentState();
  const textA = "line one\nline two\nline three\nline four";
  runCall(state, "kA", "HA", settings, { text: textA });
  const obs = runCall(state, "kA", "HA", settings, { text: textA });
  assert.equal(obs.overlap, undefined);
});

// ── D3 错误未解决 ────────────────────────────────────────────────────────────

test("D3 失败后连续 N 步无对症动作 → 提醒", () => {
  const state = createAgentState();
  const err = runCall(state, "kE", "HE", settings, {
    isError: true,
    text: "Error: file has not been read. Call read before edit.",
    argsStrings: ["src/a.ts"]
  });
  assert.equal(err.errorWatch, undefined);

  assert.equal(runCall(state, "g1", "H1", settings, { text: "r1", argsStrings: ["b.ts"] }).errorWatch, undefined);
  assert.equal(runCall(state, "g2", "H2", settings, { text: "r2", argsStrings: ["c.ts"] }).errorWatch, undefined);
  const third = runCall(state, "g3", "H3", settings, { text: "r3", argsStrings: ["d.ts"] });
  assert.match(third.errorWatch ?? "", /earlier `grep` failure is still unresolved after 3 calls/);
});

test("D3 对症动作（read 或共享路径）出现即解除", () => {
  const state = createAgentState();
  runCall(state, "kE", "HE", settings, {
    isError: true,
    text: "Error: file has not been read.",
    argsStrings: ["src/a.ts"]
  });
  // read 是默认对症工具
  runCall(state, "kRead", "HR", settings, { text: "file content", argsStrings: ["other.ts"], tool: "read" });
  for (let i = 0; i < 5; i++) {
    assert.equal(runCall(state, `g${i}`, `H${i}`, settings, { text: `r${i}`, argsStrings: [`x${i}.ts`] }).errorWatch, undefined);
  }
});

test("D3 共享同一路径字符串也算对症", () => {
  const state = createAgentState();
  runCall(state, "kE", "HE", settings, {
    isError: true,
    text: "Error: edit failed",
    argsStrings: ["src/a.ts"]
  });
  // 换了工具且共享路径 → 视为对症
  const obs = runCall(state, "kGrep", "HG", settings, { text: "matches", argsStrings: ["src/a.ts", "other"] });
  assert.equal(obs.errorWatch, undefined);
  assert.equal(state.pendingError, null);
});

// ── D4 无进展 → I4 锚点 ──────────────────────────────────────────────────────

test("D4 连续无新结果达到 anchorWindow → 进度锚点", () => {
  const state = createAgentState();
  runCall(state, "k1", "H1", settings, { text: "same" }); // 新鲜，计数清零
  for (let i = 0; i < 4; i++) {
    assert.equal(runCall(state, "k1", "H1", settings, { text: "same" }).anchor, undefined); // 第 1..4 次无新结果
  }
  const sixth = runCall(state, "k1", "H1", settings, { text: "same" }); // 第 5 次无新结果
  assert.match(sixth.anchor ?? "", /Progress anchor/);
  assert.match(sixth.anchor ?? "", /todo_write/);
});

test("D4 新结果立刻清零计数", () => {
  const state = createAgentState();
  for (let i = 0; i < 4; i++) runCall(state, "k1", "H1", settings, { text: "same" });
  runCall(state, "k2", "H2", settings, { text: "new evidence", argsStrings: [] });
  for (let i = 0; i < 4; i++) {
    assert.equal(runCall(state, "k1", "H1", settings, { text: "same" }).anchor, undefined);
  }
});

// ── 配置校验 ─────────────────────────────────────────────────────────────────

test("collectStrings 递归收集参数里的字符串", () => {
  assert.deepEqual(collectStrings({ a: "x", b: ["y", { c: "z" }], d: 1 }), ["x", "y", "z"]);
});

test("validateSettings fail-loud", () => {
  assert.throws(() => validateSettings({ ...baseConfig, repeatLimit: 1 }), /repeatLimit/);
  assert.throws(() => validateSettings({ ...baseConfig, escapeRuns: -1 }), /escapeRuns/);
  assert.throws(() => validateSettings({ ...baseConfig, unscopedSearch: "x" }), /unscopedSearch/);
  assert.throws(() => validateSettings({ ...baseConfig, scopeFields: [] }), /scopeFields/);
  assert.throws(() => validateSettings({ ...baseConfig, overlapThreshold: 0 }), /overlapThreshold/);
  assert.throws(() => validateSettings({ ...baseConfig, overlapThreshold: 1.5 }), /overlapThreshold/);
  assert.throws(() => validateSettings({ ...baseConfig, overlapWindow: 2 }), /overlapWindow/);
  assert.throws(() => validateSettings({ ...baseConfig, errorWatchSteps: 0 }), /errorWatchSteps/);
  assert.throws(() => validateSettings({ ...baseConfig, anchorWindow: 1 }), /anchorWindow/);
});
