# Changelog

本文件记录 `dsh-acceptance`（Agent 交付验收台）的每个发布版本。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [0.2.0] - 2026-10-13

**Agent 交付验收闭环**：开发 Agent 可以**主动**登记需求、提交交付、取回结论，独立 Agent 取证后把结构化结果写回凭证；人类保留最终决定权。
本版也是**第一次**把「验收台自己的流程」用在验收台自己身上 —— 契约、取证、返修、决定全部走本产品的凭证。

`schemaVersion` 仍为 **1**（新增字段全部可选 ⇒ 旧凭证照读、可回滚）；五态键与语义不变；宿主路由仍是 9 条（`.repairs` 仍未实现）。

### 新增

- **模型可调用工具（三个）**：`acceptance_begin_task`（逐字登记原始需求 + 初始验收契约）、`acceptance_submit_delivery`（提交交付并触发一次独立取证）、`acceptance_get_result`（只读取回结论）。身份只来自 `exec.agent.session.id`，工具参数里**不许**出现 `sessionId` / `workspace` / `cwd`。
- **委派执行体抽成共享模块**：`src/dsh/host/verification.js` —— HTTP 路由与工具**走同一条**逻辑，回信封不认识 HTTP。
- **返修闭环的契约与校验**：`validateRepairItem`（`fail` 必须带 `evidenceIds`；`unknown`/`blocked` 必须带 `unverifiedReason`）、自动返修上限 `DEFAULT_ROUND_LIMIT = 2`。
- **真机规则快照 + 可复跑核对**：`design/dsh-tool-schema-rules.json`（工具 schema 白名单，从已安装运行时源码抄下）+ `scripts/verify-schema-rules.mjs`（`npm run verify:schema`，分叉即 exit 1）。
- **工具输出契约测试** `test/tool-output.test.mjs`：复刻真机的输出校验，覆盖每个工具的**每条返回路径**。

### 修复

- **P0-1 确认动作前置**：`确认验收标准` 从面板最底部移到**状态行正下方**（`.acc-confirmline`）；清单头新增任务级批量 `全部确认（N）`。用户走查发现：两个真实任务都卡在 0 确认 —— 确认入口几乎不可发现。
- **P0-2 未确认时的下一步**：「下一步」新增最高优先级分支 —— 有未确认项时只说 `先确认验收标准…`，不再引导直接取证；`让独立 Agent 帮我验证` 在该状态下 **disabled**，并说明原因。
- **P0-3 两条取证路径同规则**：`verification.js` 之前**没有** `confirmedByUserAt` 过滤（未确认项也会被验证），而 `tools.js` 对未确认项硬挡 —— 同一份凭证一条拒一条放。现在两条都**只对已确认项取证**，未确认项被**跳过并记录**（`provenance.skippedUnconfirmed`），一条都没有则拒（`no-confirmed-criteria` / `criteria-not-confirmed`）。
- **委派入口名改正**：真机 `0.2.1-alpha.2` 的入口是 **`ctx.subagents.startActivation(spec)`**，不是 `ctx.subagents.start(provider, request)`（后者**不存在**）。回执字段是 `childId`。守卫 G21 钉死。
- **工具注册与输出**：真机 `register()` 要求 `output: { schema, render }` 必填（缺了会把**整批**工具一起带崩）；输出受**强制校验**（`additionalProperties: false` 时多一个未声明 key 就整次调用失败）。
- **委派提示词不完整**：原先只说「证据要可寻址」，没说**格式**，而校验器要求 `observation` 恰好 3 个全角 `｜`、`command` 给整数 `exitCode`、`file` 给绝对路径 + 行号 —— 真机曾**连续四轮委派全废**。现已把五类 `locator` 的格式逐条写进提示词。
- **五态显示名在契约层与客户端对齐**（旧值「待验证 / 未验证 / 被阻塞」）。
- **客户端 Hook 顺序回归**：`confirmAllUnconfirmed` 曾落在两个 early return 之后 ⇒ 首屏与二次渲染 hook 数不一致 ⇒ React error 310，**验收台页签整页白屏**。已移到 early return 之前，并由守卫 G24 钉住。

### 变更

- 错误消息不再把「服务不提供该 API」说成「服务不存在」：`no-subagents` → **`no-delegation-api`**，并把**当场读到的值**带出来。
- 断言数 77 → **100**（gate 14 / host 46 / tool-output 5 / client 35）；守卫 11 → **24**。

