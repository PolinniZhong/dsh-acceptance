# acceptance-console · L1 作用域指令

> 只在**真的动这个目录里的文件**时注入。产品边界看 `../02_PRD与SDD/PRD.md`，契约看 `../02_PRD与SDD/SDD.md`，
> 选型理由看 `../99_暂存文档/决策记录.md`。本文件只讲**在这里写代码必须知道的事**。
> 自设上限 40 KiB。
>
> ⚠️ **本文件不是到处都会被自动注入的。** DSH 按目录作用域注入它；在别的 Agent Harness 平台上
> **没有任何东西会替你注入** —— 换平台或刚接手本项目时，改本目录之前请**主动读它一遍**，
> 否则会重复踩这里已经写下来的坑。跨平台交接看 `../HANDOFF.md`。

## 1. 这个目录是什么

`dsh-acceptance`（显示名「验收台」）—— 一个 `conversation.view` 全页面插件。宿主半注册 HTTP 路由、
持有 `TaskReceipt` 凭证与全部判定逻辑；客户端半只渲染，不做任何判定。

```
src/dsh/host/index.js     apply(ctx, config) + 9 条路由 + 会话上下文读取
src/dsh/host/domain.js    纯函数域（无 I/O、无 ctx、无模型）—— 所有判定都在这儿
src/dsh/host/verification.js 模式 A 的委派执行体（**路由与工具共用这一条**，回信封不认识 HTTP）
src/dsh/host/tools.js     模型可调用工具（begin_task / submit_delivery / get_result）
src/dsh/host/store.js     凭证存储（原子写）
src/dsh/client/client.js  单文件 CommonJS + React（浏览器侧；样式里的设计 Token 由 sync-tokens.mjs 整块内联）
scripts/build-client.mjs  打包 + external 漂移检查 + 源码哈希 stamp
scripts/verify-project.mjs 守卫 G1–G22
design/tokens.css          UI 设计 Token 快照（真源是跨项目 skill dsh-plugin-ui）
test/gate.test.mjs        域逻辑行为断言（node --test）
test/host.test.mjs        宿主半集成断言（假 ctx 真挂 apply，验路由与状态码）
test/tool-output.test.mjs  工具**输出**契约断言（复刻真机输出校验：每工具的每条返回路径都过一遍）
test/client-bundle.test.mjs 客户端**产物**行为断言（真跑 __ModuleLoader__ 收下的 factory + 真渲染）
dist/client.js            发布产物，提交进仓库
```

## 2. 三条最容易白干的纪律

1. **浏览器跑的是 `dist/client.js`，不是 `src/dsh/client/client.js`。** 改完客户端必须 `npm run build:client`。
   忘了重建的表现是「改了半天没变化」。
2. **host 半改了必须重启 DSH。** 代码进内存后不会热换 —— 而且旧代码**答得很正常、不报错**，
   你会以为改动生效了。改完 host 先记住「还没生效」。
3. **客户端里的 CSS 是模板字符串，内部禁止出现反引号。** 写一个就提前结束字符串，
   报错位置常常指在很远的地方。大改样式后先 `node --check src/dsh/client/client.js`。

第 1、2 条是同一类错误的两个方向：**改了 A 却验证 B**。

## 3. 判定权在谁手里

- **`domain.js` 是唯一判定处。** 状态派生（`deriveCurrentStatuses`）、证据合法性（`validateEvidence`）、
  凭证合法性（`validateReceipt`）、id 分配（`nextCriterionId`）、导出（`buildMarkdownExport` /
  `buildAcceptancePackage`）全在这里，且都是纯函数 —— 可被 `node --test` 直接调。
- **客户端零判定**（守卫 G7 会把关）：不 `require` host 代码、不引用判定函数名、不给 `status` 赋值。
  它拿到的是 host 算好的结论。
- **不要在两处实现同一条规则。** 新增规则时先问「它属于 `domain.js` 吗」；属于就只写在那里，
  路由层只做「取参数 → 调纯函数 → 序列化」。

## 4. 契约里最容易被改坏的三件事

