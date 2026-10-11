// Agent 交付验收台（dsh-acceptance）— conversation view client.
//
// 这是**实现**：一个普通 CommonJS 模块，由 `scripts/build-client.mjs` 打包成
// `dist/client.js`，再被 `window.__ModuleLoader__.load({ id, factory })` 包起来。
// 浏览器跑的是 `dist/client.js`，不是本文件 —— 改完必须重建（SDD §10.2 第 1 条）。
//
// 三条铁律（SDD §10）：
//  1. 只做渲染，不做判定。状态迁移、证据合法性、origin 区分全部来自 host。
//  2. 五态在列表与详情里都要有**文字标签**，不能只靠颜色。
//  3. 本文件里的 CSS 是模板字符串；**里面禁止出现反引号**，写一个就提前结束字符串。
//
// 写入：客户端只**提交操作**（建任务 / 验收项 op / 模式 B 导入 / 记录决定），结论一律由 host 落盘。
// 这里没有一处会自己判断「这算通过还是未通过」—— 判定函数名与状态赋值都由守卫 G7 把关。

const React = require('react')

const NS = 'dsh-acceptance'

/** 浏览器**相对**形态的路径（S5 定稿）：去掉前导 `/`，在本页 base 下解析。 */
const ROUTE = {
  health: 'api/acceptance.health',
  tasks: 'api/acceptance.tasks',
  receipt: 'api/acceptance.receipt',
  criteria: 'api/acceptance.criteria',
  decision: 'api/acceptance.decision',
  package: 'api/acceptance.package',
  importResult: 'api/acceptance.import',
  exportMd: 'api/acceptance.export',
  verify: 'api/acceptance.verify',
}

const ZH = {
  tab: '验收台',
  emptyTitle: '还没有验收任务',
  emptyBody: '先建一个任务，再把原始需求贴进去。',
  pickOneTitle: '上面有任务，选一个看它',
  pickOneBody: '选中后，它的验收项、证据与结论显示在这里。',
  loading: '正在读取…',
  loadFailed: '读取失败',
  retry: '重试',
  taskList: '验收任务',
  requirement: '原始需求',
  original: '原始需求',
  suggested: '建议补充',
  evidence: '证据',
  noEvidence: '无证据',
  stale: '本轮未复查',
  unknownVersion: '版本未知',
  maybeOutdated: '可能已过期',
  scope: '验收范围',
  versionNote: '非 git 仓库，取不到版本快照。',
  rounds: '逐轮记录',
  noRounds: '尚无任何验收轮次。',
  newTask: '新建验收任务',
  newTaskTitle: '任务名（可选）',
  newTaskRequirement: '原始需求',
  create: '创建',
  cancel: '取消',
  addCriterion: '添加验收项',
  criterionTitle: '验收项',
  criterionExpected: '通过条件（可选）',
  criterionMethod: '取证方式',
  methodManual: '人工判断',
  methodStatic: '静态检查',
  methodCommand: '跑命令',
  methodUi: '看界面',
  confirmCriterion: '确认这一条',
  confirmedAt: '已确认',
  deleteCriterion: '删除',
  modeB: '按验收包取证（模式 B）',
  modeBHint: '生成验收包 → 在外部完成取证 → 把 JSON 结果原样贴回来。',
  genPackage: '生成验收包',
  pasteResult: '粘贴结构化结果（JSON）',
  importRound: '导入这一轮',
  decisionTitle: '最终决定',
  decideAccept: '接受交付',
  decideFix: '要求修复',
  decideDefer: '暂缓验收',
  decisionNote: '备注（可选）',
  decidedAt: '已在',
  decisionCounts: '决定时的状态',
  modeA: '委派取证（模式 A）',
  modeAHint: '过程不可见，最长 10 分钟。',
  verifyNow: '开始委派取证',
  verifying: '取证中…',
  verifyingHint: '关闭页面不会取消委派；失败会写一轮「被阻塞」。',
  noCriteria: '还没有验收项 —— 先确认验收项，再委派取证。',
  noSession: '这个页面没拿到会话 ID，无法委派。',
  exportReceipt: '查看验收凭证',
  copy: '复制',
  copied: '已复制',
  working: '处理中…',
  actionFailed: '这一步没成功',
  chooseTask: '选择任务',
  listHead: '验收清单',
  itemUnit: '项',
  add: '添加',
  search: '搜索验收项',
  filterAll: '全部',
  listEmpty: '这个任务还没有验收项。',
  nothingMatches: '当前筛选下没有验收项。',
  standard: '验收标准',
  noStandard: '这一条没有写通过条件 —— 通过与否只能看证据。',
  viewRequirement: '查看原始需求',
  evidenceCount: '证据',
  evidenceNone: '这一项还没有任何证据。',
  evidenceDetails: '查看取证细节',
  evidenceCommand: '执行内容',
  evidenceObserved: '观察到的结果',
  evidenceLocator: '定位符',
  evidenceCapturedAt: '采集时间',
  evidenceSource: '采集来源',
  kindCommand: '命令',
  kindFile: '文件',
  kindUrl: '链接',
  kindScreenshot: '截图',
  kindObservation: '观察',
  addEvidenceUnsupported: '证据只能来自一轮取证（委派取证或从验收包导入）—— 目前没有单独添加证据的入口。',
  judgement: '这项是否符合要求？',
  judgementHint: '点一下就记一轮「人工记录」：这条结论会进凭证，历史只增不改。判为「符合要求」时会同时记一条观察证据，把这次人工核对的依据一起留下。',
  judgePass: '符合要求',
  judgeFail: '不符合要求',
  judgeUnknown: '暂时无法判断',
  judgeBlocked: '验证被环境阻塞',
  judgeClear: '清除判断',
  judgeNote: '验收备注（可选；判为「不符合要求」时这里要写清复现步骤，每行一条）',
  noteLabel: '验收备注',
  judgeFailNeed: '判为「未通过」必须写复现步骤：请先在验收备注里写清楚怎么复现（每行一条），再点这个按钮。',
  judgeCleared: '清除判断 = 记一轮「待验收」：这一项回到没有结论的状态，上一轮的结论仍留在历史里。',
  reverify: '重新验证',
  reverifyHint: '委派一个独立 Agent 去取证：过程在这里不可见，最长 10 分钟，失败会记一轮「环境阻塞」。',
  otherWays: '其他验证方式',
  fromPackage: '从验收包读取结果',
  delegate: '委派独立 Agent 验证',
  verifyNoSession: '这个页面没拿到会话 ID，无法委派。',
  verifyNoCriteria: '还没有验收项 —— 先确认验收项，再委派取证。',
  verifyPending: '条待取证',
  decisionSummaryPass: '全部验收项都是「通过」。',
  decisionSummaryOpen: '还有 N 项不是「通过」',
  decisionOpenWhy: '接受交付前，每一项都必须是「通过」。剩下的项：',
  decisionRecorded: '已记录的决定',
  repairPlan: '生成修复说明',
  repairEmpty: '没有需要修复或确认的项。',
  exportShort: '导出验收记录',
}

