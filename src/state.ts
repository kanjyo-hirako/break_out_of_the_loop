/**
 * 循环检测状态机（纯逻辑，无宿主依赖）。
 *
 * 核心判据——"零信息量重复"：
 *   同工具 + 同规范化参数 + 结果哈希与上次逐字节相同 ⇒ 再执行一次不携带
 *   任何新信息。两次执行即可证明（repeatLimit=2），第三次起阻断，
 *   保留一次逃生口（世界可能变化），逃生结果仍相同则永久锁定。
 *
 * 三个补充检测器（近似重复 / 错误回避 / 无进展）：
 *   D2 结果重叠：不同参数反复拿到近乎相同的结果 ⇒ 在重新搜索已有答案；
 *   D3 错误未解决：带修复指令的失败后连续 N 步无对症动作 ⇒ 错误回避循环；
 *   D4 无进展：连续 N 次调用没有产生任何新结果 ⇒ 注入进度锚点（I4）。
 */

import { lineOverlap, preview, wildcardToRegExp } from "./canonical.ts";
import {
  anchorNotice,
  circuitBreakNotice,
  denyReason,
  errorWatchNotice,
  lockedDenyReason,
  overlapNotice,
  replayNote,
  repeatNotice,
  unscopedSearchDeny,
  type RepeatEvidence
} from "./messages.ts";
import { createReplayState, type ReplayState } from "./replay.ts";

/** 完成配置校验后的运行期设置。 */
export interface GuardSettings {
  repeatLimit: number;
  escapeRuns: number;
  noticeOnly: boolean;
  include: RegExp[];
  exclude: RegExp[];
  searchTools: RegExp[];
  scopeFields: string[];
  unscopedSearch: "deny" | "allow";
  argumentsPreviewChars: number;
  overlapThreshold: number;
  overlapWindow: number;
  overlapTools: RegExp[];
  errorWatchSteps: number;
  remedialTools: RegExp[];
  anchorWindow: number;
  replayDetection: boolean;
  minReplayChars: number;
  circuitBreakAfter: number;
}

/** 单个调用身份（工具 + 规范化参数）的记录。 */
export interface KeyRecord {
  tool: string;
  canonical: string;
  hash: string;
  lastText: string;
  runs: number;
  denied: number;
  escapesUsed: number;
  escapePending: boolean;
  locked: boolean;
}

/** 最近调用结果（D2 重叠度量的滑动窗口）。 */
export interface RecentEntry {
  key: string;
  tool: string;
  text: string;
}

/** 待解决的失败（D3）。 */
export interface PendingError {
  tool: string;
  key: string;
  digest: string;
  /** 失败调用参数里的字符串值（文件路径等），用于识别对症动作。 */
  strings: string[];
  age: number;
}

export interface AgentState {
  keys: Map<string, KeyRecord>;
  recent: RecentEntry[];
  callsSinceFresh: number;
  pendingError: PendingError | null;
  /** 自上次新鲜结果以来的连续干预次数（I5 熔断计数）。 */
  interventions: number;
  /** 熔断已触发（新鲜结果出现前不重复触发）。 */
  circuitBroken: boolean;
  /** D2 劝告冷却：距离上次 overlap 提醒的调用数。 */
  overlapCooldown: number;
  /** D1' step 级重放状态。 */
  replay: ReplayState;
}

export function createAgentState(): AgentState {
  return {
    keys: new Map(),
    recent: [],
    callsSinceFresh: 0,
    pendingError: null,
    interventions: 0,
    circuitBroken: false,
    // 初始视为"久未提醒"：首次重叠立刻可报；每次提醒后进入冷却
    overlapCooldown: Number.MAX_SAFE_INTEGER,
    replay: createReplayState()
  };
}

/** 该工具是否参与跟踪（include/exclude 通配；未跟踪调用对状态机透明）。 */
export function tracked(name: string, settings: GuardSettings): boolean {
  if (settings.include.length > 0 && !settings.include.some((pattern) => pattern.test(name))) return false;
  return !settings.exclude.some((pattern) => pattern.test(name));
}

function evidenceOf(rec: KeyRecord, settings: GuardSettings): RepeatEvidence {
  return {
    tool: rec.tool,
    canonicalArguments: preview(rec.canonical, settings.argumentsPreviewChars),
    runs: rec.runs,
    resultHash: rec.hash,
    resultDigest: preview(rec.lastText || "(empty result)", 300)
  };
}

/** 收集参数对象里的全部字符串值（识别文件路径等共享目标）。 */
export function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, out);
  else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) collectStrings(item, out);
  }
  return out;
}