1. **`criteria[]` 是不可变定义。** 确认（`confirmedByUserAt`）之后**不得原地改**；要改只能打 `deletedAt`
   再新增。**`rounds[]` 才是追加写的结论。** 把 `status` 写回 `criteria[]` 会让「同一验收项跨轮次的历史」
   永久丢失 —— 这是唯一会实质损坏产品能力的改动。
2. **`nextCriterionId` 永不复用已删除的 id**（G8）。`known` 集合必须**含已删除项**，
   否则「AC-02 被删后新项又叫 AC-02」会把历史证据串到另一个需求上。
3. **`deriveCurrentStatuses` 不回退。** 最新一轮没提到某验收项时，保留上一次的结论，
   但 `staleInLatestRound` 必须为真，界面显示「本轮未复查」。**不许偷偷沿用旧 pass 却不加标注。**

## 5. 证据可寻址性（写入时即拒绝，不降级）

| `kind` | `locator` 必须长成 |
|---|---|
| `command` | 命令原文（单行），且 `exitCode` **必填整数** |
| `file` | `<绝对路径>:<行>` 或 `<绝对路径>:<起>-<止>` |
| `url` | `http(s)://` 开头 |
| `screenshot` | 绝对路径 + `.png/.jpg/.jpeg/.webp` |
| `observation` | `谁｜何时｜在哪台机器或会话｜观察到的现象`（**恰 3 个 `｜`**） |

失败形态是**拒绝写入 + 报错**。不许降级成空 locator、不许猜、不许「先存下再说」。
`ref.type` 必须等于 `kind`；相对路径不算可寻址。守卫 G5 拿 6 条合法 + 15 条非法反例把关。

## 6. 守卫与自检

```bash
node scripts/verify-project.mjs   # G1–G22，22/22 才算过
npm test                          # pretest 会先重建客户端；95 个行为断言（gate 14 + host 43 + tool-output 5 + client 33）
```

| 守卫 | 钉住什么 |
|---|---|
| G1 | 路由全在 `/api` 之下、精确路径、一 path 一次注册、无 `PUT`、源码不得出现 `webServer` |
| G2 | 四个折算词零命中（**先剥离 `const EN = {…}` 英文字典再搜**） |
| G3 | `score`/`passRate`/`completion`/`passedCount`/`totalCount` 零命中 |
| G4 | `STATUSES`/`ORIGINS`/`PRODUCERS`/`SCHEMA_VERSION` 恰如契约 |
| G5 | 五类证据 6 条合法全通过 + 15 条非法**全被拒** |
| G6 | `dist/client.js` 的 stamp 与当前客户端源码哈希一致（忘了重建就红） |
| G7 | 客户端零判定 |
| G8 | `nextCriterionId` 单调且不复用已删除 id |
| G9 | 委派 `outputSchema` 只用宿主白名单关键字、根是 object、`id` 的 enum 恰是未删除项 |
| G10 | 客户端调用到的每条 `/api/acceptance.*` 路由，宿主半都注册过（跨半契约） |
| G11 | 设计 Token：消费方的 Token 块与 `design/tokens.css` 逐字一致、块外零裸色值、字号/圆角都在尺度表内 |
| **G12** | 工具的 `parameters` **与** `output.schema` 都只用真机快照允许的关键字，**且每个工具都必须有 `output { schema, render }`** |
| — | G9/G12 的白名单来源 = `design/dsh-tool-schema-rules.json`（真机快照）；**过期核对**跑 `npm run verify:schema`（要运行时；分叉即 exit 1） |
| **G13** | 工具层不写 `requirementText`（除建任务那一次）、不写 `decision`、不替用户确认验收项 |
| **G14** | 工具的 `parameters` 里不出现 `sessionId` / `workspace` / `cwd` —— 身份只能来自 `exec.agent` |
| **G15** | 返修项必须带 `evidenceIds` 或 `unverifiedReason`（12 条反例含 7 条必须被拒） |
| **G16** | 五态显示名各自不同、与评审定稿逐字一致，且客户端与导出同一套词（**不许两态同名**） |
| **G17** | 三轴不合并：顶层无 `status`；结论态仍在 `evaluations[]`；运行态不与五态字面量重叠 |
| **G18** | 自动返修上限恰为 2 轮；到限后必须要求人类决定 |
| **G19** | 工具引导节若存在，其 `text()` 必须先查 `ctx.tools.get(name, agent)`（尚未装 ⇒ 明说未做） |
| **G20** | 工具边界不抛：无 Agent 上下文 / 非法参数 / 没有委派服务，三条都回信封 |
| **G21** | 委派用真机的 `startActivation(spec)` / 回执读 `childId` / `spec.signal` 必给；**假运行时必须同形状** |
| **G22** | 委派提示词把五类 `locator` 的**确切格式**写给验收 Agent（与校验器同步） |