const EN = {
  tab: 'Acceptance',
  emptyTitle: 'No acceptance task yet',
  emptyBody: 'Create a task and paste the original requirement.',
  pickOneTitle: 'There are tasks above — pick one',
  pickOneBody: 'Once picked, its criteria, evidence and conclusions show here.',
  loading: 'Loading…',
  loadFailed: 'Load failed',
  retry: 'Retry',
  taskList: 'Acceptance tasks',
  requirement: 'Original requirement',
  original: 'Original requirement',
  suggested: 'Suggested additions',
  evidence: 'Evidence',
  noEvidence: 'No evidence',
  stale: 'Not re-checked this round',
  unknownVersion: 'Version unknown',
  maybeOutdated: 'Possibly outdated',
  scope: 'Scope',
  versionNote: 'Not a git repository — no version snapshot.',
  rounds: 'Rounds',
  noRounds: 'No acceptance round has run yet.',
  newTask: 'New acceptance task',
  newTaskTitle: 'Task name (optional)',
  newTaskRequirement: 'Original requirement',
  create: 'Create',
  cancel: 'Cancel',
  addCriterion: 'Add acceptance item',
  criterionTitle: 'Acceptance item',
  criterionExpected: 'Pass condition (optional)',
  criterionMethod: 'How it is checked',
  methodManual: 'Human judgement',
  methodStatic: 'Static check',
  methodCommand: 'Run a command',
  methodUi: 'Inspect the UI',
  confirmCriterion: 'Confirm this item',
  confirmedAt: 'Confirmed',
  deleteCriterion: 'Delete',
  modeB: 'Evidence by acceptance package (mode B)',
  modeBHint: 'Generate the package → collect evidence elsewhere → paste the JSON result back.',
  genPackage: 'Generate package',
  pasteResult: 'Paste the structured result (JSON)',
  importRound: 'Import this round',
  decisionTitle: 'Final decision',
  decideAccept: 'Accept delivery',
  decideFix: 'Request a fix',
  decideDefer: 'Defer',
  decisionNote: 'Note (optional)',
  decidedAt: 'Recorded at',
  decisionCounts: 'States at decision time',
  modeA: 'Delegate verification (mode A)',
  modeAHint: 'Not visible here; up to 10 minutes.',
  verifyNow: 'Start delegation',
  verifying: 'Verifying…',
  verifyingHint: 'Closing the page does not cancel the delegation; failures write a "blocked" round.',
  noCriteria: 'No criteria yet — confirm criteria before delegating.',
  noSession: 'No session id on this page, so delegation is not possible.',
  exportReceipt: 'View the receipt',
  copy: 'Copy',
  copied: 'Copied',
  working: 'Working…',
  actionFailed: 'That step did not succeed',
  chooseTask: 'Choose a task',
  listHead: 'Acceptance items',
  itemUnit: 'item(s)',
  add: 'Add',
  search: 'Search items',
  filterAll: 'All',
  listEmpty: 'This task has no acceptance items yet.',
  nothingMatches: 'No acceptance item matches the current filter.',
  standard: 'Pass condition',
  noStandard: 'No pass condition written for this item — only evidence can tell.',
  viewRequirement: 'View the original requirement',
  evidenceCount: 'Evidence',
  evidenceNone: 'No evidence for this item yet.',
  evidenceDetails: 'View evidence details',
  evidenceCommand: 'What was run',
  evidenceObserved: 'What was observed',
  evidenceLocator: 'Locator',
  evidenceCapturedAt: 'Captured at',
  evidenceSource: 'Source',
  kindCommand: 'Command',
  kindFile: 'File',
  kindUrl: 'URL',
  kindScreenshot: 'Screenshot',
  kindObservation: 'Observation',
  addEvidenceUnsupported: 'Evidence can only come from a verification round (delegation or package import) — there is no standalone "add evidence" entry yet.',
  judgement: 'Does this item meet the requirement?',
  judgementHint: 'One click records a "manual" round: this conclusion goes into the receipt, and history is append-only. A pass also records an observation evidence item, so the basis of your check is kept.',
  judgePass: 'Meets the requirement',
  judgeFail: 'Does not meet it',
  judgeUnknown: 'Cannot tell for now',
  judgeBlocked: 'Verification blocked by the environment',
  judgeClear: 'Clear the conclusion',
  judgeNote: 'Note (optional; for "does not meet it" write the reproduction steps here, one per line)',
  noteLabel: 'Note',
  judgeFailNeed: 'A fail must carry reproduction steps: write them in the note first (one per line), then click again.',
  judgeCleared: 'Clearing writes a "to verify" round: the item goes back to having no conclusion, and the previous round stays in history.',
  reverify: 'Verify again',
  reverifyHint: 'Delegate to an independent agent: it is not visible here, takes up to 10 minutes, and a failure records an "environment blocked" round.',
  otherWays: 'Other ways to verify',
  fromPackage: 'Read the result from an acceptance package',
  delegate: 'Delegate to an independent agent',
  verifyNoSession: 'No session id on this page, so delegation is not possible.',
  verifyNoCriteria: 'No acceptance items yet — confirm them before delegating.',
  verifyPending: 'item(s) to verify',
  decisionSummaryPass: 'Every acceptance item is a pass.',
  decisionSummaryOpen: 'still not "pass"',
  decisionOpenWhy: 'Every item must be a pass before you can accept the delivery. Remaining items:',
  decisionRecorded: 'Recorded decision',
  repairPlan: 'Build the repair brief',
  repairEmpty: 'Nothing needs fixing or confirming.',
  exportShort: 'Export the record',
}

/**
 * 五态 → 文字标签。**颜色永远配文字**（SDD §10.5）。
 *
 * 显示名按用户 2026-10-10 的界面评审改过一轮（待验证→待验收、未验证→无法判断、被阻塞→环境阻塞）。
 * **改的只是显示名，键一个都没动** —— 宿主 `STATUSES` 仍是这五个键，派生规则、导出、守卫 G4
 * 全部按键走。换句话说：这不是新状态，是同一批状态换了人话。
 */
const STATUS_TEXT = {
  pending: { zh: '待验收', en: 'To verify' },
  pass: { zh: '通过', en: 'Pass' },
  fail: { zh: '未通过', en: 'Fail' },
  unknown: { zh: '无法判断', en: 'Cannot tell' },
  blocked: { zh: '环境阻塞', en: 'Blocked by environment' },
}

/**
 * 每个状态一句话解释。**「无法判断」最容易和「未验证」混成同一件事**（用户评审点名的风险）：
 * 前者是「查过了但证据不够」，后者在老文案里既可能指「还没查」也可能指「查不动」。
 * 解释写在详情页状态行旁边，让人不必猜。
 */
const STATUS_HINT = {
  pending: { zh: '还没有针对这一项的结论。', en: 'No conclusion has been recorded for this item.' },
  pass: { zh: '有一轮结论判为通过，并且引用了证据。', en: 'A round concluded pass, with evidence attached.' },
  fail: { zh: '有一轮结论判为未通过，并写了复现步骤。', en: 'A round concluded fail, with reproduction steps.' },
  unknown: { zh: '查过了，但证据不足以判断是否符合要求 —— 这不是通过。', en: 'Checked, but the evidence is not enough to tell — this is not a pass.' },
  blocked: { zh: '取证动作本身没跑起来（环境问题），这一项还没有被真正验证。', en: 'The check itself could not run (environment problem) — this item was never actually verified.' },
}

/** 证据种类 → 中文名。列表里显示人话，原始 kind 仍在 `ref.type` 里。 */
const KIND_TEXT = {
  command: 'kindCommand',
  file: 'kindFile',
  url: 'kindUrl',
  screenshot: 'kindScreenshot',
  observation: 'kindObservation',
}

