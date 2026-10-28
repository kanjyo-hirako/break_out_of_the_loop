# 本地安装指南（装进你自己的 DSH）

本包是一个标准 DSH **bundle**（`package.json` 声明 `dsh.bundle.patch`，
`cordis.patch.yml` 插入插件行，`locale/` 提供显示元数据，`icon.svg` 提供图标）。
安装走 DSH 官方的 `plugin_manager`，**不要手改 profile 的 `package.json`/`cordis.patch.yml`
或在 profile 目录里跑 pnpm**——`install_bundle` 会做这些事。

## 前置

- 本地已安装 DSH（本项目针对 `0.2.1-rc.x` 开发，见 `market/index.json` 的 `engines.dsh`）；
- Node.js ≥ 20（构建用）。

## 步骤

### 0. 桌面端（Desktop）用户先看这里

桌面端有**专属的 `desktop` profile**（Electron 保留，与网页端的 `web` profile
互相独立，各自安装各自生效）。本插件是 Host-only bundle（无浏览器端部分），
桌面/网页共享同一套 agent 运行时核心，因此完全兼容桌面端。两条安装通道：

**通道 A：命令行**（先打开一次桌面端完成 profile 初始化，然后**完全退出桌面端**）：

```powershell
dsh plugin --profile desktop add D:\something_else\web\out_of_loop
```

**通道 B：应用内**——在桌面端会话里让 agent 执行
`plugin_manager { "action": "install_bundle", "target": "<本包绝对目录>" }`
（此时 current profile 即 `desktop`）。

桌面端 profile 通常在**启动时**应用组合补丁（只有 web 模板是实时重载），
所以安装后按 `restart-required` 提示**重启桌面端**即可生效。

### 1. 构建

```powershell
cd D:\something_else\web\out_of_loop
npm install
npm run build      # tsc → lib/（含 .d.ts）
npm test           # 可选：确认 41 项单测通过
```

> 本地目录安装是**链接 checkout**：`lib/` 必须先构建好，之后改代码要重新
> `npm run build` 并重启 DSH 才会加载新一代模块。

### 2. 用 plugin_manager 安装

在 DSH 会话里（creator 模式或直接调工具）执行：

```json
plugin_manager { "action": "install_bundle", "target": "D:\\something_else\\web\\out_of_loop" }
```

- `target` 填**本包的绝对目录**；
- 非 Full access（完全权限）下每次 `plugin_manager` 调用都需要批准，属正常；
- 只有当安装脚本被点名批准后才传 `approvedBuilds`。

### 3. 读安装结果

安装结果里的 **`application: applied`** 才表示生效；同时看 `warnings`：

| 结果 | 含义 | 动作 |
|---|---|---|
| `applied` | 已生效（新 bundle 可走 HMR） | 继续验证 |
| `restart-required` | 未生效 | 重启 DSH |
| `failed` | 安装失败 | 把错误发回来诊断 |
| `overridden` | 被更高优先级组合层覆盖 | 检查 profile 补丁顺序 |

### 4. 验证

- 设置 → 插件页应出现 **“循环守卫 / Loop Guard”** 行（标题来自 `locale/zh.json`、`locale/en.json`）；
- 用 `cordis_inspect_query` 查 `loop-guard` 行的 Config schema；
- 跑一个真实会话观察 `[loop-guard]` 前缀的提醒是否出现在工具结果之后。

### 5. 灰度与开阻断

仓库自带的 `cordis.patch.yml` 默认 **`noticeOnly: true`（只提醒不阻断）**。
观察提醒命中率后开阻断档：

```yaml
- insert:
    - id: loop-guard
      name: 'dsh-agent-loop-guard'
      config:
        noticeOnly: false      # 开启结构性阻断
        # 其它字段见 README「配置参考」；行上 config 是整体声明，改则写全所需字段
```

重新安装（或改完再 `install_bundle`）即可。

## 升级 / 卸载

- **升级**：市场不支持原地升级（官方限制：uninstall 后再 install）；本地目录则
  `git pull && npm run build` 后重装并重启（替换已安装包需要重启才加载新 JS）；
- **卸载**：`plugin_manager { "action": "remove_bundle", "target": "<同上>" }`。

## 常见问题

- **装上了但没看到提醒**：确认 `noticeOnly` 与 `exclude` 配置；`job_output`、`todo_write`
  等默认排除项对状态机透明，不会触发；
- **与内置 `dsh-repeat-tool-reminder` 提醒重叠**：两者可共存（轻提醒 + 硬截停），
  嫌吵可关掉内置守卫的行（override 该行 `disabled: true`）；
- **合法轮询被误伤**：把轮询工具加进 `exclude`，或临时开 `noticeOnly`。