**「守卫全绿」不等于「守卫在跑」。** G16 首版就是**空转**的：它只查五个词「都出现过」，于是把
`blocked: '未通过'`（把环境阻塞合并进未通过）判成通过。**加规则时顺手把「它会红」也演一遍** ——
把违规写进源码、看它 FAIL、再还原。2026-10-12 逐条演过 G13/G14/G15/G16/G18 都会红。

**UI 设计 Token 的真源不在本仓库** —— 它是跨项目的 skill `dsh-plugin-ui`（本机 `~/.agents/skills/dsh-plugin-ui`，symlink）。
本仓库的 `design/tokens.css` 只是快照；两个消费方（原型 Demo + `src/dsh/client/client.js`）都用该 skill 的
`scripts/sync-tokens.mjs` 整块内联，**不许手抄**。客户端那份内联在 `const STYLE` 的模板字符串里，锚点是
`/* dsh-plugin-ui · 插入锚点 */` —— 脚本按锚点插，不靠人摆位置；**真源里出现反引号、`${` 或反斜杠会被脚本直接拦下**，
因为内联进模板字符串会毁掉消费方，而这种错只在浏览器里现形（构建不报错）。
G11 会把四件事变红：快照落后于真源、内联副本被手改、Token 块之外出现裸色值或尺度表外的字号/圆角、
`src/` 下出现「带颜色字面量却没登记」的样式文件（这一项是**遍历**出来的，不靠手写清单）。

**加规则就要加反例。** 只写「正例通过」的守卫挡不住任何回归 —— G5 的价值全在 15 条非法反例。
**禁用词连「不许有 X」的注释里也不能出现**（G2 首跑就抓到了两行这样的注释），
否则守卫要么误报、要么被迫开一个豁免口子，而豁免口子会慢慢吃掉整条规则。

`test/host.test.mjs` 用假 `ctx` 真的挂起 `apply()`，所以**重启 DSH 之前**就能验路由接线、状态码与错误分派。
它替代不了真机验证：`Request` 是本进程构造的，认证与客户端 bundle 的 serving 路径都不在这里发生。

**已做过的真机验证（2026-10-10，第二个实例 3099，记录在 `../99_暂存文档/真机冒烟-2026-10-10/README.md`）：**
索引 HTML 里出现包名（0 → 1）、`health` 200、浏览器里「验收台」页签出现、凭证渲染出五态与证据卡、
模式 B 导入带证据 ⇒ 状态变 `pass`、`.package` / `.export` 正常、无活会话委派 ⇒ 409 且不写轮次、
`requestBody: 'buffered'` 正常。
**端到端写入也是在这个实例里点出来的**：浏览器里「新建验收任务 → 添加验收项 → 生成验收包 → 粘贴导入一轮
⇒ 通过 1 + 证据卡 + 逐轮记录 → 记录决定（接受交付）→ 导出凭证」六步全通，逐字日志见该 README §7。
**模式 A 的两个分支也都验过了**（同一天下午，该 README §8）：无活会话 ⇒ 409 渲染成错误条；在一个新会话里让 Agent
活着之后再点「开始委派取证」⇒ 约 9 秒后落一轮 `kind=verify / producedBy=agent`，取证项 `pass`，带两条可寻址证据
（`command` 带 workdir + 命令 + 退出码 0；`file` 带绝对路径 + 行号 + 摘录），`provenance.fingerprint` 为 `null`。
**客户端至此把宿主 9 条路由全消费了**（G10 detail：`客户端 9 条 ⊆ 宿主 9 条；客户端暂未使用：（无）`）。

