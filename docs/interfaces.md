# M0 接口勘察备忘 —— DSH 工具决策链与插件契约

> 勘察对象：DSH 0.2.1-rc.3（`app.asar` 内嵌实现与文档）
> 参考实现：`@deepseek-ai/dsh-repeat-tool-reminder/lib/index.js`（MIT）
> 结论：以下接口足以实现 Loop Guard 全部设计（M1–M3），无需修改 DSH 本体。

## 1. 插件入口契约

cordis 插件导出三件套（与内置守卫完全一致）：

```ts
import z from "@deepseek-ai/schemastery";

export const name = "loop-guard";
export const Config = z.object({ /* ... */ });
export function apply(ctx, config) {
  ctx.on("tools/post-execute", async (exec, result, next) => { /* ... */ });
}
```

- `Config`：`@deepseek-ai/schemastery`（zod 风格）schema；非法配置须在 `apply`
  内 fail-loud 抛错（内置守卫的约定：绝不静默回退默认值）。
- 监听器随 `ctx` 生命周期自动释放。

## 2. 事件瀑布（waterfall）

监听器签名 `(...事件参数, next)`；`next()` 返回下游决策；默认终值由 `dsh-tools`
给出。上游可改写下游返回值（内置守卫即"包住 next() 的结果再追加字段"）。

### 2.1 `tools/pre-execute`（执行前闸门 —— 阻断就发生在这里）

```ts
ctx.on("tools/pre-execute", (exec, next) => Decision)
// Decision = { kind: 'allow' } | { kind: 'deny', reason: string }
// 默认终值: { kind: 'allow' }
```

- `deny` → 调用**不执行**，`reason` 经同一管线成为工具结果的失败反馈
  （`ToolRuntime.execute` 把 deny 也路由过完整瀑布，因此 `post-execute` 依然可见）。
- 这就是 README 干预阶梯 I3（硬阻断）的挂点。

### 2.2 `tools/post-execute`（执行后决策 —— 计数/提醒/替换）

```ts
ctx.on("tools/post-execute", (exec, result, next) => PostToolDecision)
// PostToolDecision =
//   { kind: 'accept', value?, content?, additionalContexts? }   // 保持成功；可替换 value/content
// | { kind: 'block',  feedback, additionalContexts? }           // 转为失败，feedback 为纠正内容
// 默认终值: { kind: 'accept' }
```

- `additionalContexts`：合成上下文数组；循环缓冲后作为**注入的 user message**
  追加在该步工具结果之后，模型可见、来源可标注、可从会话日志重建。
- **来源标注是强制性的**：不带 `source` 的上下文会在派生历史里渲染成普通用户
  消息（内置守卫注释原文："the label is load-bearing"）。
- 计数放这里的原因：**被 deny 的调用也流经本瀑布**，锤一个被拒调用正是要抓的循环。

### 2.3 `agent/pre-step`（步准入）

```ts
ctx.on("agent/pre-step", ({ agent, messages }, next) => ...)
// messages[i].source.kind === 'user' 可识别用户输入
```

- 可 reject 一步或替换进入该步的消息（`PreStepDecision`），本插件用于
  错误未解决检测（D3）与用户消息边界处理。

## 3. 数据形状

### 3.1 `exec`（调用描述）

| 字段 | 类型 | 说明 |
|---|---|---|
| `exec.agent` | Agent \| undefined | 无 agent 的直接 `ctx.tools.execute()` 调用为 undefined——这类调用没有模型可提醒，跳过 |
| `exec.name` | string | 工具名 |
| `exec.arguments` | 已解析并冻结的 JSON 值 | 畸形 JSON 时为原始字符串回退；属性顺序不构成身份差异 |
| `exec.token` | Symbol | 进程内关联令牌，**不可序列化** |

### 3.2 `result`（工具结果，冻结）

```
成功: { isError: false, value, content, meta?, additionalContexts?, concludesTurn? }
失败: { isError: true,  error,  content, meta?, additionalContexts? }
```

- `value`：工具输出的结构化值；`content`：渲染给模型的投影块。
- **结果哈希**取材：`value`（成功）或 `error`（失败）+ `content` 的规范化序列化。

## 4. 合成消息构造

内置守卫内联了 `@deepseek-ai/dsh-llm` 的消息构造器：

```js
createUserMessage({ content: [{ type: 'text', text }], source: { kind, form, summary } })
// = deepFreeze(structuredClone({ ...input, role: 'user', id: randomUUID() }))
```

本插件本地实现同构的 10 行辅助（uuid + 深冻结），避免对 `dsh-llm` 的构建期依赖。

## 5. 构建与依赖（对照内置守卫的 package.json）

| 项 | 内置守卫 | 本插件 |
|---|---|---|
| 运行时依赖 | `@deepseek-ai/schemastery ~3.18.5` | 同 |
| peer | `@deepseek-ai/cordis ~4.0.5`, `dsh-agent`, `dsh-tools` | 同（仅类型用） |
| 产物 | 单文件 `lib/index.js`（ESM，bundle） | 同（esbuild 打包） |
| 测试 | `dsh-agent-loop-testkit`（devDep） | 纯逻辑单测优先，testkit 为可选集成层 |

`@deepseek-ai/*` 系列包在公共 npm 源可得（已验证 registry.npmjs.org 返回 200）。

## 6. 对本插件设计的映射

| 设计 | 挂点 | 接口能力 |
|---|---|---|
| I3 硬阻断 | `tools/pre-execute` | 返回 `{kind:'deny', reason}`（结构化错误三件套写进 reason） |
| I2 结果替换 | `tools/pre-execute` deny + `post-execute` 补充上下文，或 `post-execute` accept 替换 content | deny 换新颖块最稳：旧结果不会重复进入上下文 |
| I1 提醒 | `post-execute` 的 `additionalContexts` | 与内置守卫同通道，来源 `{kind:'loop-guard', form, summary}` |
| I4 锚点 | `additionalContexts` / `agent/pre-step` | 注入锚点消息 |
| D3 错误未解决 | `agent/pre-step` + post-execute 观察 | 消息序列里匹配失败结果与后续动作 |
| D1' 思考重放 | 由 post-execute 的 exec/result 侧信号近似；思考文本另需 assistant 消息访问 | M2 确认；退路：用"调用+结果"双哈希代替 |

## 7. 遗留确认项（不阻塞 M1）

1. `assistant/message` 的读取途径（D1' 完整版需要思考文本）；
2. bundle 清单格式（`plugin_manager install_bundle` 的目标形态）；
3. `dsh-agent-loop-testkit` 集成测试的性价比。
