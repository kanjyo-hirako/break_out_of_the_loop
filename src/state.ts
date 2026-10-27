/**
 * 循环检测状态机（纯逻辑，无宿主依赖）。
 *
 * 核心判据——"零信息量重复"：
 *   同工具 + 同规范化参数 + 结果哈希与上次逐字节相同 ⇒ 再执行一次不携带
 *   任何新信息。两次执行即可证明（repeatLimit=2），第三次起阻断，
 *   保留一次逃生口（世界可能变化），逃生结果仍相同则永久锁定。
 */

import { preview, wildcardToRegExp } from "./canonical.ts";
import { denyReason, lockedDenyReason, repeatNotice, unscopedSearchDeny, type RepeatEvidence } from "./messages.ts";

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

export interface AgentState {
  keys: Map<string, KeyRecord>;
}

export function createAgentState(): AgentState {
  return { keys: new Map() };
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
      return { action: "deny", reason: unscopedSearchDeny(tool, settings.scopeFields), kind: "unscoped" };
    }
  }

  const rec = state.keys.get(key);
  if (rec === undefined) return { action: "allow" };

  if (rec.locked) {
    return { action: "deny", reason: lockedDenyReason(evidenceOf(rec, settings)), kind: "locked" };
  }

  if (rec.runs < settings.repeatLimit) return { action: "allow" };

  // runs >= repeatLimit：同结果已执行足够多次，零信息量成立
  if (rec.escapesUsed < settings.escapeRuns && rec.denied >= 1) {
    // 逃生口：模型在收到拒绝后坚持要求执行 → 放行恰好一次
    rec.escapesUsed += 1;
    rec.escapePending = true;
    rec.denied = 0;
    return { action: "allow" };
  }
  if (rec.escapesUsed >= settings.escapeRuns && rec.denied >= 1) {
    rec.locked = true;
    return { action: "deny", reason: lockedDenyReason(evidenceOf(rec, settings)), kind: "locked" };
  }
  rec.denied += 1;
  return { action: "deny", reason: denyReason(evidenceOf(rec, settings), false), kind: "repeat" };
}

export interface PostObservation {
  fresh: boolean;
  runs: number;
  /** I1 劝告文本（第二次同结果时给出，预告下次阻断）。 */
  notice?: string;
  /** 逃生执行确认世界未变，刚刚锁定。 */
  lockedNow: boolean;
}

/**
 * 执行后观察：维护结果哈希链、判定新鲜度、产出劝告。
 */
export function observePostCall(
  state: AgentState,
  key: string,
  tool: string,
  canonical: string,
  hash: string,
  text: string,
  settings: GuardSettings
): PostObservation {
  let rec = state.keys.get(key);
  if (rec === undefined) {
    rec = { tool, canonical, hash, lastText: text, runs: 1, denied: 0, escapesUsed: 0, escapePending: false, locked: false };
    state.keys.set(key, rec);
    return { fresh: true, runs: 1, lockedNow: false };
  }

  const fresh = rec.hash !== hash;
  let lockedNow = false;
  if (fresh) {
    // 世界变了（结果不同）：链重新计数，解除此前的重复判定
    rec.hash = hash;
    rec.lastText = text;
    rec.runs = 1;
    rec.denied = 0;
    rec.locked = false;
    if (rec.escapePending) rec.escapePending = false;
    return { fresh: true, runs: 1, lockedNow: false };
  }

  rec.runs += 1;
  rec.lastText = text;
  rec.denied = 0;
  if (rec.escapePending) {
    // 逃生执行返回的仍是同一结果：零信息量被证实，永久锁定
    rec.escapePending = false;
    rec.locked = true;
    lockedNow = true;
  }

  const observation: PostObservation = { fresh: false, runs: rec.runs, lockedNow };
  if (!lockedNow && rec.runs === settings.repeatLimit) {
    observation.notice = repeatNotice(evidenceOf(rec, settings));
  }
  return observation;
}
