import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Config, apply, name } from "../src/index.ts";
import type { PostToolDecision, PreToolDecision, ToolExec, ToolResult } from "../src/host-types.ts";

/** 最小 mock：记录监听器并允许逐次驱动瀑布。 */
function mockCtx() {
  const listeners = new Map<string, Array<(...args: any[]) => any>>();
  return {
    on(event: string, listener: (...args: any[]) => any) {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
    },
    async pre(exec: ToolExec): Promise<PreToolDecision> {
      const listener = listeners.get("tools/pre-execute")?.[0];
      assert.ok(listener, "pre-execute listener registered");
      return (await listener(exec, async () => ({ kind: "allow" }))) as PreToolDecision;
    },
    async post(exec: ToolExec, result: ToolResult): Promise<PostToolDecision> {
      const listener = listeners.get("tools/post-execute")?.[0];
      assert.ok(listener, "post-execute listener registered");
      return (await listener(exec, result, async () => ({ kind: "accept" as const }))) as PostToolDecision;
    }
  };
}

const config = {
  repeatLimit: 2,
  escapeRuns: 1,
  noticeOnly: false,
  include: [],
  exclude: ["todo_write"],
  searchTools: ["grep"],
  scopeFields: ["path", "include"],
  unscopedSearch: "deny",
  argumentsPreviewChars: 300,
  overlapThreshold: 0.9,
  overlapWindow: 10,
  errorWatchSteps: 3,
  remedialTools: ["read"],
  anchorWindow: 5
};

function execOf(agent: object): ToolExec {
  return { agent, name: "grep", arguments: { pattern: "task", path: "src" } };
}

const resultOf: ToolResult = {
  isError: false,
  value: { matches: 3 },
  content: [{ type: "text", text: "match at 1550\nmatch at 1755" }]
};

test("插件导出面：name / Config / apply", () => {
  assert.equal(name, "loop-guard");
  assert.ok(Config, "Config schema exported");
  assert.equal(typeof apply, "function");
});

test("端到端：同参同结果循环 → 提醒 → 阻断 → 逃生 → 锁定", async () => {
  const ctx = mockCtx();
  apply(ctx, config);
  const agent = {};
  const exec = execOf(agent);

  // 第 1 次：放行，无提醒
  assert.equal((await ctx.pre(exec)).kind, "allow");
  const post1 = await ctx.post(exec, resultOf);
  assert.equal(post1.kind, "accept");
  assert.equal(post1.additionalContexts, undefined);

  // 第 2 次：放行，注入预告性提醒（来源标注 loop-guard）
  assert.equal((await ctx.pre(exec)).kind, "allow");
  const post2 = await ctx.post(exec, resultOf);
  const contexts = post2.additionalContexts ?? [];
  assert.equal(contexts.length, 1);
  assert.equal(contexts[0]?.source.kind, "loop-guard");
  assert.match(contexts[0]?.content[0]?.text ?? "", /next identical call will be blocked/);

  // 第 3 次：阻断（deny 三件套：证据 + 结果摘要 + 替代动作）
  const denied = await ctx.pre(exec);
  assert.equal(denied.kind, "deny");
  if (denied.kind === "deny") {
    assert.match(denied.reason, /byte-identical/);
    assert.match(denied.reason, /match at 1550/); // 上一份结果摘要回填
    assert.match(denied.reason, /different action/);
  }

  // 第 4 次（坚持）：逃生口放行一次；结果仍相同 → 锁定
  assert.equal((await ctx.pre(exec)).kind, "allow");
  await ctx.post(exec, resultOf);

  // 第 5 次起：永久锁定
  const locked = await ctx.pre(exec);
  assert.equal(locked.kind, "deny");
  if (locked.kind === "deny") assert.match(locked.reason, /permanently blocked/);
});

test("端到端：结果变化（世界变了）→ 永不阻断", async () => {
  const ctx = mockCtx();
  apply(ctx, config);
  const agent = {};
  const exec = execOf(agent);

  for (let i = 0; i < 5; i++) {
    assert.equal((await ctx.pre(exec)).kind, "allow");
    await ctx.post(exec, { ...resultOf, value: { matches: i }, content: [{ type: "text", text: `run-${i}` }] });
  }
});

test("端到端：noticeOnly 安全模式只提醒不阻断", async () => {
  const ctx = mockCtx();
  apply(ctx, { ...config, noticeOnly: true });
  const agent = {};
  const exec = execOf(agent);

  for (let i = 0; i < 5; i++) {
    assert.equal((await ctx.pre(exec)).kind, "allow");
    await ctx.post(exec, resultOf);
  }
});

test("端到端：无边界 grep 被拒并提示加作用域", async () => {
  const ctx = mockCtx();
  apply(ctx, config);
  const decision = await ctx.pre({ agent: {}, name: "grep", arguments: { pattern: "conflict" } });
  assert.equal(decision.kind, "deny");
  if (decision.kind === "deny") assert.match(decision.reason, /Unscoped `grep` blocked/);
});

test("端到端：无 agent 的直调与未跟踪工具不受影响", async () => {
  const ctx = mockCtx();
  apply(ctx, config);
  // 无 agent 的直调没有模型可引导，按约定整体跳过（与内置守卫一致）
  assert.equal((await ctx.pre({ name: "grep", arguments: { pattern: "x" } })).kind, "allow");
  // 未跟踪工具（exclude）完全透明
  const untracked = await ctx.pre({ agent: {}, name: "todo_write", arguments: { todos: [] } });
  assert.equal(untracked.kind, "allow");
});