## 7. 存储

- 默认根 `<homedir>/.dsh/acceptance`，凭证目录 `<根>/acceptance/<taskId>.json`。
  `config.dataRoot` 可覆盖（测试用）。
- `taskId` 同时是文件名，受 `SAFE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/` 约束。
  **非法直接抛，不做清洗** —— 清洗会把两个不同的任务悄悄映射到同一个文件。
- 写入是原子写：`mkdir 0o700` → 临时文件 `.${pid}.${hex}.tmp`（`0o600`）→ `rename`，失败删临时文件。
- `list()` 把读不出来的文件计入 `broken` 并**照实报出来**，不跳过、不静默丢弃。

## 8. 路由（`ctx.connection.fetch.register`，不是 `webServer`）

四条硬约束，违反任一条会抛异常且**抛在进程启动期**：

1. **path 必须在 `/api` 之下**（否则 `assertFetchRoute` 抛 `connection: invalid exact Fetch route …`）。
2. **精确匹配不是前缀** —— 路径参数不工作，**参数一律走 query**。
3. **同一 path 只能注册一次** —— GET/POST 必须写进同一个 `methods` 数组，再按 `request.method` 分派。
4. `methods` 不能空、不能重复。

`register` 内部已 `owner.effect`，返回值即 disposer。host `inject` 必须含 `"connection"`。

已实现的 9 条：`.health` `.tasks` `.receipt` `.criteria` `.verify` `.package` `.import` `.decision` `.export`。
**未实现**：`.repairs`（返修任务）—— SDD §9 表的 10 条里唯一缺的一条。

### 8.1 错误响应有两种形态，客户端两种都要接

- **单点错误** → `{ ok: false, error: "一句中文" }`（`requireString` / `readJson` 抛出，自带 `statusCode`）。
- **批量校验失败** → `{ ok: false, errors: ["…", "…"] }`（`appendRound` / `validateReceipt` 的聚合结果）。
- **host 里抛出的异常一律变 500**（`route()` 的 catch 兜底），所以「预期是 4xx 的输入」必须在
  handler 里显式挂上 `statusCode`。
- **解析用户粘贴的 `payload` 要自己 try/catch**：`JSON.parse` 裸抛会被记成 500，真出故障时就
  分不清「用户贴错了」和「我们挂了」。反例见 `test/host.test.mjs` 的
  「导入时 payload 是坏 JSON 字符串 ⇒ 400 不是 500」。

### 8.2 模式 A（`.verify`）：以「承诺点」分层的失败处置

`ctx.subagents.startActivation(spec)` 那一行就是**承诺点**。它之前失败 ⇒ 4xx 且**一条轮次都不写**；之后失败 ⇒ **写一轮 `blocked`**、
HTTP **仍 200** 且带 `blocked: true`（决策记录 D-018）。

| 位置 | 具体失败 | 处置 |
|---|---|---|
| 之前 | 没有可用的 `startActivation` / `ctx.agents.get(sessionId)` 给 `undefined` / provider 不在 `runtime.list()` / 没有未删除的验收项 | **4xx**，不写轮次 |
| 之后 | 启动抛 / 执行 reject / 超时 / `structured === undefined` / 规范化有错 / `appendRound` 或 `validateReceipt` 失败 | **`blocked` 轮次**（`evaluations: []`，`provenance.phase` 记 `'start'`/`'run'`），200 |

- **绝不解析 `output` 自由文本。** `structured === undefined` 时，那段文字写得再确定也记 `blocked` ——
  从自然语言猜结论会把「未验证」污染成「通过」。这条有反例测试（文本写着「全都通过了」）。
