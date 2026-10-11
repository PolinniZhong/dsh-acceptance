/**
 * Agent 交付验收台 —— host 侧纯函数域（SDD §7）。
 *
 * 纪律：本文件不做 I/O、不碰 ctx、不调模型。所有判定都在这里，客户端零判定。
 * 契约权威 = `02_PRD与SDD/SDD.md`。
 *
 * 本文件里没有、也永远不会有：汇总分数、加权、排序、完成度。
 * 五态并列呈现，不折算（L0 §10 第 1 条）。
 *
 * @module src/dsh/host/domain
 */

/** 契约版本。改动 `TaskReceipt` 形状必须 +1（SDD §2.1）。 */
export const SCHEMA_VERSION = 1

/**
 * 五态。**恰好五个**，增删即违约（守卫 G4）。
 * `unknown` 是「未验证」，**不是**失败：没有证据不等于没做对（L0 §10 第 2 条）。
 */
export const STATUSES = Object.freeze(['pending', 'pass', 'fail', 'unknown', 'blocked'])

/** 五态的中文显示名。它是一个**列表**，不是一个分数。 */
export const STATUS_LABELS = Object.freeze({
  pending: '待验证',
  pass: '通过',
  fail: '未通过',
  unknown: '未验证',
  blocked: '被阻塞',
})

/** 证据种类（SDD §4.1）。`kind` 与 `ref.type` 必须相等。 */
export const EVIDENCE_KINDS = Object.freeze(['command', 'file', 'url', 'screenshot', 'observation'])

/**
 * `origin` 是一等字段（SDD §2.2）：模型补充的验收建议**不许**混进原始需求。
 */
export const ORIGINS = Object.freeze(['original', 'suggested'])

/** 写入模式（SDD §6）：谁产出了这一轮结论。记事实，不排名。 */
export const PRODUCERS = Object.freeze(['agent', 'manual', 'pasted'])

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 全角竖线 U+FF5C，`observation` 的定位符分隔符（恰 3 个）。 */
const FULLWIDTH_BAR = '\uFF5C'

const FILE_LOCATOR = /^(.+?):(\d+)(?:-(\d+))?$/
const SCREENSHOT_EXT = /\.(png|jpe?g|webp)$/i
const URL_PREFIX = /^https?:\/\//i
const ISO_LIKE = /^\d{4}-\d{2}-\d{2}T/

