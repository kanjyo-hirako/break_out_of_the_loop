/**
 * dsh-agent-loop-guard —— 结构性循环守卫插件。
 *
 * 与内置 `dsh-repeat-tool-reminder`（纯劝告、精确同参计数、3/5/8 提醒）
 * 互补：本插件在工具决策链上**结构性切断**零信息量重复（同参 + 同结果），
 * 并覆盖近似重复漂移（D2）、错误回避循环（D3）与无进展状态（D4）。
 * 设计文档见仓库 README。
 *
 * @module dsh-agent-loop-guard
 */

import { canonicalize, hashResult, resultText } from "./canonical.ts";
import { Config, validateSettings } from "./config.ts";
import { collectStrings, createAgentState, decidePreCall, observePostCall, tracked, type AgentState, type PostObservation } from "./state.ts";
import { observeStreamFrame } from "./replay.ts";
import { createUserMessage, GUARD_SOURCE } from "./messages.ts";
import type {
  InjectedContext,
  PluginContext,
  PostToolDecision,
  PreToolDecision,
  ToolExec,
  ToolResult
} from "./host-types.ts";

const name = "loop-guard";

/** 调用身份：工具名 + 规范化参数。 */
function callKey(tool: string, canonical: string): string {
  return JSON.stringify([tool, canonical]);
}

function noticeContext(text: string, summary: string): InjectedContext {
  return createUserMessage({
    content: [{ type: "text", text }],
    source: { ...GUARD_SOURCE, form: "notice", summary }
  });
}

function prependContext(ours: InjectedContext[], theirs: InjectedContext[] | undefined): InjectedContext[] {
  return [...ours, ...(theirs ?? [])];
}

/** 把一次观察产出的全部提醒转成注入上下文。 */
function contextsOf(observation: PostObservation, tool: string): InjectedContext[] {
  const contexts: InjectedContext[] = [];
  if (observation.notice !== undefined) {
    contexts.push(noticeContext(observation.notice, `${tool} × ${observation.runs}`));
  }
  if (observation.overlap !== undefined) {
    contexts.push(noticeContext(observation.overlap, `${tool} overlap`));
  }
  if (observation.errorWatch !== undefined) {
    contexts.push(noticeContext(observation.errorWatch, `${tool} error-unresolved`));
  }
  if (observation.anchor !== undefined) {
    contexts.push(noticeContext(observation.anchor, `${tool} progress-anchor`));
  }
  if (observation.circuitBreak !== undefined) {
    contexts.push(noticeContext(observation.circuitBreak, `${tool} circuit-break`));
  }
  return contexts;
}

/** 安装守卫监听器。 */
function apply(ctx: PluginContext, config: Parameters<typeof validateSettings>[0]): void {
  const settings = validateSettings(config);
  const states = new WeakMap<object, AgentState>();

  function stateOf(agent: object): AgentState {
    let state = states.get(agent);
    if (state === undefined) {
      state = createAgentState();
      states.set(agent, state);
    }
    return state;
  }

  // 执行前闸门：D5 噪声预防 + 零信息量重复的结构性阻断（I2/I3）
  ctx.on("tools/pre-execute", async (exec: ToolExec, next): Promise<PreToolDecision> => {
    const downstream = await next();
    const agent = exec.agent;
    if (agent === undefined || !tracked(exec.name, settings)) return downstream;

    const canonical = canonicalize(exec.arguments);
    const key = callKey(exec.name, canonical);
    const args = exec.arguments !== null && typeof exec.arguments === "object" && !Array.isArray(exec.arguments)
      ? (exec.arguments as Record<string, unknown>)
      : undefined;
    const decision = decidePreCall(stateOf(agent), key, exec.name, canonical, args, settings);

    if (decision.action === "allow") return downstream;
    if (settings.noticeOnly) return downstream; // 安全模式：只提醒不阻断
    // 协作式阻断：仍让下游监听器观察过执行意图，但最终结论为 deny；
    // 若下游已给出拒绝，保留它的理由（多守卫共存）。
    if (downstream.kind === "deny") return downstream;
    return { kind: "deny", reason: decision.reason };
  });

  // 执行后决策：结果哈希链维护 + I1/D2/D3/I4 提醒（经 additionalContexts 注入）
  ctx.on("tools/post-execute", async (exec: ToolExec, result: ToolResult, next): Promise<PostToolDecision> => {
    const agent = exec.agent;
    let ours: InjectedContext[] = [];

    if (agent !== undefined && tracked(exec.name, settings)) {
      const canonical = canonicalize(exec.arguments);
      const key = callKey(exec.name, canonical);
      const observation = observePostCall(
        stateOf(agent),
        key,
        exec.name,
        canonical,
        hashResult(result),
        resultText(result),
        result.isError,
        collectStrings(exec.arguments),
        settings
      );
      ours = contextsOf(observation, exec.name);
    }

    const downstream = await next();
    if (ours.length === 0) return downstream;

    if (downstream.kind === "block") {
      return {
        kind: "block",
        feedback: downstream.feedback,
        additionalContexts: prependContext(ours, downstream.additionalContexts)
      };
    }
    return {
      ...downstream,
      additionalContexts: prependContext(ours, downstream.additionalContexts)
    };
  });

  // D1' step 级重放：聚合 assistant 流签名（纯观察，不改写任何内容）。
  // 相邻两次 attempt 的"思考+回复+调用"逐字相同 ⇒ 整个 step 在被机械重放。
  ctx.on("agent/assistant-stream", ({ agent, frame }) => {
    if (!settings.replayDetection) return;
    observeStreamFrame(stateOf(agent).replay, frame, settings.minReplayChars);
  });
}

export { Config, apply, name };
