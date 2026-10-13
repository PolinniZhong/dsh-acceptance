/**
 * 模型可调用工具层（SDD §14）—— 开发 Agent 主动登记需求、提交交付、取回结论。
 *
 * 三条纪律，全部来自已验证的真机形态（`10_DSH_Skill_Trace/src/dsh/host/index.js:771-840`）：
 *
 *  1. **身份只有一个来源：`exec.agent.session.id`。** 工具的 `parameters` 里**不许**出现
 *     `sessionId` / `workspace` / `cwd`（守卫 G14）—— 让模型自报身份等于把权限交给被验方。
 *  2. **失败一律回信封，不许抛**（守卫 G20）。模型该拿到一个能读的答案，而不是一次工具报错。
 *  3. **schema 必须整体落在宿主白名单内**（守卫 G12）。写错的后果不是构建失败，是重启 DSH
 *     真去调用那一刻才炸 —— 与 G9 同因。
 *
 * 本模块**不认识 HTTP**、也不认识 `ctx`：它只接依赖，回信封，便于 `node --test` 直接断言。
 *
 * @module dsh-acceptance/host/tools
 */

import {
  DEFAULT_ROUND_LIMIT,
  appendRound,
  createReceipt,
  delegationRoundKind,
  delegationRoundNumber,
  deriveCurrentStatuses,
  staleInLatestRound,
  summarizeCounts,
  validateReceipt,
} from './domain.js'
import { SAFE_TASK_ID } from './store.js'

export const BEGIN_TASK_TOOL = 'acceptance_begin_task'
export const SUBMIT_DELIVERY_TOOL = 'acceptance_submit_delivery'
export const GET_RESULT_TOOL = 'acceptance_get_result'
export const TOOL_NAMES = Object.freeze([BEGIN_TASK_TOOL, SUBMIT_DELIVERY_TOOL, GET_RESULT_TOOL])

/**
 * 宿主 `assertObjectJsonSchema` 的白名单（`@deepseek-ai/dsh-tools/lib/index.js`）。
 * 与守卫 G9/G12 用的是同一份 —— 多一个关键字 = 工具在真机上装不上。
 */
const ALLOWED_KEYS = Object.freeze([
  'type',
  'oneOf',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'description',
  'title',
  'default',
  'examples',
])

/** 工具 schema 只用白名单里的关键字（导出给守卫 G12 用，避免两处各写一份）。 */
export const SCHEMA_ALLOWED_KEYS = new Set(ALLOWED_KEYS)

const str = { type: 'string' }
const strArray = { type: 'array', items: { type: 'string' } }

/**
 * `acceptance_begin_task` 的参数。
 *
 * ⚠️ 没有 `sessionId` / `workspace` / `cwd`：身份与工作区都由宿主解析（§14.3）。
 */
const BEGIN_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['requirementText'],
  properties: {
    requirementText: {
      ...str,
      description: '用户最初提出的原始需求，**逐字照抄**，不要改写、不要摘要、不要补全。',
    },
    taskTitle: { ...str, description: '给这个任务起一个人能懂的名字，便于在验收台列表里辨认。' },
    criteria: {
      type: 'array',
      description: '初始验收契约。区分 original（来自原始需求）与 suggested（你自己补充的建议）。',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title'],
        properties: {
          title: { ...str, description: '一句话说清「要检查什么」。' },
          expected: { ...str, description: '通过条件。写不出可观察的通过条件就不要提这一条。' },
          origin: { type: 'string', enum: ['original', 'suggested'] },
          method: { type: 'string', enum: ['static', 'command', 'ui', 'manual'] },
          sourceQuote: { ...str, description: 'original 时写原始需求里的原句；suggested 时留空。' },
        },
      },
    },
  },
}

/** `acceptance_submit_delivery` 的参数。声明只是**线索**，验收 Agent 必须独立核查。 */
const SUBMIT_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['taskId'],
  properties: {
    taskId: { ...str, description: 'acceptance_begin_task 返回的 taskId。' },
    summary: { ...str, description: '这一轮做了什么。**这是声明，不是结论**，不会被当作验收证据。' },
    changedFiles: { ...strArray, description: '本轮的改动文件绝对路径。只是**定位信息**，不是版本指纹。' },
    commandsRun: {
      type: 'array',
      description: '你自己跑过的命令与结果。同样是声明，验收 Agent 会独立重跑或另行取证。',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['command'],
        properties: {
          command: { ...str, description: '命令原文（单行）。' },
          exitCode: { type: 'integer', description: '退出码。' },
        },
      },
    },
    remaining: { ...str, description: '仍未完成、或已知的限制。没做完就照实说。' },
  },
}