- **`evidenceId` 与 `round` 由宿主分配**，不向模型索要；模型只给 `kind` / `text` / `locator`（+ 可选 `excerpt` / `capturedAt` / `exitCode`）。
- **漏项由宿主显式补成 `unknown`** 并写明原因，**不靠** SDD 的「本轮未复查」静默陈旧机制（决策记录 D-019）。
- `outputSchema` 只用宿主白名单关键字，`criteria[].id` 用 `enum` 钉死未删除项 —— **G9 专门守这条**。
- `run` 用完必须 `dispose()`（失败路径也要），且清理异常**不许盖住**结论。
- `provenance.fingerprint` 恒 `null`；`timeoutMs` 默认 `600000`；`agentOptions` 只在显式传了正整数 `maxTokens` 时给。
- **错误响应两种形态照旧**（§8.1）：4xx 走 `{error}`，`blocked` 轮次走 200 的正常响应体。客户端两条路径都要接。
- **`.health` 报 `capabilities.delegate`**（v0.1.2）：由 `subagents` 服务是否存在推导，界面据此在**动作之前**说明「没有委派能力」并给替代路径。
  它**不是保证** —— 服务在也可能因没有活着的会话 Agent 而 4xx；字段缺失（老宿主）等于**未知，客户端不许禁用按钮**。

### 8.3 模式 B（`.import`）：**必须与模式 A 同规矩**（决策记录 D-021、D-022）

模式 B 是保底通道，不是**降低结论标准**的通道。两条硬规则：

1. **证据要一起落库。** `draft.evidence` 必须逐条过 `validateEvidence`，拒重复 id、拒 `round` 与当前轮次错配，
   合格才 `merged = { ...receipt, evidence: [...receipt.evidence, ...incoming] }` 再 `appendRound`。
   漏掉这一步的后果不是「少一个字段」：`evidenceIds` 全指不到东西 ⇒ `validateReceipt` 拒收整轮 ⇒
   **模式 B 永远记不了「通过」**（真机冒烟实测，见 P-012）。
2. **无证据的通过一律拒收**，与模式 A 同一条硬规则（L0 §10 第 2 条、SDD `:309`）。

三条实现纪律：

- **任意一条不合格 ⇒ 整轮拒收，一条证据也不落**（`producedBy: 'pasted'` 的轮次同理）。
- 「无证据的通过」这个检查要放在 **`appendRound` 之后**：`appendRound` 才知道「这个 criterionId 不存在」，
  顺序反了会把「指向不存在的验收项」说成「没有证据」，盖掉真正的原因。
- **改这条规则时，会有一条既有测试变红。** 那不是实现改错了 —— `test/host.test.mjs` 里曾有一条
  用零证据的 `pass` 断言 200 的用例，它**保护的是违规行为**。此时改测试，不改规则。

## 9. 客户端侧

- `ROUTE` 常量全部是**去掉前导 `/` 的相对路径**（`api/acceptance.health`）—— 浏览器要的是相对形态。
- 响应**逐字段运行时校验**再收；类型不对当作 `"missing"` 处理，**不抛**。宿主可能老、字段可能缺。
- 会话级状态（用户「看到哪儿」）放模块级 `pageState = new Map()` + `readPage/writePage`。
  **不要**做成组件内部 state —— 切走再回来会丢。
- 五态必须有**文字标签**，不能只靠颜色。`order: 80` 是**约定不是锁**（同号不报错、只顺序不定），
  装之前先枚举 `ctx.slots.entries('conversation.view')` 复核。
- 已实测占用：`chat=0` / `trajectory=10` / `loreflow-copilot=66` / `loreflow-session=66` / `skill-trace=70` / `my-entry=100`。
- **写入只有一个闸门**：所有提交都走 `run(work)` —— 置 `busy` → 清错 → 提交 → 出错把宿主返回的
  `{errors:[…]}` 逐条显示 → `finally` 复位。按钮的 `disabled` 由同一个 `busy` 兜住，避免连点提交两轮。
  客户端**只提交操作**（建任务 / 验收项 op / 模式 B 导入 / 记录决定），结论一律由宿主落盘（守卫 G7 把关）。
- **`.package` 与 `.export` 回的是 Markdown 文本，不是 JSON**，要用 `getText` / `postText`；
  按 JSON 解会当场炸。而失败时回的**仍是 JSON**（`{error}` / `{errors:[…]}`）——
  「成功按文本收、失败按 JSON 解」是两条不同的路，别合并。

## 10. 构建

