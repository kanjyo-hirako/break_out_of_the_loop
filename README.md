# dsh-loop-guard

> **Structural loop-breaking guard for DeepSeek Harness (DSH) agents.**
> 在工具决策链上物理切断"零信息量"的重复调用，并给模型指出活路——
> 而不是在它已经退化时再劝一句。

当 agent 陷入工具循环（同一个调用反复执行、结果逐字节相同、思考内容都在重放）时，
上下文被垃圾块填满、响应越来越慢、之后无论发什么都会继续循环。
内置的 `dsh-repeat-tool-reminder` 是**纯劝告**的哨兵；本插件是**结构性阻断**的闸门。

---

## 目录

- [背景：这个循环长什么样](#背景这个循环长什么样)
- [功能](#功能)
- [与内置插件的区别](#与内置插件的区别)
- [技术实现](#技术实现)
- [配置参考](#配置参考)
- [安装与部署](#安装与部署)
- [开发与测试](#开发与测试)
- [能力边界（诚实说明）](#能力边界诚实说明)
- [License](#license)

---

## 背景：这个循环长什么样

三份真实会话证据：

| 证据 | 现象 |
|---|---|
| A | 「搜索文件内容」同参调用连续两次，结果完全一致，中间无任何思考 |
| B | 无边界 grep 打进 `node_modules`/`target`，250 条匹配长列表 + 20MB 溢出；`edit` 报 "file has not been read" 后不去 read，反而继续 grep"定位行号"（行号早已拿到） |
| C | 模型**明确说出**"我又卡在同一个 grep 上了，改用 read 推进"，紧接着又刷了十几个一模一样的 grep（同正则、同结果、思考逐字重放） |

**证据 C 是关键**：模型"知道"自己在循环、也说出了正确方案，但生成的动作照样重放。
对这种退化态，往上下文里追加建议（无论追加多少条）都撬不动概率质量——
唯一有效的干预是**把重复的路物理堵死**，让生成被迫分叉。

## 功能

### 检测器

| 检测器 | 抓什么 | 判据 | 误报防线 |
|---|---|---|---|
| **D1 零信息量重复** | 同参同结果连发 | 同工具 + 规范化参数 + **结果哈希逐字节相同** | 结果变化即重置；轮询（结果在变）永不触发 |
| **D1' step 级重放** | 思考+回复+调用整段逐字重放 | 相邻两次 attempt 的流签名相同（`agent/assistant-stream`） | 签名 <100 字符不作数 |
| **D2 近似重复漂移** | 换着花样搜同一批东西 | 不同参数的结果行集合 Jaccard 重叠 ≥ 0.9 | 同 key 精确重复归 D1 管，不重复报 |
| **D3 错误回避循环** | 报错不处理、绕着走 | 失败后 N 步内无对症动作（read / 共享路径） | 对症动作出现即解除 |
| **D4 无进展** | 原地打转 | 连续 N 次调用无任何新结果 | 新结果立刻清零 |
| **D5 噪声预防** | 无边界搜索撑爆上下文 | 搜索类调用缺 `path`/`include` 作用域 | 可配 `allow` 放行 |

### 干预阶梯（按侵入性递增）

| 档 | 手段 | 触发 |
|---|---|---|
| I1 | 结构化提醒（合成消息，来源标注 `loop-guard`） | 第二次同结果、D2/D3/D4 信号 |
| I2 | **结果摘要回填**：拒绝理由里直接带回上一份结果的摘要，消灭"信息丢了所以重搜"的动机 | 拒绝时 |
| I3 | **硬阻断**：`tools/pre-execute` 返回 deny，调用不执行；理由 = 哈希证据 + 结果摘要 + 可照抄的替代动作 + 逃生口 | 第三次同结果请求（重放模式下第二次） |
| I4 | 进度锚点：注入"当前目标 / 已完成 / 下一步"短锚点 | D4 触发 |
| I5 | **熔断**：连续干预无进展 → 命令模型停手、向用户汇报 | 干预计数达阈值 |

### 一次典型拦截（模型看到什么）

```text
[loop-guard] Duplicate tool call blocked: `grep` with identical arguments has already
executed 2 times and returned byte-identical results (hash 3f9a12c40b7d8e01). No new
information can come from running it again.
Previous result (preserved in the conversation above): match at 1550, match at 1755…
Do NOT call `grep` with these arguments again. Take ONE different action that moves the
task forward (read/edit a file, run a command, use another tool, or ask the user). If you
have concrete evidence that the world changed since the last run, repeat the exact call
one more time and it will be executed exactly once.
```

## 与内置插件的区别

内置 `dsh-repeat-tool-reminder`（`dsh` 基础包默认开启）是本插件的参照物与互补件。
它的 README 原文承认：阻断"留给后来的 listener"——本插件就是那个 listener。

| | `dsh-repeat-tool-reminder` | **dsh-loop-guard** |
|---|---|---|
| 信条 | Advisory, not veto（只劝告） | 结构性切断 + 可升级阻断 |
| 判据 | 仅 `(工具, 规范化参数)` 精确相等，**不看结果** | 参数 + **结果哈希** + 重放签名 + 结果重叠 |
| 变体覆盖 | 近似变体明确不支持（README 原文） | D2 结果重叠抓近似漂移 |
| 错误回避循环 | 无对应机制 | D3 专项检测 |
| 首次动作 | 第 3 次重复发提醒（然后 5、8） | 第 2 次同结果即提醒；第 3 次**拒绝执行** |
| 超过最高阈值 | **永久沉默**（README 原文） | I5 熔断并要求向用户汇报 |
| 新用户消息 | **清零计数**（跨轮循环救不了） | 计数不清零（状态挂 agent 生命周期） |
| 会话恢复/压缩 | 内存态，恢复即清空 | 同为内存态，但状态在守卫侧、跨压缩存活 |
| 误伤阀门 | `thresholds`/`exclude` | 结果哈希判据 + 逃生口 + `noticeOnly` + include/exclude |
| 提醒内容 | "换个方法吧" + 参数预览 | 哈希证据 + 结果摘要回填 + 可照抄的替代动作 |

两者可以共存：内置守卫管"轻度重复的柔性提醒"，本插件管"零信息量重复的硬截停"。
嫌提醒重叠时可开 `noticeOnly` 对比灰度。

## 技术实现

### 架构

```text
tools/pre-execute ──► decidePreCall ──► {allow} | {deny, reason}
   (执行前闸门)         │  D5 无边界搜索
                        │  D1 零信息量（结果哈希链 + 逃生口 + 锁定）
                        └─ D1' 重放模式 → 阻断门槛降为 1

tools/post-execute ──► observePostCall ──► additionalContexts (I1/I4/I5)
   (执行后决策)          │  结果哈希链维护、新鲜度判定
                         │  D2 结果重叠 / D3 错误未解决 / D4 无进展
                         └─ I5 干预计数 → 熔断指令

agent/assistant-stream ──► observeStreamFrame ──► ReplayState
   (纯观察)                 start/chunk/end 帧 → 思考+回复+调用签名
                            相邻签名逐字相同 ⇒ replayMode
```

### 核心判据：零信息量

> 同工具 + 同规范化参数 + **结果哈希与上次逐字节相同** ⇒ 再执行一次携带的信息量严格为零。

- **规范化**：参数深度按键排序后 `JSON.stringify`（属性顺序不构成身份差异）；
- **结果哈希**：`sha256(value|error + content)`，任何字段变化都产生新指纹；
- **证明链**：两次同结果执行即证明零信息量 → 第三次请求**拒绝执行**；
- **逃生口**：拒绝后模型坚持要求执行则放行恰好一次（世界可能真的变了）；
  逃生结果仍相同 ⇒ **永久锁定**；逃生结果不同 ⇒ 链重置、一切照常；
- **轮询安全**：结果在变（`H1→H2→H3`）永不触发。

这套判据是确定性的——**不依赖模型配合**，这正是它对退化态有效的原因。

### 为什么拒绝理由里要"回填结果摘要"

循环的一个成因是模型**以为信息丢了**所以重搜。拒绝理由直接带上一份结果的摘要
（含哈希与关键行），连"再查一次"的动机一起消灭；同时给出可照抄的下一步
（"调用 `read`，offset=1500"）而不是抽象的"换个方法"——证据 C 表明模型
说得出口"改用 read"但做不到，那就不让它自己选。

### 宿主接口（全部为 DSH 现有公开缝）

| 接口 | 用途 | 依据 |
|---|---|---|
| `tools/pre-execute` | 阻断闸门：`{kind:'deny', reason}` | `dsh-tools` 决策瀑布（deny 经同一管线成为工具结果反馈） |
| `tools/post-execute` | 结果哈希采集 + `additionalContexts` 注入 | 内置守卫同通道（来源标注强制） |
| `agent/assistant-stream` | D1' 签名聚合（start/chunk/end 帧） | `dsh-agent` 事件面（`{agent, frame}` 通知型） |

合成消息与 `@deepseek-ai/dsh-llm` 的构造器同构（uuid + 深冻结 + 强制 `source` 标注），
本地实现仅 20 行，避免构建期依赖。接口勘察记录见 [docs/interfaces.md](docs/interfaces.md)。

### 模块结构

```text
src/
├── index.ts       # 插件入口：Config schema + apply() 接线两个瀑布与流事件
├── state.ts       # 检测状态机（纯逻辑）：D1–D5 判定、逃生/锁定、干预与熔断
├── replay.ts      # D1' 流签名聚合与重放判定（纯逻辑）
├── canonical.ts   # 参数规范化、结果哈希、行集合重叠度
├── messages.ts    # 干预文案（证据 + 摘要回填 + 替代动作 + 逃生口）
├── config.ts      # schemastery schema + fail-loud 校验
└── host-types.ts  # 宿主缝的最小结构类型
```

状态机与文案是纯函数（无宿主依赖），可单测；`index.ts` 只做接线。
状态挂 `WeakMap<Agent, AgentState>`，per-agent 隔离、跨用户消息与压缩存活。

## 配置参考

```yaml
- name: 'dsh-loop-guard'
  config:
    repeatLimit: 2          # 同结果执行几次即认定零信息量
    escapeRuns: 1           # 逃生口次数（拒绝后坚持重试的放行额度）
    noticeOnly: false       # true = 安全模式，只提醒不阻断
    include: []             # 仅跟踪这些工具（通配符）；空 = 全部
    exclude: [job_output, job_kill, job_list, ask_user_question, 'schedule_*', todo_write]
    searchTools: [grep, search, search_file_content]   # D5 搜索类工具
    scopeFields: [path, include]                       # D5 必带作用域字段
    unscopedSearch: deny    # deny | allow
    argumentsPreviewChars: 300
    overlapThreshold: 0.9   # D2 行集合 Jaccard 阈值
    overlapWindow: 10       # D2 滑动窗口
    errorWatchSteps: 3      # D3 失败后 N 步无对症动作则提醒
    remedialTools: [read]   # D3 视为对症动作的工具
    anchorWindow: 5         # D4 连续 N 次无新结果注入锚点
    replayDetection: true   # D1' step 级重放
    minReplayChars: 100     # D1' 签名最小长度
    circuitBreakAfter: 6    # I5 连续干预无进展的熔断阈值
```

非法配置在装入时抛出明确错误（沿用内置守卫的 fail-loud 约定，绝不静默回退）。

## 安装与部署

本仓库即一个标准 DSH **bundle**（`dsh.bundle.patch` + `cordis.patch.yml` +
`locale/` + `icon.svg`），通过官方 `plugin_manager` 安装，不触碰 `app.asar`：

```powershell
npm install && npm run build        # 本地目录安装是链接 checkout，先构建 lib/
```

```json
plugin_manager { "action": "install_bundle", "target": "D:\\something_else\\web\\out_of_loop" }
```

以安装结果 `application: applied` 为准（`restart-required` 则重启 DSH）。
自带补丁默认 **`noticeOnly: true`**（只提醒）；灰度确认后改 `false` 开阻断档。

**详细步骤**：[docs/INSTALL.md](docs/INSTALL.md)
**发布到 GitHub 插件市场**：[docs/PUBLISHING.md](docs/PUBLISHING.md)（索引格式、
git/npm 双源、`market/index.json` 校验、发版流程）

## 开发与测试

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # node --test（41 项单测，进程内运行）
npm run build       # tsc → lib/
```

- 测试覆盖：规范化/哈希、状态机全决策表（含逃生与锁定、轮询安全）、
  D2/D3/D4 信号、D1' 帧聚合、I5 熔断、插件端到端（mock 瀑布）；
- `scripts/asar_extract.py`：从 DSH 安装目录的 `app.asar` 精确提取官方接口文档
  与参考实现，供开发参照（第三方源码放 `reference/`，不入版本库）。

## 能力边界（诚实说明）

**能做**：机械性切断 A 类严格重复（高把握）；让 B/C 类循环尽早暴露并可升级阻断；
从源头减少 D 类噪声；触发时在会话里留下清晰的守卫介入痕迹。

**不能做**：

1. **不治已病**——已被循环污染的会话仍需 `/compact` 或新开会话，本插件防复发；
2. **不改变模型退化本身**——它切断动作循环，不消除长上下文导致的迟钝；
3. **零误伤无法承诺**——残余风险集中在"合法的幂等轮询"（结果暂时不变），
   由逃生口 + `exclude` + `noticeOnly` 三层兜底；误伤的代价是多绕一步，
   漏拦的代价是整个会话报废，这个不对称性是开阻断档的依据；
4. `agent/assistant-stream` 的帧形状依据官方类型声明实现，**尚待真机会话冒烟验证**；
5. 计数为内存态，会话重启后从零开始（与内置守卫相同）。

## License

MIT