export type PreDecision =
  | { action: "allow" }
  | { action: "deny"; reason: string; kind: "unscoped" | "repeat" | "locked" };

/**
 * 执行前决策（I2/I3 的挂点）。
 *
 * 顺序：
 *   1. D5 无边界搜索 → 结构化拒绝（可配 allow 放行）；
 *   2. 零信息量重复 → 第一次拒绝并给逃生口，逃生结果仍相同时永久锁定。
 */
export function decidePreCall(
  state: AgentState,
  key: string,
  tool: string,
  canonical: string,
  args: Record<string, unknown> | undefined,
  settings: GuardSettings
): PreDecision {
  // D5：无边界搜索预防
  if (settings.unscopedSearch === "deny" && settings.searchTools.some((pattern) => pattern.test(tool))) {
    const scoped = args !== undefined && settings.scopeFields.some((field) => {
      const value = args[field];
      return typeof value === "string" ? value.length > 0 : value !== undefined && value !== null;
    });
    if (!scoped) {
      return finishDeny(state, settings, "unscoped", unscopedSearchDeny(tool, settings.scopeFields));
    }
  }

  const rec = state.keys.get(key);
  if (rec === undefined) return { action: "allow" };

  const evidence = evidenceOf(rec, settings);
  const baseReason = rec.locked ? lockedDenyReason(evidence) : denyReason(evidence, false);
  const reason = state.replay.replayMode ? `${baseReason}\n${replayNote()}` : baseReason;

  if (rec.locked) {
    return finishDeny(state, settings, "locked", reason);
  }

  // D1' 重放模式下降为一次即拦（思考已逐字重放，无需等待第二次同结果）
  const limit = state.replay.replayMode ? 1 : settings.repeatLimit;
  if (rec.runs < limit) return { action: "allow" };

  // runs >= limit：同结果已执行足够多次，零信息量成立
  if (rec.escapesUsed < settings.escapeRuns && rec.denied >= 1) {
    // 逃生口：模型在收到拒绝后坚持要求执行 → 放行恰好一次
    rec.escapesUsed += 1;
    rec.escapePending = true;
    rec.denied = 0;
    return { action: "allow" };
  }
  if (rec.escapesUsed >= settings.escapeRuns && rec.denied >= 1) {
    rec.locked = true;
    return finishDeny(state, settings, "locked", reason);
  }
  rec.denied += 1;
  return finishDeny(state, settings, "repeat", reason);
}

/** 记录一次干预；连续干预过多则在拒绝理由末尾附上熔断指令（I5）。 */
function finishDeny(
  state: AgentState,
  settings: GuardSettings,
  kind: "unscoped" | "repeat" | "locked",
  reason: string
): PreDecision {
  state.interventions += 1;
  let finalReason = reason;
  if (state.interventions >= settings.circuitBreakAfter && !state.circuitBroken) {
    state.circuitBroken = true;
    finalReason = `${reason}\n${circuitBreakNotice(state.interventions)}`;
  }
  return { action: "deny", reason: finalReason, kind };
}

export interface PostObservation {
  fresh: boolean;
  runs: number;
  /** I1 劝告（第二次同结果时给出，预告下次阻断）。 */
  notice?: string;
  /** D2 近似重复劝告。 */
  overlap?: string;
  /** D3 错误未解决劝告。 */
  errorWatch?: string;
  /** I4 进度锚点。 */
  anchor?: string;
  /** 逃生执行确认世界未变，刚刚锁定。 */
  lockedNow: boolean;
  /** I5 熔断指令（连续干预无进展达到阈值时给出一次）。 */
  circuitBreak?: string;
  /** I5 熔断信号：连续干预过多且无进展（由 index 计数判定）。 */
  freshProgress: boolean;
}

/** D3 判定：这个调用算不算对失败的对症处理。 */
function isRemedial(tool: string, argsStrings: string[], pending: PendingError, settings: GuardSettings): boolean {
  // 对症 = 合格的修复类工具（如 read 是 "file has not been read" 的标准解法）
  // 且对准同一个目标（与失败调用共享文件路径等字符串）。
  // 仅共享目标但换搜索类工具不算对症——那正是证据 B 的错误回避循环。
  if (!settings.remedialTools.some((pattern) => pattern.test(tool))) return false;
  if (pending.strings.length === 0) return true;
  return argsStrings.some((value) => pending.strings.includes(value));
}

/**
 * 执行后观察：维护结果哈希链、判定新鲜度，产出 I1/D2/D3/I4 劝告。
 */