function isAbsPath(value) {
  if (typeof value !== 'string' || value.length === 0) return false
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function isSafeCount(value) {
  return Number.isInteger(value) && value >= 0
}

/** 两位补零。 */
function pad2(value) {
  return String(value).padStart(2, '0')
}

// ---------------------------------------------------------------------------
// id 生成
// ---------------------------------------------------------------------------

/**
 * 凭证编号：`TR-<YYYYMMDD>-<HHmm>-<4位随机>`（SDD §2.1）。
 *
 * **每次真实生成**，不是写死的常量。日期与时间取自传入的 `now`，
 * 使这个函数保持纯粹、可测。
 *
 * @param {Date} [now]
 * @param {() => number} [random] 返回 `[0, 1)`；注入以便测试。
 */
export function newReceiptId(now = new Date(), random = Math.random) {
  const stamp = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}`
  const clock = `${pad2(now.getHours())}${pad2(now.getMinutes())}`
  const suffix = String(Math.floor(random() * 0x10000).toString(16)).padStart(4, '0').slice(-4)
  return `TR-${stamp}-${clock}-${suffix}`
}

/**
 * 下一个验收项 id。**单调递增，永不复用已删除的 id**（SDD §3、守卫 G8）。
 *
 * 复用一个删除过的 `AC-03` 会让第 1 轮的结论悄悄挂到第 3 轮的另一条要求上 ——
 * 那不是 bug，那是伪造历史。
 *
 * @param {readonly {id: string}[]} criteria 现有验收项（**含已删除的**）
 */
export function nextCriterionId(criteria) {
  let max = 0
  for (const item of criteria ?? []) {
    const match = /^AC-(\d+)$/.exec(String(item?.id ?? ''))
    if (!match) continue
    const n = Number(match[1])
    if (Number.isSafeInteger(n) && n > max) max = n
  }
  return `AC-${pad2(max + 1)}`
}

// ---------------------------------------------------------------------------
// 证据校验（SDD §4.2，守卫 G5）
// ---------------------------------------------------------------------------

/**
 * 校验一个定位符。**失败形态是「拒绝写入 + 报错」**，不降级成空 locator、不猜。
 *
 * @returns {string[]} 错误消息；空数组表示通过。
 */
export function validateLocator(kind, locator, evidence = {}) {
  const errors = []
  if (!isNonEmptyString(locator)) return ['ref.locator 不能为空 —— 定位不到的东西不算证据']

  switch (kind) {
    case 'command': {
      if (locator.includes('\n')) errors.push('command 的 locator 必须是单行命令原文')
      if (!Number.isInteger(evidence.exitCode)) {
        errors.push('command 证据必须带整数 exitCode（否则无法区分「跑通了」与「跑失败了」）')
      }
      break
    }
    case 'file': {
      const match = FILE_LOCATOR.exec(locator)
      if (!match) {
        errors.push('file 的 locator 必须是 <绝对路径>:<行> 或 <绝对路径>:<起>-<止>')
        break
      }
      const [, path, startText, endText] = match
      if (!isAbsPath(path)) errors.push(`file 的 locator 必须是绝对路径，实为 ${JSON.stringify(path)}`)
      const start = Number(startText)
      if (endText !== undefined && Number(endText) < start) {
        errors.push(`file 的 locator 行区间倒置：${startText}-${endText}`)
      }
      break
    }
    case 'url': {
      if (!URL_PREFIX.test(locator)) errors.push('url 的 locator 必须以 http:// 或 https:// 开头')
      break
    }
    case 'screenshot': {
      if (!isAbsPath(locator)) errors.push('screenshot 的 locator 必须是绝对路径')
      if (!SCREENSHOT_EXT.test(locator)) errors.push('screenshot 的 locator 必须以 .png/.jpg/.jpeg/.webp 结尾')
      break
    }
    case 'observation': {
      const parts = locator.split(FULLWIDTH_BAR)
      if (parts.length !== 4) {
        errors.push(`observation 的 locator 必须是「谁｜何时｜在哪｜现象」，恰好 3 个「｜」，实为 ${parts.length - 1} 个`)
      } else if (parts.some((part) => part.trim().length === 0)) {
        errors.push('observation 的 locator 有空的段落')
      }
      break
    }
    default:
      errors.push(`未知证据种类 ${JSON.stringify(kind)}`)
  }
  return errors
}

/**
 * 校验一条证据（SDD §4.2 V1–V7）。
 *
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateEvidence(evidence) {
  const errors = []
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    return { ok: false, errors: ['evidence 不是对象'] }
  }

  const { evidenceId, criterionId, round, kind, capturedAt, text, ref } = evidence

  if (!/^EV-\d{4}$/.test(String(evidenceId ?? ''))) {
    errors.push(`evidenceId 必须是 EV-0001 形态，实为 ${JSON.stringify(evidenceId)}`)
  }
  if (!isNonEmptyString(criterionId)) errors.push('criterionId 缺失')
  if (!Number.isInteger(round) || round < 1) errors.push('round 必须是正整数')
  if (!EVIDENCE_KINDS.includes(kind)) {
    errors.push(`kind 必须是 ${EVIDENCE_KINDS.join(' / ')} 之一，实为 ${JSON.stringify(kind)}`)
  }
  if (!isNonEmptyString(capturedAt) || !ISO_LIKE.test(capturedAt)) {
    errors.push('capturedAt 必须是 ISO 时间字符串')
  }
  if (!isNonEmptyString(text)) errors.push('text 不能为空 —— 只有定位符没有观察到什么，等于没记')

  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) {
    errors.push('ref 缺失 —— 定位不到的东西不算证据')
    return { ok: false, errors }
  }
  if (ref.type !== kind) {
    errors.push(`ref.type 必须等于 kind（${JSON.stringify(kind)}），实为 ${JSON.stringify(ref.type)}`)
  }
  if (ref.excerpt !== undefined && ref.excerpt !== null && !isNonEmptyString(ref.excerpt)) {
    errors.push('ref.excerpt 存在时不能为空')
  }
  errors.push(...validateLocator(kind, ref.locator, evidence))

  return { ok: errors.length === 0, errors }
}

// ---------------------------------------------------------------------------
// 轮次与派生（SDD §2.6）
// ---------------------------------------------------------------------------

/**
 * 当前状态 = 轮次按 `round` **降序**第一条含该验收项的 evaluation 的 `status`；
 * 一条都没有 = `pending`。
 *
 * 注意：这里**不**回退到更早轮次去找结论。回退会把「本轮没查」显示成「上轮通过」，
 * 那是把陈旧结论当新鲜结论用。
 *
 * @returns {Record<string, 'pending'|'pass'|'fail'|'unknown'|'blocked'>}
 */
export function deriveCurrentStatuses(receipt) {
  const out = {}
  for (const criterion of receipt?.criteria ?? []) {
    if (criterion?.deletedAt) continue
    out[criterion.id] = 'pending'
  }
  const rounds = [...(receipt?.rounds ?? [])].sort((a, b) => (b?.round ?? 0) - (a?.round ?? 0))
  const decided = new Set()
  for (const round of rounds) {
    for (const evaluation of round?.evaluations ?? []) {
      const id = evaluation?.criterionId
      if (!id || decided.has(id) || !(id in out)) continue
      if (STATUSES.includes(evaluation.status)) out[id] = evaluation.status
      decided.add(id)
    }
  }
  return out
}

/**
 * 最后一轮**没有**复查到的验收项集合（SDD §2.6 `staleInLatestRound`）。
 *
 * 界面必须把这些标成「本轮未复查」，**不得**沿用上一轮的 pass 却不加标注。
 *
 * @returns {Set<string>}
 */
export function staleInLatestRound(receipt) {
  const rounds = [...(receipt?.rounds ?? [])].sort((a, b) => (b?.round ?? 0) - (a?.round ?? 0))
  const stale = new Set()
  const active = (receipt?.criteria ?? []).filter((c) => !c?.deletedAt).map((c) => c.id)
  if (rounds.length === 0) return new Set(active)
  const seen = new Set((rounds[0]?.evaluations ?? []).map((e) => e?.criterionId))
  for (const id of active) if (!seen.has(id)) stale.add(id)
  return stale
}

/**
 * 五态计数。**只用于分列显示，不参与任何加权、排序或折算**（SDD §7）。
 *
 * @returns {Record<string, number>} 五个键恒在，缺的填 0。
 */
export function summarizeCounts(receipt) {
  const statuses = deriveCurrentStatuses(receipt)
  const counts = Object.fromEntries(STATUSES.map((status) => [status, 0]))
  for (const status of Object.values(statuses)) {
    if (STATUSES.includes(status)) counts[status] += 1
  }
  return counts
}

/**
 * 追加一轮。**`rounds` 只增不改**（SDD §2.3）—— 结论要能被复核，历史不许被覆盖。
 *
 * @returns {{ receipt: object, errors: string[] }}
 */
export function appendRound(receipt, round) {
  const errors = []
  if (!receipt || typeof receipt !== 'object') return { receipt, errors: ['receipt 不是对象'] }
  if (!round || typeof round !== 'object') return { receipt, errors: ['round 不是对象'] }
  if (!Number.isInteger(round.round) || round.round < 1) errors.push('round.round 必须是正整数')
  if (!['verify', 'reverify'].includes(round.kind)) errors.push('round.kind 必须是 verify 或 reverify')
  if (!PRODUCERS.includes(round.producedBy)) {
    errors.push(`round.producedBy 必须是 ${PRODUCERS.join(' / ')} 之一`)
  }
  const known = new Set((receipt.criteria ?? []).map((c) => c?.id))
  for (const evaluation of round.evaluations ?? []) {
    if (!STATUSES.includes(evaluation?.status)) {
      errors.push(`evaluation.status 必须是 ${STATUSES.join(' / ')} 之一，实为 ${JSON.stringify(evaluation?.status)}`)
    }
    // 指向不存在的验收项时，`deriveCurrentStatuses` 会**静默忽略**这一条 —— 结论就此消失。
    // 宁可写入时拒掉（SDD §4 的失败形态：拒绝写入 + 报错，不降级）。
    if (evaluation?.criterionId && !known.has(evaluation.criterionId)) {
      errors.push(`evaluation 指向不存在的验收项 ${JSON.stringify(evaluation.criterionId)}`)
    }
  }
  if (errors.length > 0) return { receipt, errors }

  const rounds = [...(receipt.rounds ?? []), round]
  return {
    receipt: { ...receipt, rounds, updatedAt: round.finishedAt ?? receipt.updatedAt },
    errors: [],
  }
}
// ---------------------------------------------------------------------------
// 凭证构造与校验
// ---------------------------------------------------------------------------

/**
 * 建一份空凭证。**不接受任何汇总评分或折算比率参数** —— 它们没有位置可放。
 */
export function createReceipt({
  taskId,
  taskTitle = '',
  requirementText,
  scope = {},
  now = new Date(),
  receiptId,
} = {}) {
  const iso = now.toISOString()
  return {
    schemaVersion: SCHEMA_VERSION,
    receiptId: receiptId ?? newReceiptId(now),
    taskId: String(taskId ?? ''),
    taskTitle,
    requirementText: requirementText ?? '',
    scope: {
      cwd: scope.cwd ?? null,
      branch: scope.branch ?? null,
      changedFiles: Array.isArray(scope.changedFiles) ? [...scope.changedFiles] : [],
      // `changedFiles: []` 至少三种成因（确实没改 / 宿主重启后摘要丢失 / 无 git 仓库时
      // bash 改动不录）。`changedFilesSource` 记录**这次是怎么得来的**，
      // 界面才有资格说那三句不同的话（S5 §3.2）。
      changedFilesSource: scope.changedFilesSource ?? 'unknown',
      runUrl: scope.runUrl ?? null,
    },
    createdAt: iso,
    updatedAt: iso,
    criteria: [],
    rounds: [],
    evidence: [],
    repairs: [],
    decision: null,
  }
}

/**
 * 校验整份凭证。
 *
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateReceipt(receipt) {
  const errors = []
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    return { ok: false, errors: ['receipt 不是对象'] }
  }
  if (receipt.schemaVersion !== SCHEMA_VERSION) {
    errors.push(`schemaVersion 必须是 ${SCHEMA_VERSION}，实为 ${JSON.stringify(receipt.schemaVersion)}`)
  }
  if (!/^TR-\d{8}-\d{4}-[0-9a-f]{4}$/.test(String(receipt.receiptId ?? ''))) {
    errors.push(`receiptId 形态不合法：${JSON.stringify(receipt.receiptId)}`)
  }
  if (!isNonEmptyString(receipt.requirementText)) {
    errors.push('requirementText 不能为空 —— 原始需求是这张凭证存在的理由')
  }

  const criterionIds = new Set()
  for (const criterion of receipt.criteria ?? []) {
    if (!/^AC-\d{2,}$/.test(String(criterion?.id ?? ''))) {
      errors.push(`criteria[].id 形态不合法：${JSON.stringify(criterion?.id)}`)
      continue
    }
    if (criterionIds.has(criterion.id)) errors.push(`criteria[] 里出现重复 id ${criterion.id}`)
    criterionIds.add(criterion.id)
    if (!ORIGINS.includes(criterion.origin)) {
      errors.push(`${criterion.id}.origin 必须是 original 或 suggested`)
    }
  }

  const evidenceIds = new Set()
  for (const evidence of receipt.evidence ?? []) {
    const result = validateEvidence(evidence)
    errors.push(...result.errors.map((message) => `${evidence?.evidenceId ?? '(无 id)'}: ${message}`))
    if (evidenceIds.has(evidence?.evidenceId)) errors.push(`evidence[] 里出现重复 id ${evidence.evidenceId}`)
    evidenceIds.add(evidence?.evidenceId)
    if (evidence?.criterionId && !criterionIds.has(evidence.criterionId)) {
      errors.push(`${evidence.evidenceId} 指向不存在的验收项 ${evidence.criterionId}`)
    }
  }

  for (const round of receipt.rounds ?? []) {
    for (const evaluation of round?.evaluations ?? []) {
      if (!STATUSES.includes(evaluation?.status)) {
        errors.push(`第 ${round?.round} 轮的 ${evaluation?.criterionId} 状态非法：${JSON.stringify(evaluation?.status)}`)
      }
      if (evaluation?.criterionId && !criterionIds.has(evaluation.criterionId)) {
        errors.push(`第 ${round?.round} 轮引用了不存在的验收项 ${evaluation.criterionId}`)
      }
      for (const id of evaluation?.evidenceIds ?? []) {
        if (!evidenceIds.has(id)) {
          errors.push(`第 ${round?.round} 轮的 ${evaluation?.criterionId} 引用了不存在的证据 ${id}`)
        }
      }
      if (evaluation?.status === 'fail' && !evaluation?.reproductionSteps?.length) {
        errors.push(`第 ${round?.round} 轮的 ${evaluation?.criterionId} 判为未通过但没写复现步骤`)
      }
    }
  }

  return { ok: errors.length === 0, errors }
}

// ---------------------------------------------------------------------------
// 「这一轮还算数吗」—— 两个必须并列显示的标注（SDD §2.6、§9）
// ---------------------------------------------------------------------------

/**
 * 这一轮的结论是不是对着**另一个版本**下的（`outdatedByScopeChange`）。
 *
 * 第一版没有版本指纹（`fingerprint` 恒 `null`，决策 D-016），所以这里**只能**比较
 * 「记录时的变更范围」与「现在的变更范围」。它证得了「变了」，证不了「没变」——
 * 因此返回 `changed: true` 时写「**可能**已过期」，`false` 时不写任何「新鲜」的话。
 *
 * @returns {{ changed: boolean, reason: 'scope-drifted' | 'unknown-version' }}
 */
export function scopeDrift(receipt, round) {
  const recorded = round?.scopeSnapshot?.changedFiles
  const current = receipt?.scope?.changedFiles
  if (Array.isArray(recorded) && Array.isArray(current)) {
    const a = [...recorded].sort().join('\n')
    const b = [...current].sort().join('\n')
    if (a !== b) return { changed: true, reason: 'scope-drifted' }
  }
  // 指纹拿不到 ⇒ 永远是「版本未知」，不许说「没变」。
  return { changed: false, reason: 'unknown-version' }
}

/** `unknown` 是「未验证」，**不是**失败。导出里也必须这么写。 */
function statusCell(status) {
  return `${STATUS_LABELS[status] ?? status}（\`${status}\`）`
}