const STYLE = [
  // 设计 Token 由 skill `dsh-plugin-ui` 的 scripts/sync-tokens.mjs 整块内联 —— **不许手抄**。
  `/* dsh-plugin-ui · 插入锚点 */
/* dsh-plugin-ui · 设计 Token 单一真源（canonical）
 * 规范与理由：见同 skill 的 SKILL.md ｜ 取值出处：references/出处与取证.md
 * 用法：消费方把本文件从第一行「:root 定义块」起的全部内容**逐字内联**到自己的样式里，
 *       并原样保留下面这行 stamp 注释（守卫 G11 按它比对源一致性）。
 * 不要手改内联副本 —— 改这里，再重新内联。
 * 本文件必须能安全内联进 JS 模板字符串：注释与正文里都不许出现反引号、美元花括号、反斜杠。
 *       （脚本 scripts/sync-tokens.mjs 会在内联前把这条当硬闸门检查。）
 * stamp: dsh-plugin-ui-tokens ca3dc0bf5f60e93d
 */

:root{
  --dui-bg:var(--dsw-alias-bg-base,#fff);
  --dui-fg:var(--dsw-alias-label-primary,#0f1115);
  --dui-fg-2:var(--dsw-alias-label-secondary,#61666b);
  --dui-fg-3:var(--dsw-alias-label-caption,#adb2b8);
  --dui-line:var(--dsw-alias-border-l2,#0000001a);
  --dui-line-2:var(--dsw-alias-border-l3,#0000001f);
  --dui-hover:rgba(38,49,72,.024);
  --dui-active:rgba(38,49,72,.061);
  --dui-chip:rgba(38,49,72,.092);
  --dui-accent:var(--dsw-alias-brand-primary-new-colorprimary-new-color,#4176e6);
  --dui-ok:var(--dsw-alias-state-success-primary,#22c55e);
  --dui-bad:var(--dsw-alias-state-error-primary,#ec1313);
  --dui-warn:var(--dsw-alias-state-warn-primary,#f59e0b);
  --dui-shadow-overlay:0 10px 28px rgba(15,17,21,.14);
  --dui-scrim:rgba(15,17,21,.28);
  --dui-on-accent:#fff;
  --dui-on-inverse:#fff;
  --dui-radius-sm:6px;
  --dui-radius:8px;
  --dui-radius-lg:12px;
  --dui-mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
}

/* DSH 真实机制：宿主在深色下给 body 加 data-ds-dark-theme */
body[data-ds-dark-theme]{
  --dui-bg:var(--dsw-alias-bg-base,#151517);
  --dui-fg:var(--dsw-alias-label-primary,#f9fafb);
  --dui-fg-2:var(--dsw-alias-label-secondary,#cfd3d6);
  --dui-fg-3:var(--dsw-alias-label-caption,#81858c);
  --dui-line:var(--dsw-alias-border-l2,#ffffff1f);
  --dui-line-2:var(--dsw-alias-border-l3,#ffffff29);
  --dui-hover:rgba(255,255,255,.028);
  --dui-active:rgba(255,255,255,.076);
  --dui-chip:rgba(255,255,255,.114);
  --dui-accent:var(--dsw-alias-brand-primary-new-colorprimary-new-color,#5686fe);
  --dui-ok:var(--dsw-alias-state-success-primary,#22c55e);
  --dui-bad:var(--dsw-alias-state-error-primary,#f25a5a);
  --dui-warn:var(--dsw-alias-state-warn-primary,#f59e0b);
  --dui-shadow-overlay:0 10px 28px rgba(0,0,0,.44);
}

/* 兜底路径：不在 DSH 里（例如直接 file:// 打开原型）时跟随系统深色 */
@media (prefers-color-scheme:dark){
  :root{
    --dui-bg:#151517;
    --dui-fg:#f9fafb;
    --dui-fg-2:#cfd3d6;
    --dui-fg-3:#81858c;
    --dui-line:#ffffff1f;
    --dui-line-2:#ffffff29;
    --dui-hover:rgba(255,255,255,.028);
    --dui-active:rgba(255,255,255,.076);
    --dui-chip:rgba(255,255,255,.114);
    --dui-accent:var(--dsw-alias-brand-primary-new-colorprimary-new-color,#5686fe);
    --dui-bad:var(--dsw-alias-state-error-primary,#f25a5a);
    --dui-shadow-overlay:0 10px 28px rgba(0,0,0,.44);
  }
}

`,
  '.acc-root{display:grid;grid-template-rows:auto auto minmax(0,1fr) auto;height:100%;min-height:0;background:var(--dui-bg);color:var(--dui-fg);font-family:inherit;font-size:13.5px}',
  '.acc-head{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--dui-line);flex-wrap:wrap}',
  '.acc-title{font-weight:600;font-size:14px}',
  '.acc-select{max-width:340px;height:28px;padding:0 8px;border:0.5px solid var(--dui-line-2);border-radius:var(--dui-radius-sm);background:var(--dui-bg);color:inherit;font:inherit}',
  '.acc-filters{display:flex;align-items:center;gap:2px;padding:4px 12px;border-bottom:1px solid var(--dui-line);flex-wrap:wrap}',
  '.acc-filter{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 8px;border:0;border-radius:0;background:transparent;color:var(--dui-fg-2);font:inherit;font-size:12px;cursor:pointer}',
  '.acc-filter:hover{background:var(--dui-hover)}',
  '.acc-filter[data-active="true"]{background:var(--dui-active);color:var(--dui-fg)}',
  '.acc-dot{width:6px;height:6px;border-radius:50%;flex:none}',
  '.acc-body{display:grid;grid-template-columns:minmax(280px,320px) minmax(0,1fr);min-height:0}',
  '.acc-col{overflow:auto;min-height:0}',
  '.acc-col+.acc-col{border-left:1px solid var(--dui-line)}',
  '.acc-pad{padding:14px 16px}',
  '.acc-list-head{display:flex;align-items:baseline;gap:6px;padding:10px 12px 6px}',
  '.acc-list-title{font-size:12px;color:var(--dui-fg-2);font-weight:600}',
  '.acc-list-count{font-size:11.5px;color:var(--dui-fg-3);margin-right:auto}',
  '.acc-search{display:block;width:calc(100% - 24px);margin:0 12px 8px;height:26px;padding:0 8px;border:0.5px solid var(--dui-line-2);border-radius:var(--dui-radius-sm);background:var(--dui-bg);color:inherit;font:inherit;font-size:12px}',
  '.acc-item{display:block;width:100%;text-align:left;padding:9px 12px;border:0;border-bottom:1px solid var(--dui-line);border-radius:0;background:transparent;color:inherit;font:inherit;cursor:pointer}',
  '.acc-item:hover{background:var(--dui-hover)}',
  '.acc-item[aria-current="true"]{background:var(--dui-active);box-shadow:inset 2px 0 0 var(--dui-accent)}',
  '.acc-item-top{display:flex;align-items:baseline;gap:8px;justify-content:space-between}',
  '.acc-item-id{font-family:var(--dui-mono);font-size:11px;color:var(--dui-fg-3)}',
  '.acc-item-title{font-weight:600;margin:3px 0 0;line-height:1.45}',
  '.acc-badge{display:inline-flex;align-items:center;gap:5px;color:var(--dui-fg-2);font-size:12px;white-space:nowrap}',
  '.acc-badge::before{content:"";width:6px;height:6px;border-radius:50%;flex:none;background:var(--dui-fg-3)}',
  '.acc-badge[data-k="pass"]::before{background:var(--dui-ok)}',
  '.acc-badge[data-k="fail"]::before{background:var(--dui-bad)}',
  '.acc-badge[data-k="blocked"]::before{background:var(--dui-warn)}',
  '.acc-badge[data-k="unknown"]::before,.acc-badge[data-k="pending"]::before{background:transparent;box-shadow:inset 0 0 0 1px var(--dui-fg-3)}',
  '.acc-warn{display:inline-block;color:var(--dui-warn);font-size:11.5px}',
  '.acc-hd{font-weight:600;font-size:12.5px;color:var(--dui-fg-2);margin:16px 0 8px}',
  '.acc-hd:first-child{margin-top:0}',
  '.acc-muted{color:var(--dui-fg-3)}',
  '.acc-eyebrow{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;font-family:var(--dui-mono);font-size:11px;color:var(--dui-fg-3)}',
  '.acc-detail-title{font-size:15px;font-weight:600;color:var(--dui-fg);margin:5px 0 6px;line-height:1.45}',
  '.acc-statucline{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;color:var(--dui-fg-2);font-size:12px}',
  '.acc-plain{border-left:2px solid var(--dui-line-2);padding:2px 0 2px 11px;white-space:pre-wrap;line-height:1.6}',
  '.acc-fold{border-top:1px solid var(--dui-line);margin-top:14px;padding-top:10px}',
  '.acc-fold>summary{cursor:pointer;color:var(--dui-fg-2);font-size:12.5px}',
  '.acc-quote{border-left:2px solid var(--dui-line-2);padding:6px 10px;margin:8px 0;background:var(--dui-chip);border-radius:var(--dui-radius-sm);white-space:pre-wrap}',
  '.acc-ev{border-bottom:1px solid var(--dui-line);padding:8px 0}',
  '.acc-ev>summary{cursor:pointer;display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;font-size:12px}',
  '.acc-ev-id{font-family:var(--dui-mono);font-size:11.5px;font-weight:600}',
  '.acc-ev-quick{margin-top:4px;color:var(--dui-fg-2);font-size:12px;line-height:1.5}',
  '.acc-ev-meta{margin-top:3px;color:var(--dui-fg-3);font-size:11.5px;line-height:1.5}',
  '.acc-mono{font-family:var(--dui-mono);font-size:11.5px;word-break:break-all;white-space:pre-wrap}',
  '.acc-note{padding:8px 10px;border:0.5px dashed var(--dui-line-2);border-radius:var(--dui-radius-sm);color:var(--dui-fg-3)}',
  '.acc-warnbox{padding:8px 10px;border:0.5px solid var(--dui-warn);border-radius:var(--dui-radius-sm);color:var(--dui-fg-2);margin:8px 0}',
  '.acc-label{font-size:11.5px;color:var(--dui-fg-3);margin-top:6px}',
  '.acc-form{display:grid;gap:4px;padding:10px;margin:8px 0;border:0.5px solid var(--dui-line-2);border-radius:var(--dui-radius-sm)}',
  '.acc-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:8px}',
  '.acc-btn{height:28px;padding:0 10px;border:0.5px solid var(--dui-line-2);border-radius:var(--dui-radius-sm);background:transparent;color:inherit;font:inherit;font-size:12px;cursor:pointer}',
  '.acc-btn:hover:not(:disabled){background:var(--dui-hover)}',
  '.acc-btn:disabled{opacity:.45;cursor:default}',
  '.acc-btn-primary{background:var(--dui-accent);border-color:var(--dui-accent);color:var(--dui-on-accent)}',
  '.acc-choice{height:28px;padding:0 10px;border:0.5px solid var(--dui-line-2);border-radius:var(--dui-radius-sm);background:transparent;color:inherit;font:inherit;font-size:12px;cursor:pointer}',
  '.acc-choice:hover:not(:disabled){background:var(--dui-hover)}',
  '.acc-choice[data-active="true"]{border-color:var(--dui-accent);color:var(--dui-accent)}',
  '.acc-choice:disabled{opacity:.45;cursor:default}',
  '.acc-input{width:100%;height:28px;padding:0 8px;border:0.5px solid var(--dui-line-2);border-radius:var(--dui-radius-sm);background:var(--dui-bg);color:inherit;font:inherit;font-size:12.5px}',
  '.acc-area{height:auto;padding:6px 8px;line-height:1.5;resize:vertical;font-size:12.5px}',
  '.acc-area-mono{font-family:var(--dui-mono);font-size:11px}',
  '.acc-err{color:var(--dui-bad);font-size:11.5px;margin:6px 14px;white-space:pre-wrap}',
  '.acc-pre{font-family:var(--dui-mono);font-size:11px;line-height:1.5;white-space:pre-wrap;word-break:break-all;max-height:260px;overflow:auto;background:var(--dui-chip);border-radius:var(--dui-radius-sm);padding:8px;margin:6px 0}',
  '.acc-foot{display:flex;flex-direction:column;border-top:1px solid var(--dui-line)}',
  '.acc-foot-row{display:flex;align-items:center;gap:8px;padding:8px 14px;flex-wrap:wrap}',
  '.acc-foot-summary{color:var(--dui-fg-2);font-size:12px;margin-right:auto}',
  '.acc-foot-note{width:200px;height:26px;padding:0 8px;border:0.5px solid var(--dui-line-2);border-radius:var(--dui-radius-sm);background:var(--dui-bg);color:inherit;font:inherit;font-size:12px}',
  '.acc-foot-why{color:var(--dui-fg-2);font-size:11.5px;padding:0 14px 8px}',
  '.acc-foot-panel{max-height:36vh;overflow:auto;border-top:1px solid var(--dui-line);padding:10px 14px}',
  '@media (max-width:760px){',
  '.acc-body{grid-template-columns:minmax(0,1fr)}',
  '.acc-col+.acc-col{border-left:0;border-top:1px solid var(--dui-line)}',
  '.acc-head{padding:8px 10px}',
  '.acc-filters{padding:4px 8px}',
  '.acc-foot-row{padding:8px 10px}',
  '}',
].join('')

function installStyles(ctx) {
  const doc = globalThis.document
  if (!doc) return
  const id = 'dsh-acceptance-style'
  let node = doc.getElementById(id)
  if (!node) {
    node = doc.createElement('style')
    node.id = id
    doc.head.appendChild(node)
  }
  node.textContent = STYLE
  ctx?.effect?.(() => () => node.remove())
}

// ---------------------------------------------------------------------------
// 取数：路径相对、逐字段校验、类型不对当 missing 不抛（SDD §10 / S5）
// ---------------------------------------------------------------------------

function buildUrl(route, params) {
  const url = new URL(route, globalThis.document?.baseURI ?? 'http://localhost/')
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value))
  }
  return url
}