- esbuild 在本机**装不上**（`npm install` 报 `DEPTH_ZERO_SELF_SIGNED_CERT`）。
  `node_modules/esbuild` 是指向 `10_DSH_Skill_Trace/node_modules/esbuild` 的**符号链接**，
  只为了让离线构建能跑。恢复联网后应换成真实安装并删掉这个链接。
  也可显式指定：`DSH_ACCEPTANCE_ESBUILD=/绝对路径/esbuild/lib/main.js`。
- 构建脚本做了三件额外的事：`wrap()` 套 `window.__ModuleLoader__.load({id, factory})` 外壳；
  **产物里残留 seed 表之外的 `require(...)` 就 `throw`**（否则浏览器里表现为插件空白）；
  尾部写 `// dsh-acceptance:client-build <hash>` stamp 供 G6 校验。
- **首屏必须有默认选中。** 列表里有任务时，进页面就要打开最近更新的那一条（`.tasks` 已按 `updatedAt` 倒序）；
  列表非空却显示「还没有验收任务」会让人以为**插件没装上**（真的发生过一次）——「一个都没有」与「有但没选中」必须是两句不同的话。
  默认选中走 `pickDefaultTask(list, current)`：**已经选过就不动它**（列表请求失败时 `tasks` 是空的，那时候清掉用户的选择更糟）。
- 构建时那句 `Node's package format requires that CommonJS files in a "type": "module" package use the ".cjs" file extension.`
  来自 Skill Trace 那份 esbuild 的 package.json，**不是本项目的问题**，构建是成功的。

## 11. 装载（本地 `link:` 插件要动**三处**）

**先问一句：这个 App 现在用哪个 profile？** 2026-10-11 新版桌面端（**0.2.1-alpha.2**）改用了
`~/.dsh/profiles/desktop`（进程参数里显式传这个目录）；旧版用的是 `tauri`。
**换 profile 就等于插件没装** —— 表现就是「页签不见了」，而插件本体一个字都没坏（决策 D-030）。
判断当前 profile 的命令：

```bash
ps -Ao pid=,command= | grep -E "dsh-desktop-host|dsh web" | grep -v grep   # 参数里那个目录就是当前 profile
```

三处（以 `desktop` 为例，`tauri` 同理）：

```jsonc
// ~/.dsh/profiles/desktop/package.json
"dependencies": {
  "dsh-acceptance": "link:/Users/zhongwentuo/DeepSeek Harness Native/14_Agent 交付验收台/acceptance-console"
},
"dsh": { "profile": { "bundles": [ /* … */ "dsh-acceptance" ] } }
```

```bash
cd ~/.dsh/profiles/desktop
ln -sfn "../../../../DeepSeek Harness Native/14_Agent 交付验收台/acceptance-console" node_modules/dsh-acceptance
```

**真正决定加载的是 `bundles` 数组，不是 `cordis.patch.yml`。** 本地插件一律 `link:`。

漏了第三步的表现是**静默跳过**：`dsh --profile … --dump-config` 在 **stderr** 打
`skipping profile bundle "dsh-acceptance": cannot resolve …`，而 **exit code 仍是 0**、stdout 的 dump 看起来完全正常。
随后浏览器里表现为路由 404 / 页签消失，很容易误判成「代码写错了」。三处缺一不可（决策记录 D-017、踩过的坑 P-006）。

**`desktop` profile 由 App 独占**：`dsh --profile desktop --dump-config` 直接报
`error: profile "desktop" is managed exclusively by the Electron application`（exit 1）。
它**不会热加载新 bundle** —— 改完 `package.json` 必须**重启 App**（实测：改完 60 秒内 `cordis.yml` 不变、`dsh-acceptance` 不出现）。
改 profile 前先备份：`cp -p package.json package.json.bak-$(date +%Y%m%d-%H%M%S)`（与目录里既有的 `.bak-*` 习惯一致）。