function evidenceLine(evidence) {
  const locator = evidence?.ref?.locator ?? '(缺定位符)'
  const exit = Number.isInteger(evidence?.exitCode) ? `，退出码 ${evidence.exitCode}` : ''
  return `  - \`${evidence?.evidenceId}\` [${evidence?.kind}]${exit} — ${evidence?.text ?? ''}\n    - 定位：\`${String(locator).replace(/\n/g, ' ⏎ ')}\``
}

function criteriaSection(receipt, origin, statuses, stale) {
  const items = (receipt.criteria ?? []).filter((c) => !c.deletedAt && c.origin === origin)
  if (items.length === 0) return '（无）\n'
  const lines = []
  for (const criterion of items) {
    const status = statuses[criterion.id] ?? 'pending'
    const marks = []
    if (stale.has(criterion.id)) marks.push('**本轮未复查**')
    const suffix = marks.length > 0 ? `　${marks.join('　')}` : ''
    lines.push(`### ${criterion.id}　${criterion.title}`)
    lines.push('')
    lines.push(`- 结论：${statusCell(status)}${suffix}`)
    lines.push(`- 方式：\`${criterion.method}\`　确认于：${criterion.confirmedByUserAt ?? '**尚未确认**'}`)
    if (criterion.sourceQuote) lines.push(`- 原话：「${criterion.sourceQuote}」`)
    if (criterion.expected) lines.push(`- 期望：${criterion.expected}`)
    const evidence = (receipt.evidence ?? []).filter((e) => e.criterionId === criterion.id)
    if (evidence.length === 0) {
      lines.push('- 证据：**无** —— 因此结论最多只能到「未验证」')
    } else {
      lines.push('- 证据：')
      for (const item of evidence) lines.push(evidenceLine(item))
    }
    lines.push('')
  }
  return lines.join('\n')
}

