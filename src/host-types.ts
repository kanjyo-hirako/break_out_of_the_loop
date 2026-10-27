/**
 * 宿主（DSH）插件面的最小结构类型。
 *
 * 与 `docs/interfaces.md` 的勘察结论一一对应；刻意不依赖 `@deepseek-ai/*`
 * 的类型包，避免构建期版本耦合。字段均为本插件实际用到的子集。
 */

/** 冻结的文本内容块（合成消息与工具结果投影共用）。 */
export interface TextBlock {
  type: "text";
  text: string;
}

export type ContentBlock = TextBlock;

/** 合成消息的来源标注（强制：无标注的上下文会被渲染成普通用户消息）。 */
export interface ContextSource {
  kind: string;
  form?: string;
  summary?: string;
}

/** 注入式用户消息（`additionalContexts` 的条目形状）。 */
export interface InjectedContext {
  role: "user";
  id: string;
  content: ContentBlock[];
  source: ContextSource;
}

/** 工具调用描述（`tools/*` 瀑布的 `exec` 参数）。 */
export interface ToolExec {
  /** 发起调用的 agent；`ctx.tools.execute()` 直调时为空。 */
  agent?: object;
  name: string;
  /** 已解析并冻结的 JSON 参数；畸形 JSON 时为原始字符串回退。 */
  arguments: unknown;
  /** 进程内关联令牌（Symbol），不可序列化，勿触碰。 */
  token?: symbol;
  [key: string]: unknown;
}

/** 工具结果（冻结；成功携带 `value`，失败携带 `error`）。 */
export interface ToolResult {
  isError: boolean;
  value?: unknown;
  error?: unknown;
  content: ContentBlock[];
  meta?: unknown;
  additionalContexts?: InjectedContext[];
  concludesTurn?: true;
}

/** `tools/pre-execute` 的决策。 */
export type PreToolDecision = { kind: "allow" } | { kind: "deny"; reason: string };

/**
 * `tools/post-execute` 的决策：
 * `accept` 保持调用成功（可替换 value/content），`block` 转为失败并携带纠正内容。
 */
export type PostToolDecision =
  | { kind: "accept"; value?: unknown; content?: ContentBlock[]; additionalContexts?: InjectedContext[] }
  | { kind: "block"; feedback: ContentBlock[]; additionalContexts?: InjectedContext[] };

/** cordis 插件上下文的最小面：只需事件瀑布注册。 */
export interface PluginContext {
  on(event: "tools/pre-execute", listener: (exec: ToolExec, next: () => Promise<PreToolDecision>) => PreToolDecision | Promise<PreToolDecision>): void;
  on(event: "tools/post-execute", listener: (exec: ToolExec, result: ToolResult, next: () => Promise<PostToolDecision>) => PostToolDecision | Promise<PostToolDecision>): void;
  on(event: "agent/pre-step", listener: (payload: { agent: object; messages: Array<{ source: ContextSource }> }, next: () => unknown) => unknown): void;
}
