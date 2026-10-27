/**
 * D1' step 级重放检测（纯逻辑）。
 *
 * 证据形态：相邻两次 Assistant attempt 的"思考 + 回复 + 工具调用"签名逐字节
 * 相同 —— 整个 step 在被机械重放。这是比参数重复更强的循环铁证（正常工作
 * 不可能产生两次逐字相同的生成）。
 *
 * 信号来源：`agent/assistant-stream` 事件的 start / chunk / end 帧；
 * committed end 帧到达时对累积签名定判。
 */

/** `agent/assistant-stream` 帧的最小形状（防御式取用，缺字段则忽略）。 */
export interface StreamFrame {
  type: "start" | "chunk" | "end";
  attemptId?: unknown;
  chunk?: {
    type?: unknown;
    text?: unknown;
    argumentsDelta?: unknown;
    name?: unknown;
  };
  outcome?: { kind?: unknown };
}

export interface ReplayState {
  /** attemptId → 累积签名（思考 + 回复 + 工具调用参数增量）。 */
  buffers: Map<string, string>;
  /** 最近一次 committed attempt 的签名。 */
  lastSignature: string | null;
  /** 连续签名相同的次数（与上一次相比的匹配数）。 */
  replayStreak: number;
  /** 重放模式：最近两次 committed attempt 逐字相同。 */
  replayMode: boolean;
}

export function createReplayState(): ReplayState {
  return { buffers: new Map(), lastSignature: null, replayStreak: 0, replayMode: false };
}

/**
 * 观察一帧流数据。返回 `true` 表示 replayMode 发生了变化
 * （调用方可据此立即调整策略）。
 */
export function observeStreamFrame(replay: ReplayState, frame: StreamFrame, minChars: number): boolean {
  const attemptId = typeof frame.attemptId === "string" ? frame.attemptId : undefined;

  if (frame.type === "start") {
    if (attemptId !== undefined) replay.buffers.set(attemptId, "");
    return false;
  }

  if (frame.type === "chunk") {
    if (attemptId === undefined) return false;
    const chunk = frame.chunk;
    if (chunk === undefined) return false;
    let buffer = replay.buffers.get(attemptId);
    if (buffer === undefined) {
      buffer = "";
      replay.buffers.set(attemptId, buffer);
    }
    const type = chunk.type;
    if ((type === "reasoning-delta" || type === "text-delta") && typeof chunk.text === "string") {
      replay.buffers.set(attemptId, buffer + chunk.text);
    } else if (type === "tool-call-delta") {
      const name = typeof chunk.name === "string" ? chunk.name : "";
      const args = typeof chunk.argumentsDelta === "string" ? chunk.argumentsDelta : "";
      replay.buffers.set(attemptId, buffer + `\n[call ${name}]${args}`);
    }
    return false;
  }

  // end 帧：committed 才参与签名判定；abandoned 直接丢弃
  const signature = attemptId !== undefined ? (replay.buffers.get(attemptId) ?? "") : "";
  if (attemptId !== undefined) replay.buffers.delete(attemptId);
  if (frame.outcome?.kind !== "committed") return false;
  const before = replay.replayMode;

  if (signature.length < minChars) {
    // 签名过短（如单句回复）不构成重放证据
    replay.lastSignature = null;
    replay.replayStreak = 0;
    replay.replayMode = false;
  } else if (signature === replay.lastSignature) {
    replay.replayStreak += 1;
    replay.replayMode = true;
  } else {
    replay.lastSignature = signature;
    replay.replayStreak = 0;
    replay.replayMode = false;
  }
  return before !== replay.replayMode;
}

/** 测试与诊断用：重置到初始状态。 */
export function resetReplay(replay: ReplayState): void {
  replay.buffers.clear();
  replay.lastSignature = null;
  replay.replayStreak = 0;
  replay.replayMode = false;
}
