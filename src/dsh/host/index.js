/**
 * Agent 交付验收台 —— host 半入口（SDD §1.3、§9）。
 *
 * 路由机制 = `ctx.connection.fetch.register`（S5 定稿，决策 D-015）。四条硬约束：
 *  1. path 必须在 `/api` 之下；
 *  2. **精确匹配不是前缀** ⇒ 参数一律走 query，路径参数不工作；
 *  3. **同一 path 只能注册一次** ⇒ 多方法写成一个 `methods` 数组、在 handler 内按 `request.method` 分派；
 *  4. 方法只有 `GET | HEAD | POST`，**没有 `PUT`**。
 *
 * @module dsh-acceptance
 */

import { readFileSync } from 'node:fs'

import {
  PRODUCERS,
  SCHEMA_VERSION,
  STATUS_LABELS,
  STATUSES,
  appendRound,
  buildAcceptancePackage,
  buildDelegationPrompt,
  buildMarkdownExport,
  buildVerifySchema,
  createReceipt,
  delegationRoundKind,
  delegationRoundNumber,
  deriveCurrentStatuses,
  nextCriterionId,
  normalizeDelegatedResult,
  staleInLatestRound,
  summarizeCounts,
  validateEvidence,
  validateReceipt,
} from './domain.js'
import { ReceiptStore, defaultRoot } from './store.js'

export const name = 'dsh-acceptance'

const JSON_HEADERS = Object.freeze({
  'content-type': 'application/json; charset=utf-8',
  // 凭证是「用户此刻看到的东西」，任何一层缓存都会让过期标注说谎。
  'cache-control': 'no-store',
})

function sendJson(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS })
}

function sendText(body, status = 200, contentType = 'text/plain; charset=utf-8') {
  return new Response(body, { status, headers: { 'content-type': contentType, 'cache-control': 'no-store' } })
}

/** 读请求体；非法 JSON **报错**，不当成空对象。 */
async function readJson(request) {
  const raw = await request.text()
  if (raw.trim().length === 0) return {}
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('请求体必须是 JSON 对象')
    }
    return parsed
  } catch (error) {
    throw Object.assign(new Error(`请求体不是合法 JSON：${error.message}`), { statusCode: 400 })
  }
}

function requireString(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw Object.assign(new Error(`${field} 不能为空`), { statusCode: 400 })
  }
  return value
}

/**
 * 版本号**只有一个真源：本包的 `package.json`**（2026-10-11 修）。
 *
 * 原先这里写死 `'0.1.0'`，而 `package.json` 是另一处 —— 两处各说各话，健康路由报的是这里，
 * 于是「包里 0.1.1、界面说 0.1.0」会静默发生，而且只有一条把字面量钉死的测试挡着（踩过的坑 P-021）。
 * 读不到就报 `未知`，不编一个看起来合理的版本号。
 */
function readPackageVersion() {
  try {
    return JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')).version
  } catch {
    return '未知'
  }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ dataRoot?: string }} [config]
 */