const GET_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['taskId'],
  properties: {
    taskId: { ...str, description: 'acceptance_begin_task 返回的 taskId。' },
  },
}

/**
 * `acceptance_begin_task` 的回执。
 *
 * ⚠️ **每个工具都必须有 `output: { schema, render }`** —— 真机 `register()` 第一件事就是校验它：
 *   `must declare output { schema, render, presentationMeta? }`（`dsh-tools/lib/index.js:2879`），
 * 缺一个就**当场抛**，而注册是在一个 `for` 循环里 —— 第一个工具抛了，**三个工具一个都装不上**。
 * 这条只有真机/真源码能证得出来，「本地看起来没问题」是必然的。
 */
const BEGIN_RESULT_SCHEMA = {
  type: 'object',
  // ⚠️ 这里**必须**是 true。真机会**强制**校验工具输出：`additionalProperties: false` 时，
  // 返回里多一个没声明的 key 就整次调用失败（`dsh-tools/lib/index.js:467-468`），
  // 而失败信息长成「工具输出校验失败」—— 模型只会告诉用户「验收台坏了」，看不出是我的 schema 少写了一行。
  // 2026-10-12 真机实测：`receiptId` 没声明 ⇒ `acceptance_begin_task` 连续两次调用全废。
  // 输出 schema 的价值是**给模型一个可读的形状**，不是当严格类型闸门；形状靠 properties 表达就够了。
  additionalProperties: true,
  required: ['ok'],
  properties: {
    ok: { type: 'boolean' },
    taskId: str,
    receiptId: str,
    reason: { ...str, description: '登记失败时的原因码。' },
    message: { ...str, description: '给人看的一句话。' },
    criteriaCount: { type: 'integer' },
    originalCount: { type: 'integer', description: '来自原始需求的验收项数。' },
    suggestedCount: { type: 'integer', description: '你补充建议的验收项数 —— 它们**不是**用户已确认的需求。' },
    nextStep: { ...str, description: '接下来谁做什么。照它做，不要跳过验收契约的确认。' },
  },
}

/** 把「登记需求」的回执渲染成人能读的一段话。 */
export function renderBeginResult(value) {
  if (!value || typeof value !== 'object') return '验收台没有返回可读的结果。'
  if (value.ok !== true) {
    return `验收台没有接受这次登记：${value.reason ?? 'unknown'} —— ${value.message ?? ''}`.trim()
  }
  return [
    `已登记任务 ${value.taskId}：验收项 ${value.criteriaCount ?? 0} 条` +
      `（原始需求 ${value.originalCount ?? 0} / 你的建议 ${value.suggestedCount ?? 0}）。`,
    value.nextStep ?? '',
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * 取回结论的信封（`output.schema`）。刻意复用 `buildVerifySchema` 的窄关键字写法：
 * **逐条**列五态，不给模型一个「总体通过」的字段可写。
 */
const RESULT_SCHEMA = {
  type: 'object',
  // 同 BEGIN 的理由：真机强制校验，多一个未声明的 key 就整次调用失败。
  additionalProperties: true,
  required: ['ok'],
  properties: {
    ok: { type: 'boolean' },
    taskId: str,
    reason: { ...str, description: '取不到时的原因码（no-such-task 等）。' },
    round: { type: 'integer', description: '当前轮次号；还没有轮次时为 0。' },
    roundLimit: { type: 'integer', description: '自动返修上限。到这个数就必须停下来等人决定。' },
    humanDecisionRequired: { type: 'boolean' },
    decision: {
      type: 'string',
      enum: ['accept', 'fix', 'defer', 'none'],
      description: '人类已经做出的决定。**你有没有取到过它，都不改变它只由人产生这件事。**',
    },
    blockedReason: {
      type: 'string',
      description: '最近一轮被环境/能力挡住的原因。它**不是**代码缺陷。',
    },
    unconfirmedIds: {
      type: 'array',
      items: { type: 'string' },
      description: '还没被用户确认的验收项 —— 未确认的范围不是契约，不会被取证。',
    },
    skippedUnconfirmed: {
      type: 'array',
      items: { type: 'string' },
      description: '最近一轮取证**跳过了哪些未确认项**（空数组 = 一项都没跳）。',
    },
    message: { ...str, description: '给人看的一句话。' },
    runStatus: {
      type: 'string',
      enum: ['not_started', 'running', 'succeeded', 'failed', 'timed_out', 'invalid_output'],
      description: '这一次取证**跑成没有** —— 与验收项结论是两回事。',
    },
    counts: {
      type: 'object',
      additionalProperties: true,
      description: '五态各计数。**它是记录，不是分数**，不折算、不参与任何判断。',
      properties: {
        pending: { type: 'integer' },
        pass: { type: 'integer' },
        fail: { type: 'integer' },
        unknown: { type: 'integer' },
        blocked: { type: 'integer' },
      },
    },
    criteria: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: true,
        required: ['criterionId', 'status'],
        properties: {
          criterionId: str,
          status: { type: 'string', enum: ['pending', 'pass', 'fail', 'unknown', 'blocked'] },
          stale: { type: 'boolean', description: '为真表示最近一轮没有复查这一项 —— 不许当成刚刚通过。' },
          evidenceIds: strArray,
          reproductionSteps: strArray,
          unverifiedReason: { ...str, description: 'unknown / blocked 时，缺的是什么证据或要先解哪个障碍。' },
          evidence: { type: 'array', items: { type: 'object', additionalProperties: true }, description: '带定位符的原始证据。' },
        },
      },
    },
  },
}