/**
 * 导出 Markdown 凭证（SDD §9「导出结构」）。
 *
 * 导出件必须比界面**不少任何标注**，否则「导出件更可信」就是退步。
 * 五态**分列计数，不折算** —— 这里没有、也永远不会有任何汇总比率。
 */
export function buildMarkdownExport(receipt, { now = new Date() } = {}) {
  const statuses = deriveCurrentStatuses(receipt)
  const stale = staleInLatestRound(receipt)
  const counts = summarizeCounts(receipt)
  const lines = []

  lines.push(`# 交付验收凭证 ${receipt.receiptId}`)
  lines.push('')
  lines.push(`- 任务：${receipt.taskTitle || '(未命名)'}（\`${receipt.taskId}\`）`)
  lines.push(`- 导出时间：${now.toISOString()}`)
  lines.push(`- 契约版本：schemaVersion ${receipt.schemaVersion}`)
  lines.push('')

  lines.push('## 原始需求（逐字，未改写）')
  lines.push('')
  lines.push('> ' + String(receipt.requirementText ?? '').split('\n').join('\n> '))
  lines.push('')

  lines.push('## 状态汇总（五态并列，**不折算、无总分**）')
  lines.push('')
  lines.push('| 状态 | 含义 | 数量 |')
  lines.push('|---|---|---|')
  for (const status of STATUSES) {
    lines.push(`| \`${status}\` | ${STATUS_LABELS[status]} | ${counts[status] ?? 0} |`)
  }
  lines.push('')
  lines.push('> 本凭证不提供任何汇总比率、评分或折算口径。`unknown` 表示**未验证**，不等于失败。')
  lines.push('')

  lines.push('## 验收范围与版本')
  lines.push('')
  lines.push(`- 工作目录：\`${receipt.scope?.cwd ?? '(未记录)'}\``)
  lines.push(`- 分支：${receipt.scope?.branch ?? '(未记录)'}`)
  lines.push(`- 变更范围来源：\`${receipt.scope?.changedFilesSource ?? 'unknown'}\``)
  const changed = receipt.scope?.changedFiles ?? []
  if (changed.length > 0) {
    lines.push(`- 记录的变更文件（${changed.length}）：`)
    for (const file of changed) lines.push(`  - \`${file}\``)
  } else {
    // 空列表至少三种成因，导出里必须说清楚**是哪一种**（L0 §10 第 10 条）。
    const why =
      {
        'workspace-changes':
          '本次运行没有记录到任何文件改动。注意：在没有 git 仓库的工作目录下，只录 `write`/`edit` 的改动，**shell 命令造成的改动不在其中**。',
        'no-turn-recorded': '父会话里没有「一轮结束」的记录，**无法判断有没有改动**（不是「没有改动」）。',
        'summary-unavailable': '宿主重启过或会话已销毁，变更摘要在宿主内存里、**没有落盘**，因此无法判断有没有改动。',
        'no-session': '创建时没有带会话，**无法判断有没有改动**。',
      }[receipt.scope?.changedFilesSource] ?? '**无法判断有没有改动。**'
    lines.push(`- 变更文件：${why}`)
  }
  lines.push('- **版本指纹：未知。** 本工作目录不是 git 仓库，取不到快照标识，因此本凭证无法证明各轮结论跑在同一份代码上。')
  lines.push('')

  lines.push('## 验收项结论 —— 原始需求（`origin=original`）')
  lines.push('')
  lines.push(criteriaSection(receipt, 'original', statuses, stale))

  lines.push('## 验收项结论 —— 建议补充（`origin=suggested`，**不是**原始需求）')
  lines.push('')
  lines.push('> 以下条目由工具或模型建议，未混入上面的原始需求。它们可以是 `pending`，也可以是 `fail`。')
  lines.push('')
  lines.push(criteriaSection(receipt, 'suggested', statuses, stale))

  lines.push('## 逐轮记录')
  lines.push('')
  const rounds = [...(receipt.rounds ?? [])].sort((a, b) => (a.round ?? 0) - (b.round ?? 0))
  if (rounds.length === 0) {
    lines.push('（尚无任何验收轮次 —— 所有验收项因此都是 `pending` / `unknown`。）')
    lines.push('')
  }
  for (const round of rounds) {
    const drift = scopeDrift(receipt, round)
    lines.push(`### 第 ${round.round} 轮（${round.kind}，产出者 \`${round.producedBy}\`）`)
    lines.push('')
    lines.push(`- 起止：${round.startedAt} → ${round.finishedAt}`)
    lines.push(`- 该轮版本：${round.scopeSnapshot?.fingerprint ?? '**版本未知**'}`)
    if (drift.changed) lines.push('- 标注：**可能已过期** —— 这一轮之后，记录的变更范围已经不同了。')
    else lines.push('- 标注：**版本未知** —— 无法证明这一轮的结论仍然对应当前代码。')
    if (round.blockedReason) lines.push(`- 阻塞原因：${round.blockedReason}`)
    lines.push('')
    for (const evaluation of round.evaluations ?? []) {
      lines.push(`- \`${evaluation.criterionId}\` → ${statusCell(evaluation.status)}`)
      if (evaluation.note) lines.push(`  - 备注：${evaluation.note}`)
      if (evaluation.reproductionSteps?.length) {
        lines.push('  - 复现步骤：')
        for (const step of evaluation.reproductionSteps) lines.push(`    1. ${step}`)
      }
    }
    lines.push('')
  }

  lines.push('## 用户的最终决定')
  lines.push('')
  if (receipt.decision) {
    lines.push(`- 决定：**${receipt.decision.value}**`)
    lines.push(`- 时间：${receipt.decision.decidedAt}`)
    if (receipt.decision.note) lines.push(`- 备注：${receipt.decision.note}`)
    const at = receipt.decision.countsAtDecision ?? {}
    lines.push(
      `- 决定时的五态计数：${STATUSES.map((s) => `${STATUS_LABELS[s]} ${at[s] ?? 0}`).join(' · ')}（记录，非评分）`,
    )
  } else {
    lines.push('（尚未作出决定。）')
  }
  lines.push('')

  lines.push('## 验收规则声明')
  lines.push('')
  lines.push('1. **没有证据就不是通过。** 无证据的验收项记 `未验证`，不自动判失败，也不自动判通过。')
  lines.push('2. **每条证据都带可寻址的定位符。** 定位不到的东西不算证据，写入时即被拒绝。')
  lines.push('3. **原始需求与建议补充分列。** `origin=suggested` 的条目不是用户提的要求。')
  lines.push('4. **不做汇总评分。** 五态并列呈现，不折算、不加权、不排序。')
  lines.push('5. **本凭证的证据只对其各自记录的版本有效。** 版本未知时，请以「版本未知」为准，不要默认为当前代码。')

  return `${lines.join('\n')}\n`
}