export function apply(ctx, config = {}) {
  const root =
    typeof config.dataRoot === 'string' && config.dataRoot.trim().length > 0 ? config.dataRoot.trim() : defaultRoot()
  const store = new ReceiptStore(root)
  const startedAt = Date.now()
  const packageVersion = readPackageVersion()

  // `workspaceChanges` 用**作用域注入**：写进下面的必填数组会让整个 fiber 在该服务缺席时
  // **不激活** —— 插件全灭，而不是少一个功能（SDD §1.3、决策 D-016）。
  let workspaceChanges = null
  ctx.inject(['workspaceChanges'], (scoped) => {
    workspaceChanges = scoped.workspaceChanges
  })

  // 同理：`subagents`（模式 A 的委派运行时）与 `agents`（把 sessionId 解析成活着的父 Agent）
  // 也走**作用域注入**。写进必填数组的话，少了任一个服务整个插件就不激活 ——
  // 代价是「模式 A 不可用」，而不是「验收台全灭」（SDD §1.3、决策 D-016）。
  let subagents = null
  let agents = null
  ctx.inject(['subagents'], (scoped) => {
    subagents = scoped.subagents
  })
  ctx.inject(['agents'], (scoped) => {
    agents = scoped.agents
  })

  ctx.inject(['connection', 'sessions'], (scoped) => {
    const deps = {
      store,
      root,
      startedAt,
      packageVersion,
      sessions: scoped.sessions,
      workspaceChanges: () => workspaceChanges,
      subagents: () => subagents,
      agents: () => agents,
    }

    /**
     * 解析本轮变更范围（S5 §3）。
     *
     * ⚠️ 三条硬限制决定了这里**只能**返回三种不同的「空」：
     *  - `no-turn-recorded`  —— 父会话里根本没有 `workspace/changes` 事件；
     *  - `summary-unavailable` —— 有事件但宿主重启过/会话已销毁，摘要在内存里没落盘；
     *  - `workspace-changes` 且 `files: []` —— 确实没改，或无 git 仓库时 bash 改动不录。
     * 界面必须把这三句说成不同的话（L0 §10 第 10 条）。
     */
    const resolveChangedFiles = (sessionId) => {
      const empty = (source) => ({ files: [], source })
      if (!sessionId) return empty('no-session')
      const session = deps.sessions?.get?.(sessionId)
      if (!session) return empty('no-session')
      const events = Array.isArray(session.events)
        ? session.events
        : typeof session.snapshotEvents === 'function'
          ? session.snapshotEvents()
          : []
      let latest = null
      for (const event of events) {
        if (event?.type === 'workspace/changes') latest = event
      }
      if (!latest) return empty('no-turn-recorded')
      const service = deps.workspaceChanges()
      if (!service?.summary) return empty('summary-unavailable')
      const summary = service.summary(sessionId, latest.seq)
      if (!summary) return empty('summary-unavailable')
      return {
        files: (summary.files ?? []).map((file) => file?.path).filter((path) => typeof path === 'string'),
        source: 'workspace-changes',
      }
    }

    const route = (path, methods, handler) => {
      scoped.connection.fetch.register({
        path,
        methods,
        requestBody: 'buffered',
        fetch: async (request) => {
          try {
            return await handler(request, new URL(request.url).searchParams)
          } catch (error) {
            const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500
            ctx.logger?.warn?.(`[dsh-acceptance] ${path} 失败：${error?.stack ?? error}`)
            return sendJson({ ok: false, error: String(error?.message ?? error) }, status)
          }
        },
      })
    }

    // --- 存活 + 版本（状态格真源） ------------------------------------------
    route('/api/acceptance.health', ['GET'], () =>
      sendJson({
        ok: true,
        plugin: 'dsh-acceptance',
        version: deps.packageVersion,
        schemaVersion: SCHEMA_VERSION,
        statuses: STATUSES,
        statusLabels: STATUS_LABELS,
        producers: PRODUCERS,
        dataRoot: root,
        uptimeMs: Date.now() - startedAt,
        // 界面要在**动作之前**说清「现在有没有委派能力」（v0.1.2 §5.4）—— 在此之前客户端只能等点击后
        // 由宿主用 4xx 拒绝。判据就是宿主自己那一件事：`subagents` 服务在不在。
        // ⚠️ 它**不是保证**：服务在，也可能因为没有活着的会话 Agent / provider 不存在而在承诺点之前 4xx。
        // 所以取值只有 true / false，字段名也别起成 `canDelegate` 那种承诺式的。
        capabilities: { delegate: subagents !== null && subagents !== undefined },
      }),
    )

    // --- 任务列表 / 建任务 --------------------------------------------------
    route('/api/acceptance.tasks', ['GET', 'POST'], async (request, query) => {
      if (request.method === 'GET') {
        const { tasks, broken } = await store.list()
        return sendJson({ ok: true, tasks, broken })
      }
      const body = await readJson(request)
      const requirementText = requireString(body.requirementText, 'requirementText')
      const taskId = requireString(body.taskId ?? `task-${Date.now().toString(36)}`, 'taskId')
      if (await store.read(taskId)) {
        return sendJson({ ok: false, error: `任务 ${taskId} 已存在` }, 409)
      }
      const changed = resolveChangedFiles(query.get('sessionId'))
      const receipt = createReceipt({
        taskId,
        taskTitle: typeof body.taskTitle === 'string' ? body.taskTitle : '',
        requirementText,
        scope: {
          ...(body.scope ?? {}),
          changedFiles: changed.files,
          changedFilesSource: changed.source,
        },
      })
      await store.write(receipt)
      return sendJson({ ok: true, receipt })
    })

    // --- 读凭证（含派生状态，客户端零判定） ---------------------------------
    route('/api/acceptance.receipt', ['GET'], async (_request, query) => {
      const taskId = requireString(query.get('taskId'), 'taskId')
      const receipt = await store.read(taskId)
      if (!receipt) return sendJson({ ok: false, error: `没有任务 ${taskId}` }, 404)
      return sendJson({
        ok: true,
        receipt,
        derived: {
          statuses: deriveCurrentStatuses(receipt),
          stale: [...staleInLatestRound(receipt)],
          counts: summarizeCounts(receipt),
        },
      })
    })

    // --- 确认 / 新增 / 删除验收项 -------------------------------------------
    route('/api/acceptance.criteria', ['POST'], async (request) => {
      const body = await readJson(request)
      const taskId = requireString(body.taskId, 'taskId')
      const receipt = await store.read(taskId)
      if (!receipt) return sendJson({ ok: false, error: `没有任务 ${taskId}` }, 404)
      const ops = Array.isArray(body.ops) ? body.ops : []
      if (ops.length === 0) return sendJson({ ok: false, error: 'ops 不能为空' }, 400)

      const now = new Date().toISOString()
      const criteria = [...receipt.criteria]
      const errors = []

      for (const op of ops) {
        if (op?.op === 'add') {
          const item = op.criterion ?? {}
          const id = nextCriterionId(criteria) // 单调递增，永不复用已删除的 id（守卫 G8）
          criteria.push({
            id,
            origin: item.origin === 'suggested' ? 'suggested' : 'original',
            sourceQuote: typeof item.sourceQuote === 'string' ? item.sourceQuote : '',
            title: requireString(item.title, 'criterion.title'),
            precondition: item.precondition ?? '',
            steps: Array.isArray(item.steps) ? item.steps : [],
            expected: item.expected ?? '',
            method: ['static', 'command', 'ui', 'manual'].includes(item.method) ? item.method : 'manual',
            confirmedByUserAt: null,
            deletedAt: null,
          })
        } else if (op?.op === 'confirm') {
          const target = criteria.find((item) => item.id === op.id)
          if (!target) errors.push(`没有验收项 ${op.id}`)
          else if (target.confirmedByUserAt) errors.push(`${op.id} 已确认过`)
          // 确认**只写时间戳**：确认过的定义不许原地改，要改只能删了重建（SDD §2.2）。
          else target.confirmedByUserAt = now
        } else if (op?.op === 'delete') {
          const target = criteria.find((item) => item.id === op.id)
          if (!target) errors.push(`没有验收项 ${op.id}`)
          else target.deletedAt = now
        } else {
          errors.push(`未知操作 ${JSON.stringify(op?.op)}`)
        }
      }

      if (errors.length > 0) return sendJson({ ok: false, errors }, 400)
      const updated = { ...receipt, criteria, updatedAt: now }
      await store.write(updated)
      return sendJson({ ok: true, receipt: updated })
    })

    // --- 模式 A：委派子 Agent 取证（SDD §5） ---------------------------------
    //
    // 失败分两类，判据是**是否已经承诺要委派**（即是否已经走过 `runtime.start()` 那一行）：
    //  - **承诺之前**（没有 subagents 服务 / 会话没有活着的 Agent / provider 不存在 / 没有验收项）
    //    ⇒ 4xx。用户就在屏幕前，当场告诉他就够了，不该在凭证里留一条无意义的轮次。
    //  - **承诺之后**（启动失败 / 执行失败 / 超时 / 没返回结构化结果 / 结果不合法）
    //    ⇒ **写一轮 `blocked`**，`producedBy: 'agent'`。这一轮是「一次真的发生过的委派取证」的记录，
    //      用户下次打开凭证能看到「试过、卡在哪」。转瞬即逝的错误提示做不到这件事（SDD §5.5）。
    route('/api/acceptance.verify', ['POST'], async (request, query) => {
      const body = await readJson(request)
      const taskId = requireString(body.taskId ?? query.get('taskId'), 'taskId')
      const receipt = await store.read(taskId)
      if (!receipt) return sendJson({ ok: false, error: `没有任务 ${taskId}` }, 404)

      const active = (receipt.criteria ?? []).filter((criterion) => criterion && !criterion.deletedAt)
      if (active.length === 0) {
        return sendJson({ ok: false, error: '这个任务还没有验收项 —— 先确认验收项，再委派取证' }, 400)
      }

      const sessionId = requireString(body.sessionId ?? query.get('sessionId'), 'sessionId')

      const runtime = deps.subagents()
      if (!runtime?.start) {
        return sendJson({ ok: false, error: '宿主没有 subagents 服务 —— 模式 A 不可用，请走模式 B（验收包 → 导入）' }, 400)
      }

      // 路由处理器没有工具层的 `exec.agent`，只能按 sessionId 去 AgentRegistry 里查**活着的**那个。
      // 宿主重启后内存里的 Agent 就没了 ⇒ 这里必须给出可照做的下一步，而不是一句「失败了」。
      const parent = deps.agents()?.get?.(sessionId)
      if (!parent) {
        return sendJson(
          {
            ok: false,
            error: `会话 ${sessionId} 没有活着的 Agent —— 宿主重启后需要先恢复该会话；或改走模式 B（验收包 → 导入）`,
          },
          409,
        )
      }

      const provider = typeof body.provider === 'string' && body.provider.trim() ? body.provider.trim() : 'spawn'
      if (typeof runtime.list === 'function' && !runtime.list().includes(provider)) {
        const available = (runtime.list() ?? []).join(', ') || '无'
        return sendJson({ ok: false, error: `宿主没有名为 ${provider} 的委派 provider（现有：${available}）` }, 400)
      }

      /** 写一轮 blocked。**不解析 `output` 自由文本** —— 从自然语言里猜结论会把「未验证」污染成「通过」。 */
      const writeBlockedRound = async (reason, provenance) => {
        const now = new Date().toISOString()
        const appended = appendRound(receipt, {
          round: delegationRoundNumber(receipt),
          kind: delegationRoundKind(receipt),
          startedAt: now,
          finishedAt: now,
          producedBy: 'agent',
          provenance: provenance ?? null,
          blockedReason: reason,
          evaluations: [],
        })
        if (appended.errors.length > 0) return sendJson({ ok: false, errors: appended.errors }, 400)
        await store.write(appended.receipt)
        return sendJson({ ok: true, blocked: true, reason, receipt: appended.receipt })
      }

      const disposeQuietly = async (run) => {
        try {
          await run?.dispose?.()
        } catch {
          // 清理失败不该盖掉已经拿到的结论
        }
      }

      const timeoutMs = Number.isInteger(body.timeoutMs) && body.timeoutMs > 0 ? body.timeoutMs : 600000
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(new Error('验收超时')), timeoutMs)
      const startedAt = new Date().toISOString()

      // ---- 承诺点：这一行之后的一切失败都写 blocked 轮次，不再返回 4xx ----
      let run
      try {
        run = await runtime.start(provider, {
          label: `验收 ${taskId}`,
          prompt: [{ type: 'text', text: buildDelegationPrompt(receipt) }],
          parent,
          signal: controller.signal,
          outputSchema: buildVerifySchema(receipt.criteria),
          agentOptions:
            Number.isInteger(body.maxTokens) && body.maxTokens > 0 ? { maxTokens: body.maxTokens } : undefined,
        })
      } catch (error) {
        clearTimeout(timer)
        return writeBlockedRound(`委派启动失败：${String(error?.message ?? error)}`, { provider, phase: 'start' })
      }

      let result
      try {
        result = await run.result
      } catch (error) {
        clearTimeout(timer)
        await disposeQuietly(run)
        return writeBlockedRound(`委派执行失败：${String(error?.message ?? error)}`, { provider, phase: 'run' })
      }
      clearTimeout(timer)
      await disposeQuietly(run)

      const finishedAt = new Date().toISOString()
      const provenance = {
        provider,
        runId: run?.id ?? null,
        stopReason: result?.stopReason ?? null,
        parentSessionId: sessionId,
        diagnostic: result?.diagnostic ?? null,
        // 版本指纹首版**恒 null**（L0 §10 第 9 条、S5）：拿不到就写 null = 「版本未知」，
        // 不许用变更文件列表派生哈希冒充。
        fingerprint: null,
      }

      if (result?.structured === undefined) {
        // SDD §5.2 第 2 步：**不去解析 `output` 文本**。
        return writeBlockedRound(
          `委派没有返回结构化结果（stopReason=${String(result?.stopReason)}）—— 不解析自由文本，这一轮记为被阻塞`,
          provenance,
        )
      }

      const normalized = normalizeDelegatedResult(receipt, result.structured, { startedAt, finishedAt })
      if (normalized.errors.length > 0) {
        // 子 Agent 给了结果但不合契约 ⇒ 仍然写 blocked，把逐条错误原样写进 blockedReason。
        // **不部分写入**（SDD §5.2 第 3 步），也不丢掉「真的跑过一次」这个事实。
        return writeBlockedRound(
          `委派结果不合法，一条结论都没写入：\n- ${normalized.errors.join('\n- ')}`,
          provenance,
        )
      }

      const merged = { ...receipt, evidence: [...receipt.evidence, ...normalized.evidence], updatedAt: finishedAt }
      const appended = appendRound(merged, {
        round: normalized.round,
        kind: delegationRoundKind(receipt),
        startedAt,
        finishedAt,
        producedBy: 'agent',
        provenance,
        blockedReason: null,
        evaluations: normalized.evaluations,
      })
      if (appended.errors.length > 0) return sendJson({ ok: false, errors: appended.errors }, 400)

      const check = validateReceipt(appended.receipt)
      if (!check.ok) return sendJson({ ok: false, errors: check.errors }, 400)

      await store.write(appended.receipt)
      return sendJson({ ok: true, receipt: appended.receipt })
    })

    // --- 模式 B：生成验收包 --------------------------------------------------
    route('/api/acceptance.package', ['POST'], async (request) => {
      const body = await readJson(request)
      const taskId = requireString(body.taskId, 'taskId')
      const receipt = await store.read(taskId)
      if (!receipt) return sendJson({ ok: false, error: `没有任务 ${taskId}` }, 404)
      return sendText(buildAcceptancePackage(receipt), 200, 'text/markdown; charset=utf-8')
    })

    // --- 模式 B：导入结构化结果，追加一轮 ------------------------------------
    route('/api/acceptance.import', ['POST'], async (request) => {
      const body = await readJson(request)
      const taskId = requireString(body.taskId, 'taskId')
      const receipt = await store.read(taskId)
      if (!receipt) return sendJson({ ok: false, error: `没有任务 ${taskId}` }, 404)

      // payload 允许两种形态：结构化对象，或用户从聊天里粘过来的一整段 JSON 文本。
      // 后者解析失败是**客户端错误**，不能因为 `JSON.parse` 裸抛而被记成 500（服务端故障），
      // 否则真出故障时就分不清「用户贴错了」和「我们挂了」。
      let draft
      if (typeof body.payload === 'string') {
        try {
          draft = JSON.parse(body.payload)
        } catch (error) {
          throw Object.assign(new Error(`payload 不是合法 JSON：${error.message}`), { statusCode: 400 })
        }
      } else {
        draft = body.payload
      }
      // 粘贴进来的东西**过同一个校验器**，不因为是人工粘贴就放宽（SDD §6）。
      const roundNumber = (receipt.rounds?.length ?? 0) + 1
      const round = {
        round: roundNumber,
        kind: receipt.rounds?.length ? 'reverify' : 'verify',
        startedAt: typeof draft?.startedAt === 'string' ? draft.startedAt : new Date().toISOString(),
        finishedAt: typeof draft?.finishedAt === 'string' ? draft.finishedAt : new Date().toISOString(),
        // 产出者默认 `pasted`（用户从聊天里粘一段 JSON）。但界面上「逐条人工判定」走的是同一条
        // 导入通道，它不该被记成「粘贴导入」—— 那是**出处撒谎**。`PRODUCERS` 本来就含 `manual`，
        // 所以这里只是允许调用方说清楚它是哪一种，**没有新增字段、没有新增路由**。
        producedBy: PRODUCERS.includes(draft?.producedBy) ? draft.producedBy : 'pasted',
        provenance: null,
        blockedReason: typeof draft?.blockedReason === 'string' ? draft.blockedReason : null,
        evaluations: Array.isArray(draft?.evaluations) ? draft.evaluations : [],
      }

      // 模式 B 的证据必须**一起落库**。此前这里只写 `round`、丢掉 `draft.evidence`，
      // 后果不是「少一个字段」，而是：evaluations 里任何 evidenceIds 都指不到东西 ⇒
      // `validateReceipt` 拒收整轮 ⇒ **模式 B 永远记不了「通过」**，只能记未验证。
      // 保底通道如果只能记未验证，它就不再是保底通道（SDD §6：两种模式产出的 round 逐字段相同）。
      // 逐条过 `validateEvidence`，任意一条不合格 ⇒ 整轮拒收、一条都不写（与模式 A 同规矩）。
      const draftEvidence = Array.isArray(draft?.evidence) ? draft.evidence : []
      const errors = []
      const seen = new Set((receipt.evidence ?? []).map((item) => item?.evidenceId))
      const incoming = []
      for (const [index, item] of draftEvidence.entries()) {
        const checked = validateEvidence(item)
        if (!checked.ok) {
          for (const message of checked.errors) errors.push(`evidence[${index}]：${message}`)
          continue
        }
        if (seen.has(item.evidenceId)) {
          errors.push(`evidence[${index}]：证据 id ${item.evidenceId} 已经用过 —— 凭证里的证据 id 必须唯一`)
          continue
        }
        // 证据的 round 要和它所属的轮次一致，否则「这条证据是哪一轮看到的」就说不清了。
        if (item.round !== roundNumber) {
          errors.push(`evidence[${index}]：这是第 ${roundNumber} 轮，证据的 round 应写 ${roundNumber}，实为 ${JSON.stringify(item.round)}`)
          continue
        }
        seen.add(item.evidenceId)
        incoming.push(item)
      }
      if (errors.length > 0) return sendJson({ ok: false, errors }, 400)

      const merged = { ...receipt, evidence: [...(receipt.evidence ?? []), ...incoming] }
      const result = appendRound(merged, round)
      if (result.errors.length > 0) return sendJson({ ok: false, errors: result.errors }, 400)

      // 无证据的「通过」就是把「未验证」写成「通过」（L0 §10 第 2 条）。模式 A 由
      // `normalizeDelegatedResult` 拒收；模式 B 原先只靠 `validateReceipt`，而它只查
      // 「引用的证据存不存在」—— 一个都不引用时它不报错，于是同一条硬规则在两个模式里
      // 松紧不同（`fail` 无复现步骤倒是两边都拒）。两边必须同规矩。
      //
      // 放在 appendRound **之后**：先让「指向不存在的验收项」「非法状态」这类更基础的问题
      // 报出来，否则一条 AC-99 的 pass 会被这里抢先说成「没有证据」，把真正的原因盖掉。
      for (const [index, evaluation] of round.evaluations.entries()) {
        const evidenceIds = Array.isArray(evaluation?.evidenceIds) ? evaluation.evidenceIds : []
        if (evaluation?.status === 'pass' && evidenceIds.length === 0) {
          errors.push(
            `evaluation[${index}]：${evaluation.criterionId} 判为通过却没有任何证据 —— 无证据的通过就是「未验证」`,
          )
        }
      }
      if (errors.length > 0) return sendJson({ ok: false, errors }, 400)

      const check = validateReceipt(result.receipt)
      if (!check.ok) return sendJson({ ok: false, errors: check.errors }, 400)
      await store.write(result.receipt)
      return sendJson({ ok: true, receipt: result.receipt })
    })

    // --- 用户决定 ------------------------------------------------------------
    route('/api/acceptance.decision', ['POST'], async (request) => {
      const body = await readJson(request)
      const taskId = requireString(body.taskId, 'taskId')
      const receipt = await store.read(taskId)
      if (!receipt) return sendJson({ ok: false, error: `没有任务 ${taskId}` }, 404)
      const decision = requireString(body.decision, 'decision')
      const now = new Date().toISOString()
      const updated = {
        ...receipt,
        updatedAt: now,
        decision: {
          value: decision,
          note: typeof body.note === 'string' ? body.note : '',
          decidedAt: now,
          // 决定时看到的五态计数。**它是记录，不是分数** —— 不参与任何计算。
          countsAtDecision: summarizeCounts(receipt),
        },
      }
      await store.write(updated)
      return sendJson({ ok: true, receipt: updated })
    })

    // --- 导出 Markdown 凭证 ---------------------------------------------------
    route('/api/acceptance.export', ['GET'], async (_request, query) => {
      const taskId = requireString(query.get('taskId'), 'taskId')
      const receipt = await store.read(taskId)
      if (!receipt) return sendJson({ ok: false, error: `没有任务 ${taskId}` }, 404)
      const format = query.get('format') ?? 'md'
      if (format !== 'md') return sendJson({ ok: false, error: `不支持的导出格式 ${format}` }, 400)
      return sendText(buildMarkdownExport(receipt), 200, 'text/markdown; charset=utf-8')
    })
  })
}
