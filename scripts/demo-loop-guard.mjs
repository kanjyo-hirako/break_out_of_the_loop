// 演示：用真实构建产物（lib/index.js）驱动一组循环场景，打印守卫的完整决策轨迹。
// 运行前先 `npm run build`。用法: node scripts/demo-loop-guard.mjs
import { apply } from "../lib/index.js";

// ── mock 宿主：记录监听器并逐次驱动瀑布 ─────────────────────────────────────
function mockCtx() {
  const listeners = new Map();
  const on = (event, listener) => {
    const list = listeners.get(event) ?? [];
    list.push(listener);
    listeners.set(event, list);
  };
  return {
    on,
    async pre(exec) {
      return (await listeners.get("tools/pre-execute")[0](exec, async () => ({ kind: "allow" })));
    },
    async post(exec, result) {
      return (await listeners.get("tools/post-execute")[0](exec, result, async () => ({ kind: "accept" })));
    },
    stream(agent, frame) {
      for (const listener of listeners.get("agent/assistant-stream") ?? []) listener({ agent, frame });
    }
  };
}

const config = {
  repeatLimit: 2,
  escapeRuns: 1,
  noticeOnly: false, // 演示阻断档
  include: [],
  exclude: ["job_output"],
  searchTools: ["grep"],
  scopeFields: ["path", "include"],
  unscopedSearch: "deny",
  argumentsPreviewChars: 120,
  overlapThreshold: 0.9,
  overlapWindow: 10,
  errorWatchSteps: 3,
  remedialTools: ["read"],
  anchorWindow: 5,
  replayDetection: true,
  minReplayChars: 100,
  circuitBreakAfter: 6
};

const agent = {};
const ctx = mockCtx();
apply(ctx, config);

let step = 0;
function log(line) {
  console.log(line);
}

/** 执行一次工具调用并打印完整决策轨迹。 */
async function call(label, tool, args, result) {
  step += 1;
  log(`\n#${step} ${label}`);
  log(`   ▶ 模型调用 ${tool}(${JSON.stringify(args)})`);
  const decision = await ctx.pre({ agent, name: tool, arguments: args });
  if (decision.kind === "deny") {
    log(`   ✖ 守卫拒绝执行（调用未发生）`);
    for (const line of decision.reason.split("\n")) log(`     │ ${line}`);
    return decision;
  }
  log(`   ✔ 放行执行`);
  const post = await ctx.post({ agent, name: tool, arguments: args }, result);
  for (const context of post.additionalContexts ?? []) {
    log(`   ⚑ 注入提醒 [${context.source.summary}]`);
    for (const block of context.content) for (const line of block.text.split("\n")) log(`     │ ${line}`);
  }
  return decision;
}

const RESULT = { isError: false, value: { matches: 3 }, content: [{ type: "text", text: "match at 1550\nmatch at 1755\nmatch at 1897" }] };

log("════════════════════════════════════════════════════════════════");
log("场景 1：严格同参重复（证据 A/C —— 同一个 grep 连刷）");
log("════════════════════════════════════════════════════════════════");
const grepArgs = { pattern: "^## 任务十七|^## 任务十八", path: "blog_sever/plan.md" };
await call("首次搜索", "grep", grepArgs, RESULT);
await call("原样重发（第 2 次）", "grep", grepArgs, RESULT);
await call("原样重发（第 3 次）→ 应被拦截", "grep", grepArgs, RESULT);
await call("模型坚持（逃生口：放行恰好一次）", "grep", grepArgs, RESULT);
await call("继续重发 → 永久锁定", "grep", grepArgs, RESULT);
await call("再来一次 → 永久锁定", "grep", grepArgs, RESULT);

log("\n════════════════════════════════════════════════════════════════");
log("场景 2：轮询安全对照（结果在变化 → 永不拦截）");
log("════════════════════════════════════════════════════════════════");
const pollArgs = { pattern: "build status", path: "out.log" };
for (let i = 1; i <= 4; i++) {
  await call(`轮询第 ${i} 次（结果每次不同）`, "grep", pollArgs, {
    isError: false,
    value: { state: `step-${i}` },
    content: [{ type: "text", text: `build progress ${i * 25}%` }]
  });
}

log("\n════════════════════════════════════════════════════════════════");
log("场景 3：错误回避循环（证据 B —— edit 报错却继续 grep）");
log("════════════════════════════════════════════════════════════════");
await call("edit 失败：file has not been read", "edit", { path: "blog_sever/plan.md", old_str: "x", new_str: "y" }, {
  isError: true,
  error: "file has not been read. Call read before edit.",
  content: [{ type: "text", text: "Error: file has not been read. Call read before edit." }]
});
await call("回避动作 1：grep 定位行号", "grep", { pattern: "任务十七", path: "blog_sever/plan.md" }, RESULT);
await call("回避动作 2：grep 换个正则", "grep", { pattern: "任务十八", path: "blog_sever/plan.md" }, RESULT);
await call("回避动作 3 → 应收到错误未解决提醒", "grep", { pattern: "依赖关系", path: "blog_sever/plan.md" }, RESULT);
await call("对症动作：read（解除告警）", "read", { path: "blog_sever/plan.md", offset: 1500 }, {
  isError: false,
  value: { lines: "…" },
  content: [{ type: "text", text: "1550: ## 任务十七：评论无限滚动分页" }]
});

log("\n════════════════════════════════════════════════════════════════");
log("场景 4：无边界搜索预防（证据 B 的 20MB 溢出）");
log("════════════════════════════════════════════════════════════════");
await call("无 path/include 的全库 grep → 直接拒绝", "grep", { pattern: "conflict" }, RESULT);
await call("补上作用域 → 放行", "grep", { pattern: "conflict", include: "*.java", path: "src" }, RESULT);

log("\n════════════════════════════════════════════════════════════════");
log("场景 5：step 级重放（证据 C —— 思考+调用逐字重放）");
log("════════════════════════════════════════════════════════════════");
const BODY = "我需要再次搜索 plan.md 来定位任务小节，确保没有遗漏任何任务。".repeat(4);
function attempt(id, body) {
  ctx.stream(agent, { type: "start", attemptId: id });
  ctx.stream(agent, { type: "chunk", attemptId: id, chunk: { type: "reasoning-delta", text: body } });
  ctx.stream(agent, { type: "chunk", attemptId: id, chunk: { type: "tool-call-delta", name: "grep", argumentsDelta: '{"pattern":"^##"}' } });
  ctx.stream(agent, { type: "end", attemptId: id, outcome: { kind: "committed" } });
}
attempt("a1", BODY);
log("  (attempt a1 提交：一段思考 + grep 调用)");
attempt("a2", BODY);
log("  (attempt a2 提交：思考与调用逐字相同 → 重放模式开启)");
const replayArgs = { pattern: "^## 任务", path: "blog_sever/plan.md" };
await call("新目标首次搜索（正常放行）", "grep", replayArgs, RESULT);
attempt("a3", BODY);
attempt("a4", BODY);
log("  (attempt a3/a4 再次逐字重放 → 重放模式持续)");
await call("重放中的第 2 次同参请求 → 提前拦截（门槛降为 1 次）", "grep", replayArgs, RESULT);

log("\n════════════════════════════════════════════════════════════════");
log("演示结束：以上即插件在真实决策链上的完整行为轨迹。");
log("════════════════════════════════════════════════════════════════");