/**
 * host 的错误响应有两种形态（SDD §8.1）：单点 `{error}` 与批量 `{errors:[…]}`。
 * 两种都要把**原文**露给用户 —— 「AC-01 判为通过却没有任何证据」这种话，压成
 * 「请求失败」就等于把唯一有用的信息扔了。
 */
function errorTextOf(parsed, status, route) {
  if (Array.isArray(parsed?.errors) && parsed.errors.length > 0) return parsed.errors.join('；')
  if (typeof parsed?.error === 'string' && parsed.error) return parsed.error
  return `${route} → HTTP ${status}`
}

async function getJson(route, params, signal) {
  const response = await fetch(buildUrl(route, params), { signal, headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error(`${route} → HTTP ${response.status}`)
  const body = await response.json()
  if (!body || typeof body !== 'object') throw new Error(`${route} 返回的不是对象`)
  return body
}

async function postJson(route, body, params, signal) {
  const response = await fetch(buildUrl(route, params), {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  const text = await response.text()
  let parsed = null
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = null
  }
  if (!response.ok || parsed?.ok === false) throw new Error(errorTextOf(parsed, response.status, route))
  if (!parsed || typeof parsed !== 'object') throw new Error(`${route} 返回的不是对象`)
  return parsed
}

/** `.package` / `.export` 回的是 Markdown 文本，不是 JSON —— 按 JSON 解会当场炸。 */
async function readText(response, route) {
  const text = await response.text()
  if (response.ok) return text
  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = null
  }
  throw new Error(errorTextOf(parsed, response.status, route))
}

async function getText(route, params, signal) {
  return readText(await fetch(buildUrl(route, params), { signal, headers: { accept: 'text/markdown, text/plain' } }), route)
}

async function postText(route, body, params, signal) {
  const response = await fetch(buildUrl(route, params), {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', accept: 'text/markdown, text/plain' },
    body: JSON.stringify(body ?? {}),
  })
  return readText(response, route)
}

/** 切 tab 不该丢掉用户看到哪儿 —— 会话级内存，模块不卸载就还在（SDD §10.4）。 */
const pageState = new Map()

function readPage(sessionId) {
  return pageState.get(sessionId) ?? { taskId: null, focusId: null }
}

function writePage(sessionId, patch) {
  pageState.set(sessionId, { ...readPage(sessionId), ...patch })
}

// 首屏默认打开哪一条凭证。任务列表来自 .tasks，服务端已按 updatedAt 倒序，
// 所以 [0] 就是「你最后在弄的那个任务」。
// 已经选中过就不动它 —— 列表请求失败时 tasks 会是空的，那时候清掉用户的选择更糟。
function pickDefaultTask(list, current) {
  if (current) return current
  return list[0]?.taskId ?? null
}

// ---------------------------------------------------------------------------
// 小组件
// ---------------------------------------------------------------------------

/** 五态 → Token 后缀。颜色只从 Token 来，且语义只由小圆点承载（文字保持中性）。 */
function dotToken(status) {
  return { pass: 'ok', fail: 'bad', blocked: 'warn', unknown: 'fg-3', pending: 'fg-3' }[status] ?? 'fg-3'
}

function statusLabel(status) {
  return STATUS_TEXT[status]?.zh ?? status
}

function statusHint(status) {
  return STATUS_HINT[status]?.zh ?? ''
}

function methodLabel(method, t) {
  if (typeof method !== 'string' || method.length === 0) return ''
  const key = `method${method.charAt(0).toUpperCase()}${method.slice(1)}`
  const text = t(key)
  return text === key ? '' : text
}

/**
 * 筛选行：一行轻量文本，**不是统计卡**。五个数字就是「各有几条」，不折算、不加权、不出比率
 * （L0 §10 第 1 条）。点一下过滤左栏。
 */
function FilterRow(props) {
  const { t, counts, filter, onFilter } = props
  const total = COUNT_ORDER.reduce((sum, status) => sum + (counts?.[status] ?? 0), 0)
  const entries = [{ key: 'all', label: t('filterAll'), count: total }].concat(
    COUNT_ORDER.map((status) => ({ key: status, label: statusLabel(status), count: counts?.[status] ?? 0 })),
  )
  return React.createElement(
    'div',
    { className: 'acc-filters', role: 'group' },
    entries.map((entry) =>
      React.createElement(
        'button',
        {
          key: entry.key,
          type: 'button',
          className: 'acc-filter',
          'data-filter': entry.key,
          'data-active': filter === entry.key ? 'true' : 'false',
          onClick: () => onFilter(entry.key),
        },
        entry.key === 'all'
          ? null
          : React.createElement('span', {
              className: 'acc-dot',
              style: { background: `var(--dui-${dotToken(entry.key)})` },
            }),
        `${entry.label} ${entry.count}`,
      ),
    ),
  )
}

function StatusBadge(props) {
  const status = props.status
  return React.createElement('span', { className: 'acc-badge', 'data-k': status }, statusLabel(status))
}

/**
 * 一条证据。默认只露「编号 + 种类 + 一句话观察 + 一行弱化来源」，命令原文、完整输出、
 * 定位符与采集时间折进 `查看取证细节`。**折叠不是删除** —— 原始证据一个字段都没少。
 */
function EvidenceRow(props) {
  const { evidence, t } = props
  const locator = String(evidence?.ref?.locator ?? '')
  const kind = String(evidence?.kind ?? '')
  const text = String(evidence?.text ?? '')
  const firstLine = text.split('\n')[0]
  const quick = []
  if (Number.isInteger(evidence?.exitCode)) quick.push(`退出码 ${evidence.exitCode}`)
  if (locator) quick.push(locator.length > 96 ? `${locator.slice(0, 96)}…` : locator)
  return React.createElement(
    'details',
    { className: 'acc-ev' },
    React.createElement(
      'summary',
      null,
      React.createElement('span', { className: 'acc-ev-id' }, evidence?.evidenceId ?? '?'),
      React.createElement('span', { className: 'acc-muted' }, t(KIND_TEXT[kind] ?? 'kindObservation')),
      React.createElement('span', { className: 'acc-ev-quick' }, firstLine || '（这条证据没有写观察到了什么）'),
      quick.length > 0 ? React.createElement('span', { className: 'acc-ev-meta' }, quick.join('　·　')) : null,
    ),
    locator ? React.createElement('div', { className: 'acc-ev-meta' }, `${t('evidenceLocator')}：${locator}`) : null,
    evidence?.capturedAt
      ? React.createElement('div', { className: 'acc-ev-meta' }, `${t('evidenceCapturedAt')}：${shortTime(evidence.capturedAt)}`)
      : null,
    React.createElement('div', { className: 'acc-hd' }, t('evidenceObserved')),
    React.createElement('pre', { className: 'acc-pre' }, text || '(空)'),
  )
}

/** 键盘可用的清单：`<button>` + roving tabindex + 方向键（SDD §10.5）。 */
function CriterionList(props) {
  const { items, statuses, stale, focusedId, onFocus, onOpen, t } = props
  const containerRef = React.useRef(null)

  function onKeyDown(event) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return
    event.preventDefault()
    const ids = items.map((item) => item.id)
    const index = Math.max(0, ids.indexOf(focusedId))
    const next =
      event.key === 'ArrowDown'
        ? Math.min(ids.length - 1, index + 1)
        : event.key === 'ArrowUp'
          ? Math.max(0, index - 1)
          : event.key === 'Home'
            ? 0
            : ids.length - 1
    const target = ids[next]
    if (!target) return
    onFocus(target)
    const node = containerRef.current?.querySelector(`[data-criterion="${target}"]`)
    node?.focus()
  }

  return React.createElement(
    'div',
    { ref: containerRef, role: 'list', onKeyDown },
    items.map((item) => {
      const status = statuses?.[item.id] ?? 'pending'
      const isFocused = item.id === focusedId
      return React.createElement(
        'button',
        {
          key: item.id,
          type: 'button',
          role: 'listitem',
          'data-criterion': item.id,
          className: 'acc-item',
          'aria-current': isFocused ? 'true' : 'false',
          tabIndex: isFocused ? 0 : -1,
          onClick: () => {
            onFocus(item.id)
            onOpen(item.id)
          },
        },
        React.createElement(
          'div',
          { className: 'acc-item-top' },
          React.createElement('span', { className: 'acc-item-id' }, item.id),
          React.createElement(StatusBadge, { status }),
        ),
        React.createElement('div', { className: 'acc-item-title' }, item.title || '(未命名验收项)'),
        stale?.has?.(item.id) ? React.createElement('div', { className: 'acc-warn' }, t('stale')) : null,
      )
    }),
  )
}

/**
 * 右栏详情。顺序是钉住的（用户 2026-10-10 评审定的）：
 * ① 编号/来源/方式 + 标题 + 单一判断状态 → ② 验收标准 → ③ 查看原始需求（默认收起）
 * → ④ 证据（先条数，再紧凑列表）→ 复现步骤/备注（有才显示）。
 * 「这项是否符合要求」在 JudgementBlock 里，紧跟在证据之后。
 */
function DetailPane(props) {
  const { criterion, receipt, status, stale, t } = props
  if (!criterion) {
    return React.createElement('div', { className: 'acc-note' }, t('emptyBody'))
  }
  const evidence = (receipt?.evidence ?? []).filter((item) => item.criterionId === criterion.id)
  const round = [...(receipt?.rounds ?? [])].sort((a, b) => (b.round ?? 0) - (a.round ?? 0))[0]
  const evaluation = (round?.evaluations ?? []).find((item) => item.criterionId === criterion.id)
  const method = methodLabel(criterion.method, t)

  return React.createElement(
    'div',
    { className: 'acc-detail' },
    React.createElement(
      'div',
      { className: 'acc-eyebrow' },
      React.createElement('span', null, criterion.id),
      React.createElement('span', { className: 'acc-muted' }, criterion.origin === 'suggested' ? t('suggested') : t('original')),
      method ? React.createElement('span', { className: 'acc-muted' }, method) : null,
      criterion.confirmedByUserAt
        ? React.createElement('span', { className: 'acc-muted' }, `${t('confirmedAt')} · ${shortTime(criterion.confirmedByUserAt)}`)
        : React.createElement('span', { className: 'acc-warn' }, '尚未确认'),
      stale?.has?.(criterion.id) ? React.createElement('span', { className: 'acc-warn' }, t('stale')) : null,
    ),
    React.createElement('div', { className: 'acc-detail-title' }, criterion.title || '(未命名验收项)'),
    React.createElement(
      'div',
      { className: 'acc-statucline' },
      React.createElement(StatusBadge, { status }),
      React.createElement('span', { className: 'acc-muted' }, statusHint(status)),
    ),
    React.createElement('div', { className: 'acc-hd' }, t('standard')),
    criterion.expected
      ? React.createElement('div', { className: 'acc-plain' }, criterion.expected)
      : React.createElement('div', { className: 'acc-muted' }, t('noStandard')),
    React.createElement(
      'details',
      { className: 'acc-fold' },
      React.createElement('summary', null, t('viewRequirement')),
      React.createElement('div', { className: 'acc-quote' }, receipt?.requirementText || '(空)'),
      criterion.sourceQuote ? React.createElement('div', { className: 'acc-plain' }, `原话：「${criterion.sourceQuote}」`) : null,
      React.createElement(
        'div',
        { className: 'acc-ev-meta' },
        `${t('scope')}：${receipt?.scope?.cwd ?? '(未记录)'}　·　变更范围来源 ${receipt?.scope?.changedFilesSource ?? 'unknown'}`,
      ),
      React.createElement('div', { className: 'acc-ev-meta' }, `${t('unknownVersion')} —— ${t('versionNote')}`),
    ),
    React.createElement('div', { className: 'acc-hd' }, `${t('evidenceCount')} ${evidence.length} ${t('itemUnit')}`),
    evidence.length === 0
      ? React.createElement('div', { className: 'acc-note' }, t('evidenceNone'))
      : evidence.map((item) => React.createElement(EvidenceRow, { key: item.evidenceId, evidence: item, t })),
    React.createElement('div', { className: 'acc-ev-meta' }, t('addEvidenceUnsupported')),
    evaluation?.reproductionSteps?.length
      ? React.createElement(
          'div',
          null,
          React.createElement('div', { className: 'acc-hd' }, '复现步骤'),
          React.createElement(
            'ol',
            null,
            evaluation.reproductionSteps.map((step, index) => React.createElement('li', { key: index }, step)),
          ),
        )
      : null,
    evaluation?.note
      ? React.createElement(
          'div',
          null,
          React.createElement('div', { className: 'acc-hd' }, t('noteLabel')),
          React.createElement('div', { className: 'acc-plain' }, evaluation.note),
        )
      : null,
  )
}

// ---------------------------------------------------------------------------
// 主视图
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 写入界面：客户端只**提交操作**，结论一律由 host 落盘（守卫 G7）
//
// 这一段的纪律：按钮点下去就是把操作发给 host，然后重新读凭证。
// 没有任何一处在这里判断「这条算通过还是未通过」——那是 host 的事。
// ---------------------------------------------------------------------------

const METHODS = ['manual', 'static', 'command', 'ui']
const DECISION_KEYS = { accept: 'decideAccept', fix: 'decideFix', defer: 'decideDefer' }
const COUNT_ORDER = ['pending', 'pass', 'fail', 'unknown', 'blocked']
const PRODUCER_TEXT = { agent: '委派取证', manual: '人工记录', pasted: '粘贴导入' }

function copyText(value) {
  try {
    globalThis.navigator?.clipboard?.writeText?.(value)
    return true
  } catch (err) {
    return false
  }
}

/** ISO 时间戳压成「YYYY-MM-DD HH:MM」；客户端只做展示，不做判定。 */
function shortTime(value) {
  return typeof value === 'string' ? value.replace('T', ' ').slice(0, 16) : value
}

function CopyBtn(props) {
  const [copied, setCopied] = React.useState(false)
  return React.createElement(
    Btn,
    {
      disabled: props.disabled,
      onClick: () => setCopied(copyText(props.value)),
    },
    copied ? props.t('copied') : props.t('copy'),
  )
}

function TextInput(props) {
  return React.createElement('input', {
    className: 'acc-input',
    type: 'text',
    value: props.value ?? '',
    placeholder: props.placeholder ?? '',
    disabled: Boolean(props.disabled),
    onChange: (event) => props.onChange(event.target.value),
  })
}

function TextArea(props) {
  return React.createElement('textarea', {
    className: `acc-input acc-area${props.mono ? ' acc-area-mono' : ''}`,
    rows: props.rows ?? 4,
    value: props.value ?? '',
    placeholder: props.placeholder ?? '',
    disabled: Boolean(props.disabled),
    onChange: (event) => props.onChange(event.target.value),
  })
}

function Btn(props) {
  return React.createElement(
    'button',
    {
      type: 'button',
      className: `acc-btn${props.primary ? ' acc-btn-primary' : ''}`,
      disabled: Boolean(props.disabled) || Boolean(props.busy),
      onClick: props.onClick,
    },
    props.children,
  )
}

function Err(props) {
  if (!props.text) return null
  return React.createElement('div', { className: 'acc-err' }, `${props.t('actionFailed')}：${props.text}`)
}

function NewTaskForm(props) {
  const { t, busy, onCreate } = props
  const [title, setTitle] = React.useState('')
  const [requirement, setRequirement] = React.useState('')
  const canSubmit = requirement.trim().length > 0 && !busy
  return React.createElement(
    'div',
    { className: 'acc-form' },
    React.createElement('div', { className: 'acc-hd' }, t('newTask')),
    React.createElement('div', { className: 'acc-label' }, t('newTaskRequirement')),
    React.createElement(TextArea, { value: requirement, onChange: setRequirement, disabled: busy, rows: 6 }),
    React.createElement('div', { className: 'acc-label' }, t('newTaskTitle')),
    React.createElement(TextInput, { value: title, onChange: setTitle, disabled: busy }),
    React.createElement(
      'div',
      { className: 'acc-row' },
      React.createElement(
        Btn,
        {
          primary: true,
          disabled: !canSubmit,
          onClick: () => onCreate({ taskTitle: title.trim(), requirementText: requirement }),
        },
        t('create'),
      ),
      busy ? React.createElement('span', { className: 'acc-muted' }, t('working')) : null,
    ),
  )
}

function AddCriterion(props) {
  const { t, busy, onAdd } = props
  const [open, setOpen] = React.useState(false)
  const [title, setTitle] = React.useState('')
  const [expected, setExpected] = React.useState('')
  const [method, setMethod] = React.useState('manual')
  if (!open) {
    return React.createElement(
      'div',
      { className: 'acc-row' },
      React.createElement(Btn, { onClick: () => setOpen(true), disabled: busy }, `+ ${t('addCriterion')}`),
    )
  }
  return React.createElement(
    'div',
    { className: 'acc-form' },
    React.createElement('div', { className: 'acc-hd' }, t('addCriterion')),
    React.createElement('div', { className: 'acc-label' }, t('criterionTitle')),
    React.createElement(TextInput, { value: title, onChange: setTitle, disabled: busy }),
    React.createElement('div', { className: 'acc-label' }, t('criterionExpected')),
    React.createElement(TextInput, { value: expected, onChange: setExpected, disabled: busy }),
    React.createElement('div', { className: 'acc-label' }, t('criterionMethod')),
    React.createElement(
      'select',
      { className: 'acc-select', value: method, disabled: busy, onChange: (event) => setMethod(event.target.value) },
      METHODS.map((name) =>
        React.createElement('option', { key: name, value: name }, t(`method${name.charAt(0).toUpperCase()}${name.slice(1)}`)),
      ),
    ),
    React.createElement(
      'div',
      { className: 'acc-row' },
      React.createElement(
        Btn,
        {
          primary: true,
          disabled: !title.trim() || busy,
          onClick: () => {
            onAdd({ title: title.trim(), expected: expected.trim(), method })
            setTitle('')
            setExpected('')
            setMethod('manual')
            setOpen(false)
          },
        },
        t('create'),
      ),
      React.createElement(Btn, { onClick: () => setOpen(false), disabled: busy }, t('cancel')),
    ),
  )
}

function CriterionActions(props) {
  const { t, criterion, busy, onConfirm, onDelete } = props
  if (!criterion) return null
  return React.createElement(
    'div',
    { className: 'acc-row' },
    criterion.confirmedByUserAt
      ? React.createElement(
          'span',
          { className: 'acc-muted' },
          `${t('confirmedAt')} · ${shortTime(criterion.confirmedByUserAt)}`,
        )
      : React.createElement(Btn, { onClick: () => onConfirm(criterion.id), disabled: busy }, t('confirmCriterion')),
    React.createElement(Btn, { onClick: () => onDelete(criterion.id), disabled: busy }, t('deleteCriterion')),
  )
}

function RoundList(props) {
  const { t, rounds } = props
  const list = Array.isArray(rounds) ? rounds : []
  return React.createElement(
    'div',
    null,
    React.createElement('div', { className: 'acc-hd' }, t('rounds')),
    list.length === 0
      ? React.createElement('div', { className: 'acc-note' }, t('noRounds'))
      : list.map((round) =>
          React.createElement(
            'div',
            { key: `round-${round.round}`, className: 'acc-ev' },
            React.createElement(
              'div',
              null,
              React.createElement('strong', null, `#${round.round}`),
              React.createElement(
                'span',
                { className: 'acc-muted' },
                `　${PRODUCER_TEXT[round.producedBy] ?? round.producedBy}`,
              ),
            ),
            round.blockedReason ? React.createElement('div', { className: 'acc-warn' }, round.blockedReason) : null,
          ),
        ),
  )
}

function ModeBPanel(props) {
  const { t, busy, onGenerate, onImport } = props
  const [open, setOpen] = React.useState(false)
  const [bundle, setBundle] = React.useState('')
  const [payload, setPayload] = React.useState('')
  if (!open) {
    return React.createElement(
      'div',
      { className: 'acc-row' },
      React.createElement(Btn, { onClick: () => setOpen(true), disabled: busy }, t('fromPackage')),
    )
  }
  return React.createElement(
    'div',
    { className: 'acc-form' },
    React.createElement('div', { className: 'acc-hd' }, t('fromPackage')),
    React.createElement('div', { className: 'acc-muted' }, t('modeBHint')),
    React.createElement(
      'div',
      { className: 'acc-row' },
      React.createElement(
        Btn,
        {
          disabled: busy,
          onClick: async () => {
            const text = await onGenerate()
            setBundle(typeof text === 'string' ? text : '')
          },
        },
        t('genPackage'),
      ),
      bundle ? React.createElement(CopyBtn, { t, value: bundle }) : null,
      React.createElement(Btn, { onClick: () => setOpen(false), disabled: busy }, t('cancel')),
    ),
    bundle ? React.createElement('pre', { className: 'acc-pre' }, bundle) : null,
    React.createElement('div', { className: 'acc-label' }, t('pasteResult')),
    React.createElement(TextArea, { value: payload, onChange: setPayload, disabled: busy, rows: 8, mono: true }),
    React.createElement(
      'div',
      { className: 'acc-row' },
      React.createElement(
        Btn,
        {
          primary: true,
          disabled: !payload.trim() || busy,
          onClick: async () => {
            if (await onImport(payload)) setPayload('')
          },
        },
        t('importRound'),
      ),
      busy ? React.createElement('span', { className: 'acc-muted' }, t('working')) : null,
    ),
  )
}

/**
 * 下一块可用的人写法证据编号。**只分配 id，不判断任何状态**（守卫 G7 管的是后者）。
 * 与宿主同规矩：`EV-\d{4}`，取现有最大值 +1。撞号由宿主拒（它会说「已经用过」）。
 */
function nextEvidenceId(receipt) {
  let max = 0
  for (const item of receipt?.evidence ?? []) {
    const match = /^EV-(\d{4})$/.exec(String(item?.evidenceId ?? ''))
    if (match) max = Math.max(max, Number(match[1]))
  }
  return `EV-${String(max + 1).padStart(4, '0')}`
}

/**
 * 「生成修复说明」：给开发 Agent 的一段话，**只抄已有的事实**。
 * 未通过项带上它自己的复现步骤与备注；待验收 / 无法判断 / 环境阻塞分别写清各是什么，
 * **绝不把「没验证」写成「已失败」或「已修好」**（用户 2026-10-10 评审 §4.8）。
 */
function buildRepairText(receipt, statuses, criteria) {
  const lines = []
  lines.push(`# 修复说明 · ${receipt?.taskTitle || receipt?.taskId || '(未命名任务)'}`)
  lines.push('')
  lines.push('## 原始需求（逐字，未改写）')
  lines.push(String(receipt?.requirementText ?? '(空)'))
  lines.push('')
  lines.push('## 需要处理的验收项')
  const open = (criteria ?? []).filter((item) => (statuses?.[item.id] ?? 'pending') !== 'pass')
  if (open.length === 0) {
    lines.push('（没有：每一项都是「通过」。）')
    return lines.join('\n')
  }
  const round = [...(receipt?.rounds ?? [])].sort((a, b) => (b.round ?? 0) - (a.round ?? 0))[0]
  for (const item of open) {
    const status = statuses?.[item.id] ?? 'pending'
    const evaluation = (round?.evaluations ?? []).find((entry) => entry.criterionId === item.id)
    const evidence = (receipt?.evidence ?? []).filter((entry) => entry.criterionId === item.id)
    lines.push(`### ${item.id} · ${statusLabel(status)} · ${item.title || '(未命名验收项)'}`)
    if (item.expected) lines.push(`- 验收标准：${item.expected}`)
    lines.push(`- 当前状态：${statusLabel(status)} —— ${statusHint(status)}`)
    lines.push(
      `- 已有证据：${
        evidence.length === 0
          ? '无'
          : evidence
              .map((entry) => `${entry.evidenceId}[${entry.kind}] ${String(entry.text ?? '').split('\n')[0]}`)
              .join('；')
      }`,
    )
    if (evaluation?.reproductionSteps?.length) lines.push(`- 复现步骤：${evaluation.reproductionSteps.join(' / ')}`)
    if (evaluation?.note) lines.push(`- 验收备注：${evaluation.note}`)
    lines.push('')
  }
  return lines.join('\n')
}

/**
 * 逐条人工判定。**它不是「在界面上改个状态」—— 它写一轮真的轮次。**
 * 契约里没有「单项状态」字段：五态一律由宿主从轮次派生（SDD §2.6），`.criteria` 只有
 * add / confirm / delete 三个 op。所以这里走模式 B 那条导入通道，把这次判定拼成
 * `producedBy: 'manual'` 的一轮：
 *   · 判「符合要求」→ 同时记一条 `observation` 证据（谁｜何时｜在哪｜现象）。不这么做，
 *     这一轮的 pass 会被宿主按「无证据的通过就是未验证」整轮拒收；
 *   · 判「不符合要求」→ 必须带复现步骤（宿主校验凭证时的硬规则），没写就在界面上先拦；
 *   · 判「暂时无法判断 / 验证被环境阻塞」→ 不带证据；
 *   · 「清除判断」→ 记一轮 `pending`：这一项回到「没有结论」，历史一条不删。
 * 每次判定都是**新一轮**，只覆盖被点的这一项 —— 宿主派生时按轮次降序取每项最新的那条。
 */
function JudgementBlock(props) {
  const { t, busy, criterion, status, onJudge } = props
  const [note, setNote] = React.useState('')
  if (!criterion) return null
  const choices = [
    { key: 'pass', label: t('judgePass') },
    { key: 'fail', label: t('judgeFail') },
    { key: 'unknown', label: t('judgeUnknown') },
    { key: 'blocked', label: t('judgeBlocked') },
  ]
  return React.createElement(
    'div',
    { className: 'acc-fold' },
    React.createElement('div', { className: 'acc-hd' }, t('judgement')),
    React.createElement('div', { className: 'acc-muted' }, t('judgementHint')),
    React.createElement(
      'div',
      { className: 'acc-row' },
      choices.map((choice) =>
        React.createElement(
          'button',
          {
            key: choice.key,
            type: 'button',
            className: 'acc-choice',
            'data-choice': choice.key,
            'data-active': status === choice.key ? 'true' : 'false',
            disabled: busy,
            onClick: () => onJudge(criterion.id, choice.key, note),
          },
          choice.label,
        ),
      ),
      React.createElement(
        'button',
        {
          type: 'button',
          className: 'acc-choice',
          'data-choice': 'pending',
          disabled: busy,
          onClick: () => onJudge(criterion.id, 'pending', ''),
        },
        t('judgeClear'),
      ),
    ),
    React.createElement('div', { className: 'acc-label' }, t('judgeNote')),
    React.createElement(TextArea, { value: note, onChange: setNote, disabled: busy, rows: 3 }),
  )
}

/** 主流程的唯一取证动作：委派一个独立 Agent。过程不可见，失败会记一轮「环境阻塞」。 */
function ReverifyButton(props) {
  const { t, busy, sessionId, activeCount, onVerify } = props
  const blocked = !sessionId
  const empty = activeCount === 0
  return React.createElement(
    'div',
    { className: 'acc-row' },
    React.createElement(
      Btn,
      { primary: true, disabled: blocked || empty || busy, onClick: () => onVerify() },
      busy ? t('verifying') : t('reverify'),
    ),
    blocked ? React.createElement('span', { className: 'acc-muted' }, t('verifyNoSession')) : null,
    !blocked && empty ? React.createElement('span', { className: 'acc-muted' }, t('verifyNoCriteria')) : null,
    !blocked && !empty ? React.createElement('span', { className: 'acc-muted' }, t('reverifyHint')) : null,
    busy ? React.createElement('div', { className: 'acc-note' }, t('verifyingHint')) : null,
  )
}

/**
 * 「其他验证方式」：主界面只剩一个人话动作（重新验证 = 委派独立 Agent），
 * 内部名字（模式 A / 模式 B）退到这里。两条都**绑真实实现**，没有一条是假按钮：
 * 验收包那条会真的调 `.package` / `.import`，委派那条会真的调 `.verify`。
 */
function MoreWays(props) {
  const { t, busy, sessionId, activeCount, onVerify, onGenerate, onImport } = props
  const blocked = !sessionId
  const empty = activeCount === 0
  return React.createElement(
    'details',
    { className: 'acc-fold' },
    React.createElement('summary', null, t('otherWays')),
    React.createElement(
      'div',
      { className: 'acc-row' },
      React.createElement(Btn, { disabled: blocked || empty || busy, onClick: () => onVerify() }, t('delegate')),
      React.createElement('span', { className: 'acc-muted' }, `${activeCount} ${t('verifyPending')}`),
      blocked ? React.createElement('span', { className: 'acc-muted' }, t('verifyNoSession')) : null,
      !blocked && empty ? React.createElement('span', { className: 'acc-muted' }, t('verifyNoCriteria')) : null,
    ),
    React.createElement('div', { className: 'acc-hd' }, t('fromPackage')),
    React.createElement(ModeBPanel, { t, busy, onGenerate, onImport }),
  )
}

/**
 * 任务级决定栏。**接受交付是最终成功动作，所以它有门槛**：只要还有一项不是「通过」，
 * 它就禁用 —— 而且**不能只靠变灰**，必须把剩下的项逐条写出来（用户评审 §4.8）。
 * 单项通过 ≠ 任务被接受：决定是记在凭证上的另一件事。
 */
function FooterBar(props) {
  const { t, busy, decision, criteria, statuses, onDecide, onExport, onRepair } = props
  const [note, setNote] = React.useState('')
  const [panel, setPanel] = React.useState(null)
  const open = (criteria ?? []).filter((item) => (statuses?.[item.id] ?? 'pending') !== 'pass')
  const canAccept = (criteria ?? []).length > 0 && open.length === 0
  const openList = open.map((item) => `${item.id}（${statusLabel(statuses?.[item.id] ?? 'pending')}）`).join('　')
  const summary = canAccept ? t('decisionSummaryPass') : t('decisionSummaryOpen').replace('N', String(open.length))
  return React.createElement(
    'div',
    { className: 'acc-foot' },
    panel
      ? React.createElement(
          'div',
          { className: 'acc-foot-panel' },
          React.createElement(
            'div',
            { className: 'acc-row' },
            React.createElement('strong', null, panel.title),
            React.createElement(CopyBtn, { t, value: panel.text }),
            React.createElement(Btn, { onClick: () => setPanel(null) }, t('cancel')),
          ),
          React.createElement('pre', { className: 'acc-pre' }, panel.text || '（空）'),
        )
      : null,
    decision
      ? React.createElement(
          'div',
          { className: 'acc-foot-panel' },
          React.createElement(
            'div',
            { className: 'acc-foot-why' },
            `${t('decisionRecorded')}：${t(DECISION_KEYS[decision.value] ?? 'decisionTitle')}　·　${shortTime(decision.decidedAt)}${
              decision.note ? `　·　${decision.note}` : ''
            }`,
          ),
          decision?.countsAtDecision
            ? React.createElement(
                'div',
                { className: 'acc-foot-why' },
                `${t('decisionCounts')}：${COUNT_ORDER.map(
                  (state) => `${statusLabel(state)} ${decision.countsAtDecision[state] ?? 0}`,
                ).join('　')}`,
              )
            : null,
        )
      : null,
    React.createElement(
      'div',
      { className: 'acc-foot-row' },
      React.createElement('span', { className: 'acc-foot-summary' }, summary),
      React.createElement('input', {
        className: 'acc-foot-note',
        type: 'text',
        value: note,
        placeholder: t('decisionNote'),
        onChange: (event) => setNote(event.target.value),
      }),
      React.createElement(
        Btn,
        {
          disabled: busy,
          onClick: async () => {
            const text = await onExport()
            setPanel({ title: t('exportShort'), text: typeof text === 'string' ? text : '' })
          },
        },
        t('exportShort'),
      ),
      React.createElement(
        Btn,
        {
          disabled: busy,
          onClick: async () => {
            const text = await onRepair()
            setPanel({ title: t('repairPlan'), text: typeof text === 'string' ? text : '' })
          },
        },
        t('repairPlan'),
      ),
      React.createElement(Btn, { disabled: busy, onClick: () => onDecide('defer', note) }, t('decideDefer')),
      React.createElement(Btn, { disabled: busy, onClick: () => onDecide('fix', note) }, t('decideFix')),
      React.createElement(
        Btn,
        { primary: true, disabled: busy || !canAccept, onClick: () => onDecide('accept', note) },
        t('decideAccept'),
      ),
    ),
    canAccept
      ? null
      : React.createElement(
          'div',
          { className: 'acc-foot-why' },
          `${t('decisionOpenWhy')} ${openList || '（还没有验收项）'}`,
        ),
  )
}

// 导出与委派的界面分别搬到 `FooterBar`（导出验收记录）与 `ReverifyButton` / `MoreWays`
// （委派独立 Agent 验证）里了 —— 原来那两个小组件的作用是「在详情流里再放一组按钮」，
// 与新的「底部决定栏 + 详情里一个主取证动作」重复。

function Workbench(props) {
  const sessionId = props?.sessionId
  const [locale] = React.useState(() => globalThis.__DSH_LOCALE__ === 'en' ? 'en' : 'zh')
  const t = React.useCallback((key) => (locale === 'en' ? EN[key] : ZH[key]) ?? key, [locale])

  const page = readPage(sessionId)
  const [health, setHealth] = React.useState(null)
  const [tasks, setTasks] = React.useState([])
  const [broken, setBroken] = React.useState([])
  const [taskId, setTaskId] = React.useState(page.taskId)
  const [detail, setDetail] = React.useState(null)
  const [focusedId, setFocusedId] = React.useState(page.focusId)
  const [error, setError] = React.useState(null)
  const [loading, setLoading] = React.useState(true)
  const [reloadToken, setReloadToken] = React.useState(0)
  const [busy, setBusy] = React.useState(false)
  const [actionError, setActionError] = React.useState(null)
  const [showNew, setShowNew] = React.useState(false)
  // 筛选与搜索是**本地视图状态**，不进 pageState：切 tab 回来该重新看「全部」，
  // 让人以为「这个任务只有 1 条验收项」比丢掉筛选位置危险得多。
  const [filter, setFilter] = React.useState('all')
  const [query, setQuery] = React.useState('')

  // 所有写动作走同一条路：置忙 → 清错 → 提交 → 出错逐条显示 → 重新读凭证。
  // 这里**不解释结果**，也不替 host 判断「这算通过还是未通过」（守卫 G7）。
  const run = React.useCallback(async (work) => {
    setBusy(true)
    setActionError(null)
    try {
      return await work()
    } catch (err) {
      setActionError(String(err?.message ?? err))
      return undefined
    } finally {
      setBusy(false)
    }
  }, [])
  const reload = React.useCallback(() => setReloadToken((value) => value + 1), [])

  const createTask = React.useCallback(
    (draft) =>
      run(async () => {
        const body = await postJson(
          ROUTE.tasks,
          { requirementText: draft.requirementText, taskTitle: draft.taskTitle },
          { sessionId },
        )
        setShowNew(false)
        setFocusedId(null)
        setTaskId(body?.receipt?.taskId ?? null)
        reload()
        return true
      }),
    [run, reload, sessionId, setFocusedId, setTaskId],
  )

  const sendOps = React.useCallback(
    (ops) =>
      run(async () => {
        await postJson(ROUTE.criteria, { taskId, ops })
        reload()
        return true
      }),
    [run, reload, taskId],
  )

  const addCriterion = React.useCallback((criterion) => sendOps([{ op: 'add', criterion }]), [sendOps])
  const confirmCriterion = React.useCallback((id) => sendOps([{ op: 'confirm', id }]), [sendOps])
  const deleteCriterion = React.useCallback((id) => sendOps([{ op: 'delete', id }]), [sendOps])

  const makePackage = React.useCallback(() => run(() => postText(ROUTE.package, { taskId })), [run, taskId])

  const importRound = React.useCallback(
    (payload) =>
      run(async () => {
        await postJson(ROUTE.importResult, { taskId, payload })
        reload()
        return true
      }),
    [run, reload, taskId],
  )

  const decide = React.useCallback(
    (value, note) =>
      run(async () => {
        await postJson(ROUTE.decision, { taskId, decision: value, note })
        reload()
        return true
      }),
    [run, reload, taskId],
  )

  const exportReceipt = React.useCallback(
    () => run(() => getText(ROUTE.exportMd, { taskId, format: 'md' })),
    [run, taskId],
  )

  // 模式 A：承诺点的分层判定全在宿主，客户端只把 sessionId 递过去，不做任何本地判断。
  const verifyNow = React.useCallback(
    () =>
      run(async () => {
        await postJson(ROUTE.verify, { taskId, sessionId })
        reload()
        return true
      }),
    [run, reload, taskId, sessionId],
  )

  // 逐条人工判定：拼一轮 `producedBy: 'manual'` 的结果，走模式 B 的导入通道。见 JudgementBlock 的注释。
  const judgeCriterion = React.useCallback(
    (criterionId, status, rawNote) =>
      run(async () => {
        const note = String(rawNote ?? '').trim()
        if (status === 'fail' && note.length === 0) throw new Error(t('judgeFailNeed'))
        const receipt = detail?.receipt ?? null
        const roundNumber = (receipt?.rounds?.length ?? 0) + 1
        const now = new Date().toISOString()
        const evaluation = { criterionId, status, note }
        const evidence = []
        if (status === 'pass' || status === 'fail') {
          // 通过必须有证据，否则宿主会整轮拒收（「无证据的通过就是未验证」）。
          // 人工核对的依据就是「谁、何时、在哪、看到什么」——这正是 observation 这种证据。
          const evidenceId = nextEvidenceId(receipt)
          const observed =
            note.length > 0 ? note : status === 'pass' ? '人工核对后判为「符合要求」。' : '人工核对后判为「不符合要求」。'
          evidence.push({
            evidenceId,
            criterionId,
            round: roundNumber,
            kind: 'observation',
            capturedAt: now,
            text: observed,
            ref: { type: 'observation', locator: `我｜${now}｜验收台详情页｜${observed}` },
          })
          evaluation.evidenceIds = [evidenceId]
        }
        if (status === 'fail') {
          evaluation.reproductionSteps = note
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
        }
        await postJson(ROUTE.importResult, {
          taskId,
          payload: {
            startedAt: now,
            finishedAt: now,
            producedBy: 'manual',
            evaluations: [evaluation],
            evidence,
          },
        })
        reload()
        return true
      }),
    [run, reload, taskId, detail, t],
  )

  React.useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    getJson(ROUTE.health, { sessionId }, controller.signal)
      .then((body) => setHealth(body))
      .catch((err) => {
        if (err?.name !== 'AbortError') setError(String(err?.message ?? err))
      })
      .finally(() => setLoading(false))
    getJson(ROUTE.tasks, {}, controller.signal)
      .then((body) => {
        const list = Array.isArray(body.tasks) ? body.tasks : []
        setTasks(list)
        setBroken(Array.isArray(body.broken) ? body.broken : [])
        // 不自动选中时首屏只会说「还没有验收任务」，而列表里明明有 N 个 ——
        // 用户会据此以为插件没装上（真的发生过）。
        setTaskId((current) => pickDefaultTask(list, current))
      })
      .catch(() => {})
    return () => controller.abort()
  }, [sessionId, reloadToken])

  React.useEffect(() => {
    if (!taskId) {
      setDetail(null)
      return undefined
    }
    const controller = new AbortController()
    getJson(ROUTE.receipt, { taskId }, controller.signal)
      .then((body) => {
        setDetail(body)
        const first = (body.receipt?.criteria ?? []).find((item) => !item.deletedAt)
        setFocusedId((current) => current ?? first?.id ?? null)
      })
      .catch((err) => {
        if (err?.name !== 'AbortError') setError(String(err?.message ?? err))
      })
    return () => controller.abort()
  }, [taskId, reloadToken])

  React.useEffect(() => {
    writePage(sessionId, { taskId, focusId: focusedId })
  }, [sessionId, taskId, focusedId])

  if (loading && !health && !error) {
    return React.createElement('div', { className: 'acc-root' },
      React.createElement('div', { className: 'acc-head' }, React.createElement('span', { className: 'acc-title' }, t('tab'))),
      React.createElement('div', { className: 'acc-col acc-pad acc-muted' }, t('loading')))
  }

  if (error && !health) {
    return React.createElement('div', { className: 'acc-root' },
      React.createElement('div', { className: 'acc-head' },
        React.createElement('span', { className: 'acc-title' }, t('tab')),
        React.createElement('span', { className: 'acc-muted' }, `${t('loadFailed')}：${error}`),
        React.createElement('button', { type: 'button', className: 'acc-select', onClick: () => setReloadToken((v) => v + 1) }, t('retry'))),
      React.createElement('div', { className: 'acc-col acc-pad acc-muted' }, t('versionNote')))
  }

  const receipt = detail?.receipt ?? null
  const derived = detail?.derived ?? null
  const statuses = derived?.statuses ?? {}
  const criteria = (receipt?.criteria ?? []).filter((item) => !item.deletedAt)
  const stale = new Set(derived?.stale ?? [])
  const counts = derived?.counts ?? {}
  const statusOf = (item) => statuses?.[item.id] ?? 'pending'
  // 筛选与搜索只决定**看哪些**，不参与任何判断：状态永远来自宿主派生的 `statuses`。
  const needle = query.trim().toLowerCase()
  const visible = criteria.filter(
    (item) =>
      (filter === 'all' || statusOf(item) === filter) &&
      (needle.length === 0 ||
        `${item.id} ${item.title ?? ''} ${item.expected ?? ''}`.toLowerCase().includes(needle)),
  )
  // 选中项一定在可见列表里 —— 否则筛选后右栏会继续显示一个左栏看不见的验收项。
  const focused = visible.find((item) => item.id === focusedId) ?? visible[0] ?? null

  return React.createElement(
    'div',
    { className: 'acc-root', 'data-plugin': NS },
    React.createElement(
      'div',
      { className: 'acc-head' },
      React.createElement('span', { className: 'acc-title' }, t('tab')),
      React.createElement(
        'select',
        {
          className: 'acc-select',
          value: taskId ?? '',
          onChange: (event) => setTaskId(event.target.value || null),
          'aria-label': t('taskList'),
        },
        React.createElement('option', { value: '' }, `${t('chooseTask')}（${tasks.length}）`),
        tasks.map((task) =>
          React.createElement('option', { key: task.taskId, value: task.taskId }, task.taskTitle || task.taskId),
        ),
      ),
      health ? React.createElement('span', { className: 'acc-muted' }, `v${health.version} · schema ${health.schemaVersion}`) : null,
      React.createElement(Btn, { disabled: busy, onClick: () => setShowNew((value) => !value) }, `+ ${t('newTask')}`),
      broken.length > 0 ? React.createElement('span', { className: 'acc-warn' }, `${broken.length} 份凭证读不出来`) : null,
    ),
    derived ? React.createElement(FilterRow, { t, counts, filter, onFilter: setFilter }) : null,
    React.createElement(Err, { t, text: actionError }),
    showNew || !receipt
      ? React.createElement(
          'div',
          { className: 'acc-col acc-pad' },
          React.createElement(NewTaskForm, { t, busy, onCreate: createTask }),
          receipt ? null : React.createElement('div', { className: 'acc-hd' }, tasks.length > 0 ? t('pickOneTitle') : t('emptyTitle')),
          receipt ? null : React.createElement('div', { className: 'acc-note' }, tasks.length > 0 ? t('pickOneBody') : t('emptyBody')),
        )
      : React.createElement(
          'div',
          { className: 'acc-body' },
          React.createElement(
            'div',
            { className: 'acc-col' },
            React.createElement(
              'div',
              { className: 'acc-list-head' },
              React.createElement('span', { className: 'acc-list-title' }, t('listHead')),
              React.createElement('span', { className: 'acc-list-count' }, `${visible.length} / ${criteria.length} ${t('itemUnit')}`),
            ),
            React.createElement('input', {
              className: 'acc-search',
              type: 'search',
              value: query,
              placeholder: t('search'),
              onChange: (event) => setQuery(event.target.value),
            }),
            visible.length === 0
              ? React.createElement(
                  'div',
                  { className: 'acc-pad acc-muted' },
                  criteria.length === 0 ? t('listEmpty') : t('nothingMatches'),
                )
              : React.createElement(CriterionList, {
                  items: visible,
                  statuses,
                  stale,
                  focusedId: focused?.id ?? null,
                  onFocus: setFocusedId,
                  onOpen: setFocusedId,
                  t,
                }),
            React.createElement('div', { className: 'acc-pad' }, React.createElement(AddCriterion, { t, busy, onAdd: addCriterion })),
          ),
          React.createElement(
            'div',
            { className: 'acc-col' },
            focused
              ? React.createElement(
                  React.Fragment,
                  null,
                  React.createElement(DetailPane, {
                    criterion: focused,
                    receipt,
                    status: statusOf(focused),
                    stale,
                    t,
                  }),
                  React.createElement(ReverifyButton, {
                    t,
                    busy,
                    sessionId,
                    activeCount: criteria.length,
                    onVerify: verifyNow,
                  }),
                  React.createElement(MoreWays, {
                    t,
                    busy,
                    sessionId,
                    activeCount: criteria.length,
                    onVerify: verifyNow,
                    onGenerate: makePackage,
                    onImport: importRound,
                  }),
                  React.createElement(JudgementBlock, {
                    t,
                    busy,
                    criterion: focused,
                    status: statusOf(focused),
                    onJudge: judgeCriterion,
                  }),
                  React.createElement(RoundList, { t, rounds: receipt.rounds }),
                  React.createElement(CriterionActions, {
                    t,
                    criterion: focused,
                    busy,
                    onConfirm: confirmCriterion,
                    onDelete: deleteCriterion,
                  }),
                )
              : React.createElement(
                  'div',
                  { className: 'acc-pad' },
                  React.createElement(
                    'div',
                    { className: 'acc-note' },
                    criteria.length === 0 ? t('listEmpty') : t('nothingMatches'),
                  ),
                ),
          ),
        ),
    React.createElement(FooterBar, {
      t,
      busy,
      decision: receipt?.decision ?? null,
      criteria,
      statuses,
      onDecide: decide,
      onExport: exportReceipt,
      onRepair: () => buildRepairText(receipt, statuses, criteria),
    }),
  )
}

let localeService
module.exports.inject = ['slots', 'locale']
module.exports.apply = (ctx) => {
  localeService = ctx.locale
  localeService?.register?.(NS, { zh: ZH, en: EN })
  installStyles(ctx)
  ctx.slots.inject('conversation.view', () =>
    ctx.slots.register(
      { name: 'conversation.view', id: 'acceptance', order: 80, label: () => ZH.tab, locale: NS },
      (props) => React.createElement(Workbench, props),
    ),
  )
}

// Test seam：源码断言看不见一个「渲染时抛错」的组件。
module.exports.__pure = {
  readPage,
  writePage,
  pickDefaultTask,
  STATUS_TEXT,
  STATUS_HINT,
  ROUTE,
  nextEvidenceId,
  buildRepairText,
}
module.exports.__io = { buildUrl, errorTextOf, getJson, getText, postJson, postText }
module.exports.__views = {
  Workbench,
  DetailPane,
  CriterionList,
  EvidenceRow,
  StatusBadge,
  FilterRow,
  JudgementBlock,
  FooterBar,
  MoreWays,
  ReverifyButton,
}
