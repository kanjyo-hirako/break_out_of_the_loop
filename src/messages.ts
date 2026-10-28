/**
 * 合成消息构造与干预文案（纯函数）。
 *
 * `createUserMessage` 与 DSH 内联的 `@deepseek-ai/dsh-llm` 构造器同构：
 * `deepFreeze(structuredClone({ ...input, role: 'user', id: randomUUID() }))`。
 * 本地实现以避免构建期依赖；来源标注是强制的（无标注会被渲染成普通用户消息）。
 */

import { randomUUID } from "node:crypto";
import type { ContentBlock, ContextSource, InjectedContext } from "./host-types.ts";

/** 冻结对象（递归），与宿主消息不可变性约定保持一致。 */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

/** 构造一条已标识、已冻结的注入式用户消息。 */
export function createUserMessage(input: {
  content: ContentBlock[];
  source: ContextSource;
}): InjectedContext {
  return deepFreeze(
    structuredClone({
      ...input,
      role: "user" as const,
      id: randomUUID()
    })
  );
}

/** 本插件所有注入内容的来源标签。 */
export const GUARD_SOURCE: ContextSource = { kind: "loop-guard" };

export interface RepeatEvidence {
  tool: string;
  canonicalArguments: string;
  runs: number;
  resultHash: string;
  resultDigest: string;
}

/**
 * 阻断（I3）理由：证据 + 上一份结果摘要 + 明确替代动作 + 逃生口。
 * 写成模型可直接照做的形式，而非抽象建议。
 */
export function denyReason(evidence: RepeatEvidence, locked: boolean): string {
  const runsText = evidence.runs === 1
    ? "has already executed once and returned this exact result"
    : `has already executed ${evidence.runs} times and returned byte-identical results`;
  const lines = [
    `[loop-guard] Duplicate tool call ${locked ? "permanently blocked" : "blocked"}: \`${evidence.tool}\` with identical arguments ${runsText} (hash ${evidence.resultHash}). No new information can come from running it again.`,
    `Previous result (preserved in the conversation above): ${evidence.resultDigest}`,
    `Do NOT call \`${evidence.tool}\` with these arguments again. Take ONE different action that moves the task forward (read/edit a file, run a command, use another tool, or ask the user). If you have concrete evidence that the world changed since the last run, repeat the exact call one more time and it will be executed exactly once.`
  ];
  return lines.join("\n");
}

/** 首次拒绝后的锁定拒绝（逃生口已用尽且结果仍逐字相同）。 */
export function lockedDenyReason(evidence: RepeatEvidence): string {
  return (
    `[loop-guard] Call permanently blocked: \`${evidence.tool}\` with these exact arguments has executed ${evidence.runs} times with byte-identical results (hash ${evidence.resultHash}); the escape run confirmed the world is unchanged. ` +
    `Previous result: ${evidence.resultDigest} ` +
    `Choose a genuinely different action now: different tool, different arguments, edit something, or finish the task.`
  );
}

/** 劝告（I1）：第二次同结果时的提醒，预告下一次将被阻断。 */
export function repeatNotice(evidence: RepeatEvidence): string {
  return (
    `[loop-guard] \`${evidence.tool}\` returned a byte-identical result to its previous run (hash ${evidence.resultHash}, ${evidence.runs} runs). ` +
    `The next identical call will be blocked. The answer is already in the conversation — use it, or take a different action.`
  );
}

/** 近似重复（D2/I1）提醒。 */
export function overlapNotice(tool: string, overlap: number, similarCount: number): string {
  return (
    `[loop-guard] Your recent results overlap ${(overlap * 100).toFixed(0)}% with ${similarCount} earlier call${similarCount > 1 ? "s" : ""} (e.g. \`${tool}\`). ` +
    `You are likely re-searching information already present above. Read the existing result, or change your search target entirely.`
  );
}

/** 错误未解决（D3/I1）提醒。 */
export function errorWatchNotice(tool: string, errorDigest: string, steps: number): string {
  return (
    `[loop-guard] The earlier \`${tool}\` failure is still unresolved after ${steps} calls: ${errorDigest} ` +
    `Address the failure directly (follow its instructions) instead of running adjacent search calls.`
  );
}

/** 进度锚点（I4）。 */
export function anchorNotice(window: number): string {
  return (
    `[loop-guard] Progress anchor: the last ${window} tracked calls produced no new information. ` +
    `Before the next tool call: (1) state the current goal in one line, (2) call todo_write to fix the remaining steps, (3) take exactly ONE step that changes files or gathers new evidence.` +
    ` Do not repeat any earlier call.`
  );
}

/** 熔断（I5）。 */
export function circuitBreakNotice(interventions: number): string {
  return (
    `[loop-guard] Circuit breaker: ${interventions} consecutive interventions without progress. ` +
    `Stop tool use now. Summarize for the user what was found, what is stuck, and ask how to proceed. Do not issue more tool calls in this turn.`
  );
}

/** D1' step 级重放的附注（叠加在拒绝理由后）。 */
export function replayNote(): string {
  return (
    `[loop-guard] Step replay detected: your last two assistant responses (thinking, reply, and tool calls) were byte-identical. ` +
    `The loop is mechanical — following the same plan again will reproduce it. Break the pattern deliberately: change the tool or the arguments, or stop and report to the user.`
  );
}

/** 噪声预防（D5/I3）：无边界搜索的结构化拒绝。 */
export function unscopedSearchDeny(tool: string, scopeFields: string[]): string {
  return (
    `[loop-guard] Unscoped \`${tool}\` blocked: searching without a target scope floods the context with irrelevant matches and has caused loop failures before. ` +
    `Retry with at least one of [${scopeFields.join(", ")}] set (e.g. restrict to the project directory and a file glob), and keep the result set small.`
  );
}