/**
 * 模式 B：生成给人在任意 AI 里跑的验收包（SDD §6）。
 *
 * 包里必须带上**回复的 JSON 契约原文**，否则粘回来的东西千奇百怪，
 * 「过同一个校验器」就成了一句空话。
 */
export function buildAcceptancePackage(receipt) {
  const criteria = (receipt.criteria ?? []).filter((c) => !c.deletedAt)
  const round = (receipt.rounds?.length ?? 0) + 1
  const schema = {
    evaluations: [
      {
        criterionId: 'AC-01',
        status: STATUSES.join(' | '),
        evidenceIds: ['EV-0001'],
        reproductionSteps: ['（仅 status=fail 时必填）'],
        note: '（可空）',
      },
    ],
    evidence: [
      {
        evidenceId: 'EV-0001',
        criterionId: 'AC-01',
        round,
        kind: EVIDENCE_KINDS.join(' | '),
        capturedAt: '（ISO 时间）',
        text: '（观察到了什么）',
        exitCode: '（kind=command 时必填，整数）',
        ref: {
          type: '与 kind 相同',
          locator:
            'command=单行命令原文 ｜ file=<绝对路径>:<行> ｜ url=http(s)://… ｜ screenshot=<绝对路径>.png ｜ observation=谁｜何时｜在哪｜现象（恰 3 个全角｜）',
          excerpt: '（可空，原文片段）',
        },
      },
    ],
    startedAt: '（ISO 时间）',
    finishedAt: '（ISO 时间）',
    blockedReason: '（可空；整体被阻塞时填写）',
  }

  const fence = '`'.repeat(3)
  const lines = []
  lines.push(`# 验收包 —— ${receipt.taskTitle || receipt.taskId}`)
  lines.push('')
  lines.push('把这个包整段交给任何一个能读代码、能跑命令的 AI。**不要**替它补全结论。')
  lines.push('')
  lines.push('## 原始需求（逐字，不许改写）')
  lines.push('')
  lines.push('> ' + String(receipt.requirementText ?? '').split('\n').join('\n> '))
  lines.push('')
  lines.push('## 需要逐条给出结论的验收项')
  lines.push('')
  for (const criterion of criteria) {
    lines.push(`### ${criterion.id}　${criterion.title}`)
    lines.push('')
    if (criterion.sourceQuote) lines.push(`- 原话依据：「${criterion.sourceQuote}」`)
    if (criterion.precondition) lines.push(`- 前置条件：${criterion.precondition}`)
    if (criterion.steps?.length) {
      lines.push('- 步骤：')
      for (const step of criterion.steps) lines.push(`  1. ${step}`)
    }
    if (criterion.expected) lines.push(`- 期望：${criterion.expected}`)
    lines.push(`- 建议方式：\`${criterion.method}\``)
    lines.push('')
  }
  lines.push('## 三条硬规则')
  lines.push('')
  lines.push('1. **没有证据就不是通过。** 查不到就写 `unknown`（未验证），**不要**猜成 `pass`，也**不要**自动判成 `fail`。')
  lines.push('2. **每条证据必须可寻址。** 命令证据要带退出码；文件证据要带绝对路径和行号；观察证据要写清是谁在何时何地看到的。')
  lines.push('3. **不许给总分或任何汇总比率。** 五态并列，逐项给结论。')
  lines.push('')
  lines.push('## 回复格式（**单个裸 JSON 对象**，不要代码围栏、不要前后解说）')
  lines.push('')
  lines.push(`${fence}json`)
  lines.push(JSON.stringify(schema, null, 2))
  lines.push(fence)
  lines.push('')
  lines.push(`\`round\` 一律填 ${round}。删掉示例里的占位条目，只保留真实结论。`)
  lines.push('')
  return `${lines.join('\n')}\n`
}

