# 发布到 GitHub 上的 DSH 插件市场

## 机制先讲清楚

DSH 的插件市场**没有中央商店**：所谓"市场"是**用户自行配置的索引 URL**
（一份 format 1 的 JSON 文档，见 `market/index.json`）。Web UI 的 **Discover**
标签页与 `plugin_market` 工具读这些索引；安装仍走 `plugin_manager install_bundle`。

因此"发布到 GitHub 上的插件市场"= 三件事：

1. 把**本仓库**（一个合规 bundle）发布到可安装的源（git 或 npm）；
2. 写一份**市场索引**（`market/index.json`），条目指向你发布的源；
3. 把索引 JSON 托管到一个**稳定 https URL**（GitHub raw 或 Pages），
   用户把该 URL 加进 DSH 的索引源即可浏览并安装。

官方提醒（原文）：**索引是市场方的声明、未签名**——真正装进去的是安装目标的
清单。所以索引写得透明（仓库链接、commit 钉死、版本可核对）就是你的可信度。

## 一、准备 bundle（本仓库已完成）

| 件 | 状态 |
|---|---|
| `package.json` 声明 `dsh.bundle.patch` | ✅ |
| `cordis.patch.yml` 插入 `loop-guard` 行 | ✅ |
| `locale/en.json` + `locale/zh.json`（`meta.title`/`meta.description`） | ✅ |
| `icon.svg`（原创，SVG ≤256 KiB） | ✅ |
| `files` 覆盖 lib/locale/icon/patch | ✅ |
| `market/index.json`（format 1 样例） | ✅（发布前替换占位符） |

## 二、选择分发源

### 方案 A：git 源（免 npm 账号，推荐起步）

索引条目的 `source` 指向你的 GitHub 仓库 + **40 位 commit SHA 钉死**：

```json
"source": {
  "type": "git",
  "url": "https://github.com/your-account/dsh-agent-loop-guard",
  "commit": "<发布点的 40 位小写 commit SHA>"
}
```

市场会生成安装参数 `git+https://github.com/your-account/dsh-agent-loop-guard.git#<commit>`。
若包在仓库子目录，加 `"path": "sub/dir"`。

### 方案 B：npm 源

```json
"source": { "type": "npm", "registry": "https://registry.npmjs.org" }
```

生成安装参数 `dsh-agent-loop-guard@0.1.0`。注意：

- **包名 `dsh-agent-loop-guard` 已验证未被占用**（2026-10 查询 registry 返回 404）。
  原名 `dsh-loop-guard` 与 npm 上的同名包冲突，已弃用；发布前建议再查一次
  `npm view dsh-agent-loop-guard` 确认仍可用，然后尽快 `npm publish` 占位；
- 若想改用自己 npm 账号的 scoped 名（如 `@your-npm-name/dsh-agent-loop-guard`），
  同步改三处：`package.json` 的 `name`、`cordis.patch.yml` 行的 `name`、
  `market/index.json` 的 `name`（含 `versions` 不变）；
- `npm publish` 前 `prepublishOnly` 会自动 `build` + `validate-index`。

**npm 发布操作序列**（先完成本地安装验证再发版——版本号发布后不可覆盖）：

```powershell
npm login            # 浏览器登录 npmjs.com（需注册账号、验证邮箱、开启 2FA）
npm whoami           # 确认身份
npm view dsh-agent-loop-guard   # 确认名字仍可用（应报 404）
npm publish          # 自动执行 build + validate-index
npm view dsh-agent-loop-guard   # 验证已上架
git tag v0.1.0 && git push --tags   # 标记发布点
```

非 scoped 包默认公开，无需 `--access public`。发布完成后把本文件顶部索引里
`versions[].source` 换成上面的 npm 源（或为新版本追加条目），再 `validate-index`。

## 三、写市场索引（market/index.json）

format 1 的关键字段（完整可执行规则是官方 `@deepseek-ai/dsh-plugin-market-index`，
本仓库已装为 devDep）：

