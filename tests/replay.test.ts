import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createReplayState, observeStreamFrame, type StreamFrame } from "../src/replay.ts";
import { validateSettings } from "../src/config.ts";
import { createAgentState, decidePreCall, observePostCall, type GuardSettings } from "../src/state.ts";

const settings: GuardSettings = validateSettings({
  repeatLimit: 2,
  escapeRuns: 1,
  noticeOnly: false,
  include: [],
  exclude: [],
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
});

/** 构造一次完整 attempt 的帧序列（思考 + 回复 + 工具调用）。 */
function attemptFrames(attemptId: string, body: string, args: string, committed = true): StreamFrame[] {
  return [
    { type: "start", attemptId },
    { type: "chunk", attemptId, chunk: { type: "reasoning-delta", text: body } },
    { type: "chunk", attemptId, chunk: { type: "tool-call-delta", name: "grep", argumentsDelta: args } },
    { type: "end", attemptId, outcome: { kind: committed ? "committed" : "abandoned" } }
  ];
}

function feed(replay: ReturnType<typeof createReplayState>, frames: StreamFrame[]): void {
  for (const frame of frames) observeStreamFrame(replay, frame, settings.minReplayChars);
}

const BODY = "Let me search the plan file again to locate the task sections. ".repeat(3); // > 100 chars

test("D1' 相邻 attempt 签名逐字相同 → 进入重放模式", () => {
  const replay = createReplayState();
  feed(replay, attemptFrames("a1", BODY, '{"pattern":"x"}'));
  assert.equal(replay.replayMode, false);
  feed(replay, attemptFrames("a2", BODY, '{"pattern":"x"}'));
  assert.equal(replay.replayMode, true);
  assert.equal(replay.replayStreak, 1);
});

test("D1' 签名不同 → 不进入重放模式", () => {
  const replay = createReplayState();
  feed(replay, attemptFrames("a1", BODY, '{"pattern":"x"}'));
  feed(replay, attemptFrames("a2", `${BODY} Now I will read the file instead.`, '{"pattern":"y"}'));
  assert.equal(replay.replayMode, false);
});

test("D1' 签名过短不构成证据", () => {
  const replay = createReplayState();
  feed(replay, attemptFrames("a1", "short", "{}"));
  feed(replay, attemptFrames("a2", "short", "{}"));
  assert.equal(replay.replayMode, false);
});

test("D1' abandoned attempt 不参与判定", () => {
  const replay = createReplayState();
  feed(replay, attemptFrames("a1", BODY, '{"pattern":"x"}'));
  feed(replay, attemptFrames("a2", `${BODY} aborted`, '{"pattern":"z"}', false));
  feed(replay, attemptFrames("a3", BODY, '{"pattern":"x"}'));
  // a2 被丢弃，a3 与 a1 签名相同 → 仍算连续重放
  assert.equal(replay.replayMode, true);
});

test("D1' 重放模式下降阻断门槛：同 key 第二次请求即拦", () => {
  const state = createAgentState();
  const key = JSON.stringify(["grep", "{}"]);

  // 一次正常执行（同结果 1 次）
  observePostCall(state, key, "grep", "{}", "H1", "r", false, [], settings);
  // 正常模式下第二次请求仍放行（runs=1 < repeatLimit=2）
  assert.equal(decidePreCall(state, key, "grep", "{}", { path: "src" }, settings).action, "allow");

  // 进入重放模式后，同一请求立即被拒并附重放说明
  feed(state.replay, attemptFrames("a1", BODY, '{"pattern":"x"}'));
  feed(state.replay, attemptFrames("a2", BODY, '{"pattern":"x"}'));
  assert.equal(state.replay.replayMode, true);

  const decision = decidePreCall(state, key, "grep", "{}", { path: "src" }, settings);
  assert.equal(decision.action, "deny");
  if (decision.action === "deny") {
    assert.equal(decision.kind, "repeat");
    assert.match(decision.reason, /Step replay detected/);
    assert.match(decision.reason, /byte-identical/);
  }
});

test("I5 熔断：连续干预达到阈值时给出停机指令（仅一次）", () => {
  const strict: GuardSettings = { ...settings, circuitBreakAfter: 2, anchorWindow: 2 };
  const state = createAgentState();
  const key = "k1";

  // call1 新鲜；call2 重复提醒（干预 1）；call3 锚点提醒（干预 2）→ 熔断
  observePostCall(state, key, "grep", "{}", "H1", "same result text for the loop", false, [], strict);
  const o2 = observePostCall(state, key, "grep", "{}", "H1", "same result text for the loop", false, [], strict);
  assert.match(o2.notice ?? "", /next identical call/);
  assert.equal(o2.circuitBreak, undefined);
  const o3 = observePostCall(state, key, "grep", "{}", "H1", "same result text for the loop", false, [], strict);
  assert.match(o3.circuitBreak ?? "", /Circuit breaker/);
  assert.match(o3.circuitBreak ?? "", /Stop tool use now/);
  // 只触发一次
  const o4 = observePostCall(state, key, "grep", "{}", "H1", "same result text for the loop", false, [], strict);
  assert.equal(o4.circuitBreak, undefined);
});

test("I5 新鲜结果清零干预计数并解除熔断", () => {
  const strict: GuardSettings = { ...settings, circuitBreakAfter: 2, anchorWindow: 2 };
  const state = createAgentState();
  observePostCall(state, "k1", "grep", "{}", "H1", "same result text for the loop", false, [], strict);
  const broken = observePostCall(state, "k1", "grep", "{}", "H1", "same result text for the loop", false, [], strict);
  assert.equal(broken.circuitBreak, undefined);
  const broken2 = observePostCall(state, "k1", "grep", "{}", "H1", "same result text for the loop", false, [], strict);
  assert.match(broken2.circuitBreak ?? "", /Circuit breaker/);
  // 新鲜结果 → 计数清零、熔断解除
  const fresh = observePostCall(state, "k2", "grep", "{}", "H2", "brand new evidence", false, [], strict);
  assert.equal(fresh.freshProgress, true);
  assert.equal(fresh.circuitBreak, undefined);
  assert.equal(state.circuitBroken, false);
  assert.equal(state.interventions, 0);
});
