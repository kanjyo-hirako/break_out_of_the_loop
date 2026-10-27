/**
 * 配置 schema 与 fail-loud 校验（沿用内置守卫的约定：
 * 非法配置在装入时抛错，绝不静默回退默认值）。
 */

import z from "@deepseek-ai/schemastery";
import { wildcardToRegExp } from "./canonical.ts";
import type { GuardSettings } from "./state.ts";

/** 面向用户的配置 schema（composition YAML 中可写）。 */
export const Config = z.object({
  /** 同结果执行达到该次数即认定零信息量（2 = 两次同结果即证明）。 */
  repeatLimit: z.number().default(2),
  /** 逃生口次数：收到拒绝后坚持重试时允许的额外执行（结果仍相同则永久锁定）。 */
  escapeRuns: z.number().default(1),
  /** 安全模式：只提醒，永不阻断。 */
  noticeOnly: z.boolean().default(false),
  /** 仅跟踪这些工具（通配符）；空 = 全部。 */
  include: z.array(z.string()).default([]),
  /** 不跟踪这些工具（对状态机透明：不计数也不重置）。 */
  exclude: z.array(z.string()).default([
    "job_output",
    "job_kill",
    "job_list",
    "ask_user_question",
    "schedule_*",
    "todo_write"
  ]),
  /** D5：视为"搜索类"的工具（通配符）。 */
  searchTools: z.array(z.string()).default(["grep", "search", "search_file_content"]),
  /** D5：搜索类调用必须携带其一的作用域字段。 */
  scopeFields: z.array(z.string()).default(["path", "include"]),
  /** D5 策略：deny = 无边界搜索直接拒绝并提示加作用域；allow = 放行。 */
  unscopedSearch: z.string().default("deny"),
  /** 阻断理由里参数预览的字符上限。 */
  argumentsPreviewChars: z.number().default(300),
  /** D2：结果重叠度阈值（0-1，行集合 Jaccard）。 */
  overlapThreshold: z.number().default(0.9),
  /** D2：重叠度量的滑动窗口（最近 N 次调用结果）。 */
  overlapWindow: z.number().default(10),
  /** D3：失败后 N 次调用无对症动作则劝告。 */
  errorWatchSteps: z.number().default(3),
  /** D3：视为"对症动作"的工具（通配符）。 */
  remedialTools: z.array(z.string()).default(["read"]),
  /** D4：连续 N 次无新结果则注入进度锚点。 */
  anchorWindow: z.number().default(5)
});

/** fail-loud 校验并编译运行期设置。 */
export function validateSettings(config: {
  repeatLimit: number;
  escapeRuns: number;
  noticeOnly: boolean;
  include: string[];
  exclude: string[];
  searchTools: string[];
  scopeFields: string[];
  unscopedSearch: string;
  argumentsPreviewChars: number;
  overlapThreshold: number;
  overlapWindow: number;
  errorWatchSteps: number;
  remedialTools: string[];
  anchorWindow: number;
}): GuardSettings {
  const {
    repeatLimit,
    escapeRuns,
    noticeOnly,
    include,
    exclude,
    searchTools,
    scopeFields,
    unscopedSearch,
    argumentsPreviewChars,
    overlapThreshold,
    overlapWindow,
    errorWatchSteps,
    remedialTools,
    anchorWindow
  } = config;

  if (!Number.isInteger(repeatLimit) || repeatLimit < 2) {
    throw new Error(`loop-guard: invalid repeatLimit ${repeatLimit} — must be an integer >= 2`);
  }
  if (!Number.isInteger(escapeRuns) || escapeRuns < 0) {
    throw new Error(`loop-guard: invalid escapeRuns ${escapeRuns} — must be an integer >= 0`);
  }
  if (unscopedSearch !== "deny" && unscopedSearch !== "allow") {
    throw new Error(`loop-guard: invalid unscopedSearch "${unscopedSearch}" — must be "deny" or "allow"`);
  }
  if (!Number.isInteger(argumentsPreviewChars) || argumentsPreviewChars < 1) {
    throw new Error(`loop-guard: invalid argumentsPreviewChars ${argumentsPreviewChars} — must be an integer >= 1`);
  }
  if (scopeFields.length === 0) {
    throw new Error("loop-guard: `scopeFields` must not be empty");
  }
  if (!(overlapThreshold > 0 && overlapThreshold <= 1)) {
    throw new Error(`loop-guard: invalid overlapThreshold ${overlapThreshold} — must be in (0, 1]`);
  }
  if (!Number.isInteger(overlapWindow) || overlapWindow < 3) {
    throw new Error(`loop-guard: invalid overlapWindow ${overlapWindow} — must be an integer >= 3`);
  }
  if (!Number.isInteger(errorWatchSteps) || errorWatchSteps < 1) {
    throw new Error(`loop-guard: invalid errorWatchSteps ${errorWatchSteps} — must be an integer >= 1`);
  }
  if (!Number.isInteger(anchorWindow) || anchorWindow < 2) {
    throw new Error(`loop-guard: invalid anchorWindow ${anchorWindow} — must be an integer >= 2`);
  }

  return {
    repeatLimit,
    escapeRuns,
    noticeOnly,
    include: include.map(wildcardToRegExp),
    exclude: exclude.map(wildcardToRegExp),
    searchTools: searchTools.map(wildcardToRegExp),
    scopeFields: [...scopeFields],
    unscopedSearch: unscopedSearch === "allow" ? "allow" : "deny",
    argumentsPreviewChars,
    overlapThreshold,
    overlapWindow,
    errorWatchSteps,
    remedialTools: remedialTools.map(wildcardToRegExp),
    anchorWindow
  };
}