// ---------------------------------------------------------------------------
// 模式 A：委派（SDD §5）
// ---------------------------------------------------------------------------

/** 下一轮的编号。轮次**只增不改**，编号由凭证自己算，不由调用方给。 */
export function delegationRoundNumber(receipt) {
  return (receipt?.rounds?.length ?? 0) + 1
}

/** 第一次是 `verify`，之后一律 `reverify`。 */
export function delegationRoundKind(receipt) {
  return (receipt?.rounds?.length ?? 0) > 0 ? 'reverify' : 'verify'
}

/**
 * 委派用的 `outputSchema`（SDD §5.2）。
 *
 * ⚠️ **必须整个落在 DSH `assertObjectJsonSchema` 允许的子集内**，否则 `ctx.subagents.start()`
 * 会**直接拒绝启动**（抛 `JsonSchemaError`，`code: 'UNSUPPORTED_SCHEMA'`）。子集：
 * 约束只有 `type` / `properties` / `required` / `additionalProperties` / `items` / `enum` / `const` / `oneOf`；
 * 注解只有 `description` / `title` / `default` / `examples`。**没有** `$ref` / `format` / `pattern` /
 * `minLength` / `allOf` / `anyOf`，也不支持类型数组；根必须是 `type: "object"`。
 *
 * 为什么 `id` 用 `enum` 把已存在的验收项钉死：子 Agent 自己编一个 `AC-07` 出来，
 * `deriveCurrentStatuses` 会**静默忽略**（结论凭空消失），`appendRound` 会直接拒。
 * 让 schema 先挡住，比事后补救好。
 */