### 说明

- **仍未实现**：`.repairs` 路由（契约与校验已就绪，路由未接）；`.import`（模式 B）与逐条人工判定**未受** `confirmedByUserAt` 约束 —— 这是同一类不一致的第三个入口，已知未修。
- **界面**没有列出「上一轮被跳过了哪些项」（返回值一侧完整）。
- **只读内核隔离**：子会话日志已实证 `sandbox/mode { source:'delegation' }` 与 `approval/policy { policy:'never' }` 由委派瞬间捕获；**「翻转成 read-only 后写被内核拒绝」未跑** ⇒ 按 PRD R-4 只宣传「独立验收」，界面与导出必须标注「权限未隔离」。
- `scope.fingerprint` 首版恒 `null` = 「版本未知」。**禁止**用变更文件列表派生哈希冒充。
- 本版**没有**实现证据过期判断与 `.repairs` 路由；P1（跳过项的界面呈现、模式 B 的确认约束）留待下一版。



首次使用与验收流程引导。本版**只改客户端呈现与文案**：`schemaVersion` 仍为 1、五态键与语义不变、宿主 9 条路由不变（唯一的一处宿主改动是 `/api/acceptance.health` 多了一个能力字段）。

### 新增

- **首次进入的开始页**：`开始一次交付验收` + 一句话说明 + 三步（`写下需求 → 确认验收项 → 查看证据并作出决定`）+ 主按钮 `新建验收任务`；`查看示例` 是折叠的静态引导，显式标注「示例，不会写入凭证也不会创建任务」。已有任务但未选中时是另一句「选择一个任务继续」。
- **验收项设置引导**：标题与通过条件的示例、反例提示（「功能正常」「体验不错」太宽泛）、缺通过条件时的**非阻断**提醒、`复制验收项整理提示词`（只产文本，插件不调用模型、不自动生成验收项）。
- **验证方式说人话**：主入口 `让独立 Agent 帮我验证`，次入口 `我已经有检查结果`（展开后才出现验收包与粘贴 JSON）；内部模式编号降为次级标注，主流程不再出现。
- **状态驱动的「下一步」**：底部决定栏按宿主的 counts 给唯一一句指引（已证实未通过 → 生成修复说明 / 环境阻塞 / 尚无法判断 / 待验收 / 一条证据都没有 / 全部通过）。
- **宿主新增能力字段**：`/api/acceptance.health` 返回 `capabilities.delegate`（由 `subagents` 服务是否存在推导）。界面据此在**动作之前**说明「当前宿主没有可用的委派能力」并给出替代路径；字段缺失（老宿主）视为未知，**不禁用**按钮。
- **修复说明按四类分组**：已证实未通过 / 尚无法判断 / 环境阻塞 / 待验收；通过的项一条不列（只写「另有 N 项已通过」）。`导出验收记录` 旁写明「导出当前验收凭证，不会触发新的验证」。

### 变更

- 新建任务表单：`这次开发做了什么？（可选）` / `把你最初交给开发 Agent 的需求粘贴到这里`，主按钮 `创建并设置验收项`；创建成功后自动选中该任务并落到验收项区。
- `确认这一条` → `确认验收标准`；版本未知处补一句「为什么未知」（`当前没有取得可靠的代码版本快照…`），仍**不生成任何指纹**。
- 断言数 62 → 77（gate 14 / host 30 / client 33）。

### 说明

- 本版**没有**实现代码版本指纹，也没有实现证据过期判断：界面只保留事实解释，不显示确定的「已过期」。
- P1（可复制的示例模板、逐状态文案优化）不在本版，留待 v0.1.3。

### 发布

- tag `v0.1.2` · 提交 `9766dfe` · 2026-10-12 · [GitHub Release](https://github.com/PolinniZhong/dsh-acceptance/releases/tag/v0.1.2)
- 平台：**GitHub**（tag + Release）。**npm 本版未发** —— registry 上还没有这个包，首个版本要先做一次带 OTP 的本地 `npm publish` 建包，之后才回到 OIDC 可信发布（`.github/workflows/publish.yml` 已就位）。

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
[0.1.2]: https://github.com/PolinniZhong/dsh-acceptance/releases/tag/v0.1.2