export function observePostCall(
  state: AgentState,
  key: string,
  tool: string,
  canonical: string,
  hash: string,
  text: string,
  isError: boolean,
  argsStrings: string[],
  settings: GuardSettings
): PostObservation {
  const previous = state.keys.get(key);
  let fresh: boolean;
  let runs: number;
  let lockedNow = false;

  if (previous === undefined) {
    state.keys.set(key, { tool, canonical, hash, lastText: text, runs: 1, denied: 0, escapesUsed: 0, escapePending: false, locked: false });
    fresh = true;
    runs = 1;
  } else if (previous.hash !== hash) {
    // 世界变了（结果不同）：链重新计数，解除此前的重复判定
    previous.hash = hash;
    previous.lastText = text;
    previous.runs = 1;
    previous.denied = 0;
    previous.locked = false;
    if (previous.escapePending) previous.escapePending = false;
    fresh = true;
    runs = 1;
  } else {
    previous.runs += 1;
    previous.lastText = text;
    previous.denied = 0;
    if (previous.escapePending) {
      // 逃生执行返回的仍是同一结果：零信息量被证实，永久锁定
      previous.escapePending = false;
      previous.locked = true;
      lockedNow = true;
    }
    fresh = false;
    runs = previous.runs;
  }

  const observation: PostObservation = { fresh, runs, lockedNow, freshProgress: fresh };

  // I1：第二次同结果时预告下次阻断
  if (!fresh && !lockedNow && runs === settings.repeatLimit && previous !== undefined) {
    observation.notice = repeatNotice(evidenceOf(previous, settings));
  }

  // ── 全局进展计数（D4/I5） ──
  state.callsSinceFresh = fresh ? 0 : state.callsSinceFresh + 1;
  state.overlapCooldown += 1;

  // ── D2 结果重叠：不同参数反复得到近乎相同的结果（仅信息收集类工具——
  //    edit/write 的状态回执文本相似是正常现象，不算"重复搜索"） ──
  if (
    fresh
    && text.length >= 20
    && settings.overlapTools.some((pattern) => pattern.test(tool))
    && state.overlapCooldown >= Math.max(2, Math.floor(settings.overlapWindow / 3))
  ) {
    let best = 0;
    let bestTool = tool;
    let similar = 0;
    for (const entry of state.recent) {
      if (entry.key === key) continue;
      const score = lineOverlap(text, entry.text);
      if (score >= settings.overlapThreshold) {
        similar += 1;
        if (score > best) {
          best = score;
          bestTool = entry.tool;
        }
      }
    }
    if (similar > 0 && best >= settings.overlapThreshold) {
      observation.overlap = overlapNotice(bestTool, best, similar);
      state.overlapCooldown = 0;
    }
  }

  // ── D3 错误未解决 ──
  if (isError) {
    state.pendingError = {
      tool,
      key,
      digest: preview(text || "(no detail)", 200),
      strings: [...new Set(argsStrings)],
      age: 0
    };
  } else if (state.pendingError !== null) {
    const pending = state.pendingError;
    if (isRemedial(tool, argsStrings, pending, settings)) {
      state.pendingError = null; // 对症动作出现，错误视为已处理
    } else {
      pending.age += 1;
      if (pending.age >= settings.errorWatchSteps) {
        observation.errorWatch = errorWatchNotice(pending.tool, pending.digest, pending.age);
        state.pendingError = null; // 一次性劝告，避免刷屏
      }
    }
  }

  // ── D4 无进展 → I4 进度锚点 ──
  if (state.callsSinceFresh >= settings.anchorWindow) {
    observation.anchor = anchorNotice(settings.anchorWindow);
    state.callsSinceFresh = 0;
  }

  // ── I5 熔断：连续干预（拒绝或提醒）无进展达到阈值 ──
  const intervened = observation.notice !== undefined
    || observation.overlap !== undefined
    || observation.errorWatch !== undefined
    || observation.anchor !== undefined;
  if (fresh) {
    state.interventions = 0;
    state.circuitBroken = false;
  } else if (intervened) {
    state.interventions += 1;
    if (state.interventions >= settings.circuitBreakAfter && !state.circuitBroken) {
      state.circuitBroken = true;
      observation.circuitBreak = circuitBreakNotice(state.interventions);
    }
  }

  // 滑动窗口维护
  state.recent.push({ key, tool, text });
  if (state.recent.length > settings.overlapWindow) {
    state.recent.splice(0, state.recent.length - settings.overlapWindow);
  }

  return observation;
}