export function buildVerifySchema(criteria) {
  const active = (criteria ?? []).filter((criterion) => criterion && !criterion.deletedAt)
  return {
    type: 'object',
    additionalProperties: false,
    required: ['criteria'],
    properties: {
      criteria: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'status', 'evidence'],
          properties: {
            id: {
              type: 'string',
              enum: active.map((criterion) => criterion.id),
              description: '凭证里已存在的验收项 id，不许新造',
            },
            status: {
              type: 'string',
              enum: [...STATUSES],
              description: '五态之一。没有证据就写 unknown；不许猜成 pass，也不许自动判成 fail',
            },
            evidence: {
              type: 'array',
              description: 'status 为 pass 或 fail 时至少一条；unknown / blocked 可以为空',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['kind', 'text', 'locator'],
                properties: {
                  kind: { type: 'string', enum: [...EVIDENCE_KINDS] },
                  text: { type: 'string', description: '观察到了什么。只有定位符等于没记' },
                  locator: { type: 'string', description: '能让人重新找到它的定位符' },
                  excerpt: { type: 'string' },
                  capturedAt: { type: 'string', description: 'ISO 时间；留空由宿主填' },
                  exitCode: { type: 'integer', description: 'kind=command 时填' },
                },
              },
            },
            reproductionSteps: {
              type: 'array',
              items: { type: 'string' },
              description: 'status=fail 时**必填**，否则这条 fail 会被拒收',
            },
            note: { type: 'string' },
          },
        },
      },
    },
  }
}

/**
 * 模式 A 的委派提示词。
 *
 * 与模式 B 的验收包**刻意不共用**：模式 B 面对的是「人把包贴给任意 AI」，要求回复
 * `{evaluations, evidence}`；模式 A 面对的是「宿主用 schema 约束的子 Agent」，要求回复
 * `{criteria:[{id,status,evidence}]}`。两者产出**同一种 `round`**（SDD §6 的不变量），
 * 但要求模型输出的形状不同 —— 硬凑成一份文本会让两边都要做形状翻译。
 */
export function buildDelegationPrompt(receipt) {
  const active = (receipt?.criteria ?? []).filter((criterion) => criterion && !criterion.deletedAt)
  const lines = []
  lines.push('你是一次**独立验收**。你的任务不是证明它没问题，而是**如实回答每一项被验证了没有**。')
  lines.push('')
  lines.push('## 原始需求（逐字。不许改写，不许补充，不许替它圆场）')
  lines.push('')
  lines.push('```')
  lines.push(String(receipt?.requirementText ?? '').trim())
  lines.push('```')
  lines.push('')
  lines.push('## 要你逐条回答的验收项')
  lines.push('')
  for (const criterion of active) {
    lines.push(`### ${criterion.id}　${criterion.title}`)
    lines.push('')
    if (criterion.sourceQuote) lines.push(`- 原话依据：「${criterion.sourceQuote}」`)
    if (criterion.precondition) lines.push(`- 前置条件：${criterion.precondition}`)
    if (criterion.steps?.length) {
      lines.push('- 步骤：')
      for (const step of criterion.steps) lines.push(`  1. ${step}`)
    }
    if (criterion.expected) lines.push(`- 期望：${criterion.expected}`)
    lines.push(`- 建议方式：\`${criterion.method}\``)
    lines.push('')
  }
  lines.push('## 三条硬规则')
  lines.push('')
  lines.push('1. **没有证据就不是通过。** 查不到就写 `unknown`（未验证），**不要**猜成 `pass`，也**不要**自动判成 `fail`。')
  lines.push('2. **每条证据必须可寻址。** 命令证据带退出码和**命令原文**；文件证据带**绝对路径和行号**；观察证据写清是谁在何时何地看到的。')
  lines.push('3. **不许给总分或任何汇总比率。** 五态并列，逐项给结论。')
  lines.push('')
  lines.push('## 额外说明')
  lines.push('')
  lines.push('- 你**不要**修改被验收的代码。你的产出只有结论和证据。')
  lines.push('- 判 `fail` 就必须写 `reproductionSteps`（怎么复现），否则这条结论会被拒收 —— 没有复现步骤的 fail 没法返修。')
  lines.push('- 结果按给定的 JSON schema 返回；**所有**验收项都要出现，判不了的写 `unknown`。漏项不会变成通过，但会让这一轮不完整。')
  lines.push('')
  return `${lines.join('\n')}\n`
}