/**
 * 造三个工具。
 *
 * @param {object} deps
 * @param {{read: Function, write: Function}} deps.store
 * @param {(input: object) => Promise<object>} deps.runVerification      共享的委派执行体（§14.1）
 * @param {(sessionId: string) => object} [deps.resolveChangedFiles]
 * @param {(line: string) => void} [deps.warn]
 */
export function buildAcceptanceTools({ store, runVerification, resolveChangedFiles, warn = () => {} }) {
  /** 信封：**永远**是返回值，不是异常（§14.5）。 */
  const envelope = (body) => ({ ok: false, ...body })

  /** 从工具执行上下文里取权威身份。取不到就照实说，不猜。 */
  const sessionIdOf = (exec) => {
    const id = exec?.agent?.session?.id
    return typeof id === 'string' && id !== '' ? id : null
  }

  const requireTaskId = (args) => {
    const raw = typeof args?.taskId === 'string' ? args.taskId.trim() : ''
    // 非法格式要在**进 store 之前**拦下：store 会直接抛，而抛出去就变成 `internal-error`，
    // 把「模型传了个坏 id」说成「我们挂了」—— 真出故障时就分不清是哪一种。
    if (raw === '') return { error: envelope({ reason: 'invalid-task-id', message: 'taskId 不能为空。' }) }
    if (!SAFE_TASK_ID.test(raw)) {
      return {
        error: envelope({
          taskId: raw,
          reason: 'invalid-task-id',
          message: `taskId ${JSON.stringify(raw)} 不合法：只允许字母数字开头、由 [A-Za-z0-9._-] 组成、长度 ≤128。`,
        }),
      }
    }
    return { taskId: raw }
  }

  const taskView = async (taskId, { withEvidence = false } = {}) => {
    const receipt = await store.read(taskId)
    if (!receipt) {
      return envelope({
        taskId,
        reason: 'no-such-task',
        message: `没有任务 ${taskId}。`,
        criteria: [],
        humanDecisionRequired: false,
        roundLimit: DEFAULT_ROUND_LIMIT,
      })
    }
    const statuses = deriveCurrentStatuses(receipt)
    const stale = staleInLatestRound(receipt)
    const counts = summarizeCounts(receipt)
    const lastRound = receipt.rounds?.[receipt.rounds.length - 1] ?? null
    const active = (receipt.criteria ?? []).filter((criterion) => criterion && !criterion.deletedAt)
    const evidenceById = new Map((receipt.evidence ?? []).map((entry) => [entry.evidenceId, entry]))
    const evaluationsById = new Map(
      (lastRound?.evaluations ?? []).map((evaluation) => [evaluation.criterionId, evaluation]),
    )

    const criteria = active.map((criterion) => {
      const evaluation = evaluationsById.get(criterion.id)
      const item = {
        criterionId: criterion.id,
        status: statuses[criterion.id] ?? 'pending',
        stale: stale.has(criterion.id),
        evidenceIds: evaluation?.evidenceIds ?? [],
        reproductionSteps: evaluation?.reproductionSteps ?? [],
      }
      // unknown / blocked 要写清「缺什么证据 / 先解哪个障碍」；fail 要带复现步骤。
      if (typeof evaluation?.unverifiedReason === 'string' && evaluation.unverifiedReason !== '') {
        item.unverifiedReason = evaluation.unverifiedReason
      }
      if (withEvidence && item.evidenceIds.length > 0) {
        item.evidence = item.evidenceIds.map((id) => evidenceById.get(id)).filter(Boolean)
      }
      return item
    })

    const round = receipt.rounds?.length ?? 0
    // P0-3：把「跳过/待确认」说清楚 —— 调用方（开发 Agent）与界面读的是同一份事实。
    const unconfirmedIds = active.filter((criterion) => !criterion.confirmedByUserAt).map((criterion) => criterion.id)
    const lastSkipped = Array.isArray(lastRound?.provenance?.skippedUnconfirmed)
      ? lastRound.provenance.skippedUnconfirmed
      : []
    return {
      ok: true,
      taskId,
      unconfirmedIds,
      skippedUnconfirmed: lastSkipped,
      round,
      roundLimit: DEFAULT_ROUND_LIMIT,
      // 轮次到了上限、或最近一轮被阻塞 ⇒ 闭环停下，等人决定（§16.2）。
      humanDecisionRequired: receipt.decision !== null || round >= DEFAULT_ROUND_LIMIT || lastRound?.blockedReason != null,
      decision: receipt.decision?.value ?? 'none',
      blockedReason: lastRound?.blockedReason ?? '',
      criteria,
      counts,
    }
  }

  return [
    {
      name: BEGIN_TASK_TOOL,
      description:
        '登记一条原始需求与初始验收契约。**在动手实现之前**调用。' +
        '原始需求必须逐字照抄用户说过的话：你可以补充建议验收项并标 origin=suggested，' +
        '但不得改写、摘要或降低用户的要求。返回的 taskId 之后要用在 acceptance_submit_delivery 上。',
      parameters: BEGIN_PARAMETERS,
      output: { schema: BEGIN_RESULT_SCHEMA, render: (_args, value) => [{ type: 'text', text: renderBeginResult(value) }] },
      async execute(args, exec) {
        const sessionId = sessionIdOf(exec)
        if (sessionId === null) return envelope({ reason: 'no-agent', message: '当前不是 Agent 会话调用 —— 无法确定身份，拒绝登记。' })
        const requirementText = typeof args?.requirementText === 'string' ? args.requirementText : ''
        if (requirementText.trim() === '') {
          return envelope({ reason: 'invalid-requirement', message: 'requirementText 不能为空：没有原始需求就没有验收契约。' })
        }
        try {
          const taskId = `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
          const changed = resolveChangedFiles ? resolveChangedFiles(sessionId) : { files: [], source: 'no-session' }
          let receipt = createReceipt({
            taskId,
            taskTitle: typeof args?.taskTitle === 'string' ? args.taskTitle : '',
            requirementText,
            scope: { changedFiles: changed.files, changedFilesSource: changed.source },
          })

          // 验收项一律**未确认**（`confirmedByUserAt: null`）：Agent 只能提议，确认权在用户（SDD §2.2）。
          const proposed = Array.isArray(args?.criteria) ? args.criteria : []
          const criteria = []
          let seq = 0
          for (const item of proposed) {
            const title = typeof item?.title === 'string' ? item.title.trim() : ''
            if (title === '') continue
            seq += 1
            criteria.push({
              id: `AC-${String(seq).padStart(2, '0')}`,
              origin: item?.origin === 'suggested' ? 'suggested' : 'original',
              sourceQuote: typeof item?.sourceQuote === 'string' ? item.sourceQuote : '',
              title,
              precondition: '',
              steps: [],
              expected: typeof item?.expected === 'string' ? item.expected : '',
              method: ['static', 'command', 'ui', 'manual'].includes(item?.method) ? item.method : 'manual',
              confirmedByUserAt: null,
              deletedAt: null,
            })
          }
          receipt = { ...receipt, criteria, updatedAt: new Date().toISOString() }
          const check = validateReceipt(receipt)
          if (!check.ok) return envelope({ taskId, reason: 'invalid-receipt', message: check.errors.join(' / ') })
          await store.write(receipt)
          return {
            ok: true,
            taskId,
            receiptId: receipt.receiptId,
            criteriaCount: criteria.length,
            originalCount: criteria.filter((criterion) => criterion.origin === 'original').length,
            suggestedCount: criteria.filter((criterion) => criterion.origin === 'suggested').length,
            // 说清楚「接下来谁做什么」—— 工具返回值就是开发 Agent 的下一步指令。
            nextStep:
              criteria.length === 0
                ? '还没有验收项：请在验收台里与用户一起确认验收契约，然后再提交交付。'
                : '验收项已登记但**尚未由用户确认**：请先请用户在验收台确认，再实现并提交交付。',
          }
        } catch (caught) {
          warn(`[dsh-acceptance] ${BEGIN_TASK_TOOL} 失败：${caught?.stack ?? caught}`)
          return envelope({ reason: 'internal-error', message: String(caught?.message ?? caught) })
        }
      },
    },

    {
      name: SUBMIT_DELIVERY_TOOL,
      description:
        '提交本轮交付并**触发一次独立的验收取证**。做完一轮工作后调用。' +
        '你填的 summary / commandsRun 只是**声明**：验收 Agent 会独立检查真实工作区，不会照抄你的结论。' +
        '返回里逐条给出每个验收项的状态、证据与还需要你做什么。',
      parameters: SUBMIT_PARAMETERS,
      output: { schema: RESULT_SCHEMA, render: (_args, value) => [{ type: 'text', text: renderResult(value) }] },
      async execute(args, exec) {
        const sessionId = sessionIdOf(exec)
        if (sessionId === null) {
          return envelope({ reason: 'no-agent', message: '当前不是 Agent 会话调用 —— 无法确定身份，拒绝提交。' })
        }
        const looked = requireTaskId(args)
        if (looked.error) return looked.error
        const taskId = looked.taskId

        try {
          const receipt = await store.read(taskId)
          if (!receipt) return envelope({ taskId, reason: 'no-such-task', message: `没有任务 ${taskId}。` })

          const active = (receipt.criteria ?? []).filter((criterion) => criterion && !criterion.deletedAt)
          const confirmedActive = active.filter((criterion) => Boolean(criterion.confirmedByUserAt))
          const unconfirmed = active.filter((criterion) => !criterion.confirmedByUserAt)
          // P0-3（2026-10-12）：**与 UI 路径（`verification.js`）同一条规则。**
          // 修之前这里对「有未确认项」一律硬挡 —— 而 UI 路径照常验证，「一条路拒、一条路放」。
          // 统一后：**一条 confirmed 都没有才拒**（没有可验的契约，委派没有意义）；
          // 有 confirmed 的项就照常取证，未确认项**跳过并说明**（绝不静默变通过）。
          if (active.length === 0 || confirmedActive.length === 0) {
            // 未确认的验收范围不是契约（PRD §4 第 2 步不可跳过）。**不**替用户确认。
            return envelope({
              taskId,
              reason: 'criteria-not-confirmed',
              message:
                active.length === 0
                  ? '这个任务还没有验收项 —— 先在验收台与用户确认验收契约。'
                  : `这个任务的 ${active.length} 条验收项都还没由用户确认（${unconfirmed.map((criterion) => criterion.id).join(', ')}）—— 未确认的范围不是契约，不发起取证。`,
            })
          }

          // 交付声明落一条**注释性**记录：它不是结论，也不产生验收项状态。
          const declaredAt = new Date().toISOString()
          const declaration = {
            round: delegationRoundNumber(receipt),
            kind: delegationRoundKind(receipt),
            summary: typeof args?.summary === 'string' ? args.summary : '',
            changedFiles: Array.isArray(args?.changedFiles)
              ? args.changedFiles.filter((path) => typeof path === 'string')
              : [],
            commandsRun: Array.isArray(args?.commandsRun)
              ? args.commandsRun
                  .filter((entry) => entry && typeof entry.command === 'string')
                  .map((entry) => ({
                    command: entry.command,
                    exitCode: Number.isInteger(entry.exitCode) ? entry.exitCode : null,
                  }))
              : [],
            remaining: typeof args?.remaining === 'string' ? args.remaining : '',
            declaredAt,
            declaredBy: 'agent',
          }
          const withDeclaration = {
            ...receipt,
            deliveryDeclarations: [...(receipt.deliveryDeclarations ?? []), declaration],
            updatedAt: declaredAt,
          }
          await store.write(withDeclaration)

          const outcome = await runVerification({ taskId, parent: exec?.agent, parentSessionId: sessionId })

          if (outcome.outcome === 'error') {
            return envelope({ taskId, reason: outcome.reasonCode, message: outcome.message })
          }
          const view = await taskView(taskId)
          if (outcome.outcome === 'blocked') {
            return {
              ...view,
              ok: false,
              reason: 'blocked-round',
              message: `${outcome.message}（已记一轮阻塞轮次）`,
              runStatus: 'failed',
            }
          }
          const skipped = Array.isArray(view.skippedUnconfirmed) ? view.skippedUnconfirmed : []
          return {
            ...view,
            runStatus: 'succeeded',
            message:
              `第 ${outcome.round} 轮取证已完成。` +
              (skipped.length > 0
                ? `未确认的验收项已跳过、未取证：${skipped.join(', ')} —— 它们仍是「待验收」，不是通过。`
                : ''),
          }
        } catch (caught) {
          warn(`[dsh-acceptance] ${SUBMIT_DELIVERY_TOOL} 失败：${caught?.stack ?? caught}`)
          return envelope({ taskId, reason: 'internal-error', message: String(caught?.message ?? caught) })
        }
      },
    },

    {
      name: GET_RESULT_TOOL,
      description:
        '取回某个验收任务最近一轮的结论：逐条状态、证据编号、复现步骤、还缺什么证据，以及是否已经轮到你。' +
        '**只读，不产生轮次**。人类是否接受交付**只由人决定**，你不可以代替。',
      parameters: GET_PARAMETERS,
      output: { schema: RESULT_SCHEMA, render: (_args, value) => [{ type: 'text', text: renderResult(value) }] },
      async execute(args, exec) {
        const sessionId = sessionIdOf(exec)
        if (sessionId === null) return envelope({ reason: 'no-agent', message: '当前不是 Agent 会话调用。' })
        const looked = requireTaskId(args)
        if (looked.error) return looked.error
        const taskId = looked.taskId
        try {
          return await taskView(taskId, { withEvidence: false })
        } catch (caught) {
          warn(`[dsh-acceptance] ${GET_RESULT_TOOL} 失败：${caught?.stack ?? caught}`)
          return envelope({ taskId, reason: 'internal-error', message: String(caught?.message ?? caught) })
        }
      },
    },
  ]
}

/** 把结论信封渲染成人能读的一段话（模型读它也读得懂，因为每条都带「谁该做什么」）。 */
export function renderResult(value) {
  if (!value || typeof value !== 'object') return '验收台没有返回可读的结果。'
  if (value.ok !== true) {
    return `验收台没有接受这次调用：${value.reason ?? 'unknown'} —— ${value.message ?? ''}`.trim()
  }
  const lines = [`任务 ${value.taskId} 第 ${value.round}/${value.roundLimit} 轮。`]
  if (typeof value.blockedReason === 'string' && value.blockedReason !== '') {
    lines.push(`最近一轮被环境/能力挡住（**不是代码缺陷**）：${value.blockedReason}`)
  }
  for (const item of value.criteria ?? []) {
    const stale = item.stale ? '（本轮未复查，不得当作刚通过）' : ''
    const evidence = item.evidenceIds?.length ? ` 证据 ${item.evidenceIds.join(', ')}` : ' 无证据'
    lines.push(`- ${item.criterionId} ${item.status}${stale}${evidence}`)
    if (item.unverifiedReason) lines.push(`    缺什么：${item.unverifiedReason}`)
    for (const step of item.reproductionSteps ?? []) lines.push(`    复现：${step}`)
  }
  if (value.humanDecisionRequired) lines.push('现在轮到**人**做最终决定（接受 / 要求修复 / 暂缓）。你不可以代替。')
  return lines.join('\n')
}