```jsonc
{
  "format": 1,                                   // 必须为 1
  "title": { "en": "...", "zh": "..." },          // 必填；映射必须含 "en"
  "description": { ... },                         // 可选
  "metadata": {                                   // 可选
    "categories": { "<id>": { "title": {...} } },
    "labels":     { "<id>": { "title": {...} } },
    "sortKeys":   { "<id>": { "title": {...}, "order": "asc|desc" } }
  },
  "plugins": [{
    "name": "dsh-agent-loop-guard",                     // 必填，npm 包名规则
    "title": { ... }, "description": { ... },     // 可选本地化
    "icon": "https://... 或 data:image/...;base64,...",  // 可选（data ≤32 KiB）
    "author": "...", "homepage": "https://...",   // 可选
    "repository": { "url": "https://..." },       // 可选
    "metadata": { "category": "<已声明的id>",
                  "keywords": ["..."], "labels": ["<已声明的id>"] },
    "versions": [{                                // 必填，非空；版本不重复
      "version": "0.1.0",                         // 精确 SemVer
      "publishTimestamp": 1793106000,              // Unix 秒，整数
      "source": { ... },                          // 见上：git 或 npm
      "engines": { "dsh": ">=0.2.1-rc.3" }        // 可选 SemVer 范围
    }]
  }]
}
```

**发布前必须校验**（官方约定）：

```powershell
npm run validate-index
# market/index.json OK — 1 plugin(s), index "Loop Guard Plugin Index"
#   dsh-agent-loop-guard@0.1.0 -> git+https://github.com/.../dsh-agent-loop-guard.git#<commit>
```

### engines.dsh 的坑

当前 DSH 版本是 `0.2.1-rc.3`（**预发布**）。按 SemVer 规则，`>=0.2.0` 这类
范围**不会匹配**带预发布后缀的版本；要匹配需写 `>=0.2.1-rc.3`。
不确定就先省略 `engines`（兼容性检查会放行）。

## 四、托管索引

把 `market/index.json` 放到稳定 https 地址，例如：

```
https://raw.githubusercontent.com/your-account/dsh-agent-loop-guard/main/market/index.json
```

或 GitHub Pages。要求：**https、无重定向、URL 无 query/fragment**（DSH 拒绝跟随
重定向——raw.githubusercontent.com 直链没问题）。

## 五、用户怎么接入

1. DSH → Discover（发现）标签页 → 添加索引源，粘贴上面的 URL；
   （或让 agent 用 `plugin_market`/`setIndexes` 配置）
2. 搜 "Loop Guard" → 安装（走 `plugin_manager`，用户批准）；
3. 每个版本条目自带安装参数（`target` + `registry`），用户无需手动构造。

## 六、发新版本的流程

1. 改版本号（`package.json` `version`）→ `npm test && npm run build`；
2. 打 tag / 发布 npm；
3. 在 `market/index.json` 的 `versions` **新增**一条（不要删旧的——市场没有
   原地升级，用户是卸载再装；旧条目让旧用户可回退），填新 `publishTimestamp`
   与新 `commit` SHA；
4. `npm run validate-index` 通过后推送；
5. 让索引 URL 指向最新内容（同一 URL 原地更新即可，DSH 有 10 分钟缓存）。

## 七、发布检查清单

- [ ] `npm test` 41 项通过、`npm run build` 干净
- [ ] `npm run validate-index` OK
- [ ] `market/index.json` 无占位符（your-account / commit / author 已替换）
- [ ] `versions[].source.commit` 是发布点的真实 40 位 SHA
- [ ] `engines.dsh` 能匹配目标 DSH 版本（预发布规则！）
- [ ] `locale/en.json` + `locale/zh.json` 描述准确、`icon.svg` 是原创/可再分发
- [ ] README 的安装章节与实际行为一致
- [ ] 仓库 LICENSE（MIT）与 `package.json` 一致
