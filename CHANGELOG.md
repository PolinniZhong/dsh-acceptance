# Changelog

本文件记录 `dsh-acceptance`（Agent 交付验收台）的每个发布版本。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [0.1.1] - 2026-10-11

首个公开发布版。核心是「任务级的凭证工作台」：逐条原始需求 ↔ 证据的映射，以及证据的版本绑定与过期。

### 新增

- **宿主半（9 条 `/api/acceptance.*` 路由）**：`health` / `tasks` / `receipt` / `criteria` / `verify` / `package` / `import` / `decision` / `export`。
  路由全部走 `ctx.connection.fetch.register`（精确匹配、参数走 query、无 `PUT`）。
- **`TaskReceipt` 契约（`schemaVersion = 1`）**：任务契约、不可变的验收项定义、只增不改的轮次结论、可寻址证据、返修轮次、用户最终决定。
- **五态并列**：`pending` / `pass` / `fail` / `unknown` / `blocked` —— **没有** `score` / `passRate` / `completion`，也不折算成比率。
- **两种写入模式**，产出同一种轮次：模式 A（宿主委派子 Agent 取证，`outputSchema` 钉死契约）、模式 B（生成验收包 → 外部取证 → 粘贴结构化结果导入）。两者同规矩：**无证据的通过一律拒收**。
- **证据可寻址性**：五类证据（`command` / `file` / `url` / `screenshot` / `observation`）在**写入时**校验，定位不到就拒绝写入并报错，不降级成空 locator。
- **客户端界面（`conversation.view` 页签「验收台」）**：工具栏 → 一行五态筛选 → 左清单右详情 → 证据默认折叠 → 底部决定栏；
  五态显示名 `待验收 / 通过 / 未通过 / 无法判断 / 环境阻塞`；逐条人工判定写成一轮 `producedBy: 'manual'` 的轮次（历史只增不改）。
- **11 条守卫（G1–G11）** + **62 项行为断言**（域逻辑 14 / 宿主半 29 / 客户端产物 19）。

### 说明

- 首个版本的包**由本地 `npm publish` 建出来**（可信发布一般绑在已存在的包上）；之后版本改走 GitHub Actions 的 OIDC 可信发布（`.github/workflows/publish.yml` 已就位）。
- 客户端产物 `dist/client.js` **提交进仓库**：浏览器跑的是它，不是源码。
- `scope.fingerprint` 首版恒为 `null`（「版本未知」）：设计上**禁止**用变更文件列表派生哈希冒充版本指纹。

[0.1.1]: https://github.com/PolinniZhong/dsh-acceptance/releases/tag/v0.1.1