**升级 DSH 之后先查这两件**（2026-10-11 真事）：① **客户端注入包名可能变** ——
`@deepseek-ai/dsh-client-runtime` 在 0.2.1-alpha.2 里已经**不存在**（app.asar 里 0 命中），对应物是
`@deepseek-ai/dsh-client-modules`；注入名写错，客户端半边就装不起来。② `connection.fetch.register`、
`conversation.view` 槽位、`slots.register(描述对象, 渲染函数)` 的两参形态**在 0.2.1-alpha.2 里没变**
（都在 app.asar 里核对过：内置 chat 的注册就是 `ctx.slots.register({name:'conversation.view', …}, ChatView)`）。
**兼容性判断以 app.asar 里的实际字符串为准，别靠猜** —— app.asar 是文件不是目录，用
`LC_ALL=C grep -aob <串> app.asar` 取偏移再用 `dd` 读上下文。

这个文件在**工作区之外**（当前会话策略是 danger-full-access，可以直接改）；装完**必须重启 App**。

**客户端 bundle 的 serving 路径**是组合式 URL `plugins/??<包名>/client.js,…&rev=<12位哈希>`，
**不是** `/plugins/<包名>/client.js`（后者 404，连已装好的插件也 404）。判断「装没装上」最便宜的判据是
`curl -s http://127.0.0.1:3080/ | grep -c 'dsh-acceptance'`：装上前 `0`，装上后 `≥1`（P-011）。

## 12. 还没做的

- `.repairs`（生成返修任务）—— SDD §9 十条路由里**唯一**还没实现的一条。
  v0.2.0 已把它的**契约与校验**做完（`validateRepairItem`，守卫 G15；轮次上限 `DEFAULT_ROUND_LIMIT = 2`，G18），
  但**路由与工具回传还没接**。
- **客户端已把宿主 9 条路由全消费**（守卫 G10 的 detail 会打出实况；`client-bundle.test.mjs` 另有一条断言
  `ROUTE` 恰 9 条 —— 将来加一条宿主路由而客户端没接，它会红）。
- `buildVerifySchema` / `normalizeDelegatedResult` **还没有单独的纯函数反例测试**，目前只被 `host.test.mjs` 的模式 A 用例间接覆盖。
  （`buildDelegationPrompt` 自 G22 起有守卫：提示词必须写全五类 locator 的确切格式 —— 真机连废四轮就是因为它没写。）
- **模式 A 的委派本体已在真机验过**（§6 末尾那段 + 该 README §8），包括「承诺点之前 4xx 渲染成错误条」与
  「真委派 ⇒ 落一轮带证据」。**v0.2.0 的工具触发链路已在真机端到端验过**（2026-10-12，S6 README §1.9）。
  还没做的是把它放进 PRD §7 的 dogfood：用**一条真需求**跑完整流程并记 7 指标 / 5 信号。
- `scope.fingerprint` 首版恒为 `null`（「版本未知」）。**不许**用变更文件列表派生哈希冒充。
- 变更范围只有父（开发）会话读得到；子会话不记录、摘要只在宿主内存。三种「空」必须是三句不同的话。
- S3b/S3c/S3d 探针（不阻塞开发）。
- **证据只能来自「一轮取证」**：界面上没有单独添加/删除证据的入口（`.import` 要求证据与轮次同批提交）。
  要补证据就得让 Agent 重新取一轮，或从验收包导入一轮。
- **底部决定栏不是 sticky**：它是内容末尾的静态栏。900px 高度下要先滚动宿主面板才看得到（实测滚动后完整可见、
  不被输入框遮挡）。宽度 ≤760px 时整体塌成单列。

## 13. 界面结构（2026-10-10 评审定稿，动 `client.js` 之前先读）

用户拿 `../00_调研与Demo/Agent%E4%BA%A4%E4%BB%98%E9%AA%8C%E6%94%B6%E5%8F%B0_Knit%E9%A3%8E%E6%A0%BC%E7%AE%80%E5%8C%96Demo.html`
当布局对照，要求把界面从「技术操作面板」改成**以验收清单为主线的交付审查工作台**。
**那 Demo 只能取结构，不能取色值/字号/比率文案**：它用裸色值、`13px/18px` 正文与 `已通过 2/4 项` 这种比率摘要，
三样都违反本项目硬规则（G11 尺度表、L0 §10 第 1 条）。