/**
 * 把子 Agent 的结构化结果**规范化**成一轮 `evaluations` + `evidence`。
 *
 * 三件事在契约里不能省：
 *  - `evidenceId` 与 `round` 由**宿主**分配，不给模型编造的机会（S4 实测里模型会编 `EV-1`）；
 *  - `fail` 没有复现步骤 ⇒ 拒收这一条（`validateReceipt` 也会拒，但在这里拒能给出更好的话）；
 *  - `pass` 一条证据都没有 ⇒ 拒收这一条。**这是本产品的核心不变量**，宁可少一条结论。
 *
 * 被拒的条目**不留默认值**，最后的漏项检查会把它显式落成 `unknown` 并注明原因 ——
 * 沉默地留在旧状态等于把陈旧结论当新鲜结论用。
 *
 * @returns {{ round: number|null, evidence: object[], evaluations: object[], errors: string[] }}
 */
export function normalizeDelegatedResult(receipt, structured, { startedAt, finishedAt } = {}) {
  const round = delegationRoundNumber(receipt)
  const empty = { round: null, evidence: [], evaluations: [], errors: [] }
  if (!structured || typeof structured !== 'object' || Array.isArray(structured)) {
    return { ...empty, errors: ['structured 不是对象'] }
  }
  if (!Array.isArray(structured.criteria)) {
    return { ...empty, errors: ['structured.criteria 不是数组'] }
  }

  const all = receipt?.criteria ?? []
  const active = all.filter((criterion) => criterion && !criterion.deletedAt)
  const knownIds = new Set(all.map((criterion) => criterion?.id))
  const activeIds = new Set(active.map((criterion) => criterion.id))

  let seq = (receipt?.evidence ?? []).reduce((max, entry) => {
    const matched = /^EV-(\d{4})$/.exec(String(entry?.evidenceId ?? ''))
    return matched ? Math.max(max, Number(matched[1])) : max
  }, 0)

  const errors = []
  const evidence = []
  const evaluations = []
  const seen = new Set()
  const at = isNonEmptyString(finishedAt) ? finishedAt : new Date().toISOString()

  for (const item of structured.criteria) {
    const id = item?.id
    if (typeof id !== 'string' || !knownIds.has(id)) {
      errors.push(`结果里的验收项 ${JSON.stringify(id)} 在凭证里不存在`)
      continue
    }
    if (!activeIds.has(id)) {
      errors.push(`结果里的验收项 ${id} 已被删除，不接受它的结论`)
      continue
    }
    if (seen.has(id)) {
      errors.push(`结果里的验收项 ${id} 出现了不止一次`)
      continue
    }
    seen.add(id)
    if (!STATUSES.includes(item?.status)) {
      errors.push(`${id} 的 status ${JSON.stringify(item?.status)} 不是五态之一`)
      continue
    }

    const evidenceIds = []
    for (const raw of Array.isArray(item.evidence) ? item.evidence : []) {
      seq += 1
      const entry = {
        evidenceId: `EV-${String(seq).padStart(4, '0')}`,
        criterionId: id,
        round,
        kind: raw?.kind,
        capturedAt: isNonEmptyString(raw?.capturedAt) ? raw.capturedAt : at,
        text: typeof raw?.text === 'string' ? raw.text : '',
        // `ref.type` 必须等于 `kind`（validateEvidence 会查）。类型由宿主统一，避免模型两边写得不一致。
        ref: { type: raw?.kind, locator: typeof raw?.locator === 'string' ? raw.locator : '' },
      }
      if (isNonEmptyString(raw?.excerpt)) entry.ref.excerpt = raw.excerpt
      if (Number.isInteger(raw?.exitCode)) entry.exitCode = raw.exitCode

      const check = validateEvidence(entry)
      if (!check.ok) {
        seq -= 1 // 没写进去就别浪费号码
        errors.push(...check.errors.map((message) => `${id} 的证据：${message}`))
        continue
      }
      evidence.push(entry)
      evidenceIds.push(entry.evidenceId)
    }

    if (item.status === 'pass' && evidenceIds.length === 0) {
      errors.push(`${id} 判为通过但一条可寻址的证据都没有`)
      continue
    }

    const steps = (Array.isArray(item.reproductionSteps) ? item.reproductionSteps : []).filter((step) =>
      isNonEmptyString(step),
    )
    if (item.status === 'fail' && steps.length === 0) {
      errors.push(`${id} 判为未通过但没写复现步骤 —— 没有复现步骤的 fail 没法返修`)
      continue
    }

    const evaluation = { criterionId: id, status: item.status, evidenceIds }
    if (steps.length > 0) evaluation.reproductionSteps = steps
    if (isNonEmptyString(item.note)) evaluation.note = item.note
    evaluations.push(evaluation)
  }

  // 漏项必须**显式可见**：既不沉默地留在旧状态，也绝不当成通过（L0 §10 第 2 条）。
  const covered = new Set(evaluations.map((evaluation) => evaluation.criterionId))
  for (const criterion of active) {
    if (covered.has(criterion.id)) continue
    evaluations.push({
      criterionId: criterion.id,
      status: 'unknown',
      evidenceIds: [],
      note: '委派结果里没有这一项的结论 —— 未验证，不是通过',
    })
  }

  return { round, evidence, evaluations, errors }
}