自上而下的结构（顺序即约定，改序等于改需求）：

| 区 | 内容 | 不许出现 |
|---|---|---|
| 工具栏 `.acc-head` | `交付验收` + 任务下拉（显示**人能懂的任务名**）+ `v{版本} · schema {n}`（弱化）+ `＋ 新建验收任务` | 统计卡、欢迎区、宣传文案 |
| 筛选行 `.acc-filters` | 一行轻量文本：`全部 / 待验收 / 通过 / 未通过 / 无法判断 / 环境阻塞`，各带数量、可点选过滤 | 进度条、百分比、圆环、大号统计数字、评分感配色 |
| 左栏 `.acc-list` | 280–340px 清单：`AC-xx`（11px 等宽）+ 一句话标题 + **单一状态**；细分割线，不做大圆角卡片；选中 `[aria-current="true"]` 浅底 + 细蓝左边线 | 重复长描述与证据 |
| 右栏详情 `.acc-detail` | ① eyebrow（编号·来源·方式·确认状态）② 标题 ③ **单一判断状态 + 一句人话解释**（`STATUS_HINT`）④ `验收标准` ⑤ `查看原始需求`（默认折叠）⑥ `证据 N 项`（紧凑行，`查看取证细节` 默认折叠出命令/输出/路径/退出码）⑦ `重新验证` + `其他验证方式` 折叠 ⑧ `这项是否符合要求？` + `验收备注（可选）` ⑨ 逐轮记录 | 大卡片堆叠；把「系统证据」说成最终结论 |
| 底部 `.acc-foot` | 左侧人话摘要；右侧依次 `导出验收记录`→`生成修复说明`→`暂缓验收`→`要求修复`→`接受交付`（primary） | 遮挡内容；只靠变灰解释为什么不能接受 |

**五态显示名与契约键的映射（契约键与 G4 一个字都不动，只改显示层）：**

| 契约键 | 显示名 | 一句话解释（`STATUS_HINT`） |
|---|---|---|
| `pending` | 待验收 | 还没验，或验了没给结论 |
| `pass` | 通过 | 有本轮证据支撑的通过 |
| `fail` | 未通过 | 有证据证明不符合 |
| `unknown` | 无法判断 | 证据不足以判断（**不是通过**） |
| `blocked` | 环境阻塞 | 环境/依赖挡住了，不是代码问题 |

「证据采集状态 / 验收项判断 / 任务最终决策」是三件事，**不许混成一种**（`blocked` 是取证的失败，不是验收的失败）。

**逐条人工判定的映射（没发明后端字段）：** 契约里 `criteria[]` 只有 `add / confirm / delete`，没有「逐条判定」字段。
实现方式是**把一次人工判定写成一轮 `producedBy:'manual'` 的轮次**（`rounds[]` 追加，历史只增不改）：
判 `pass` 时同时补一条 `observation` 证据（locator 恰 3 个 `｜`）；判 `fail` 时要求先写复现步骤，否则界面先拦住。
为此宿主 `.import` 的 `producedBy` 不再硬编码 `'pasted'`，改为接受 `PRODUCERS` 白名单内的值（默认仍 `pasted`）。

**底部决定栏的硬规则：** 任一验收项不是 `pass` ⇒ `接受交付` 禁用，**并把剩余项逐条写在栏里**（不能只靠变灰）；
单项通过 ≠ 任务接受交付；`生成修复说明`（`buildRepairText`）只许抄事实（未通过/待验收/无法判断/环境阻塞 + 各项验收标准 + 验收备注），
**不得把未验证写成已失败或已修好**。筛选/搜索只影响左栏可见项，**不许**因此改变任何结论或禁用逻辑。

**取证入口降级：** 主界面只有 `重新验证`（模式 A 委派）这一个主操作；`从验收包读取结果`（模式 B）与
`委派独立 Agent 验证` 收进 `其他验证方式`。两个动作都必须绑真实实现，不可用时**报错**，不许假装成功。

真机复验记录（2026-10-10 傍晚，在用户自己的 3080 上、**不重启宿主**）：见
`../99_暂存文档/真机验收-Knit改版-2026-10-10/README.md`。
