/**
 * 模式 A 的**委派执行体**（SDD §5、§14）—— v0.2.0 从 `index.js` 的路由里抽出。
 *
 * 抽出来的唯一理由：**HTTP 路由与模型可调用工具必须走同一条逻辑路径**。
 * 两份实现会各自演化，然后在真机上表现成「工具说已提交、界面说还在开发中」两套真相
 * （SDD §14.1 反模式 4）。
 *
 * 本模块**不认识 HTTP**：它只回信封 `{ outcome, committed, reasonCode, … }`。
 * 4xx 与错误条是 HTTP 适配层的事，`blocked` 轮是凭证的事 —— 两者分开。
 *
 * ## 承诺点
 *
 * `runtime.start()` 那一行是**承诺点**（决策 D-026）：
 *  - 之前失败 ⇒ `outcome: 'error'`、`committed: false`、**不写轮次**；
 *  - 之后失败 ⇒ `outcome: 'blocked'`、`committed: true`、**必写一轮 `blocked`**。
 *
 * 转瞬即逝的报错留不下证据，用户下次打开凭证会以为从没试过（SDD §5.5）。
 *
 * @module dsh-acceptance/host/verification
 */

import {
  appendRound,
  buildDelegationPrompt,
  buildVerifySchema,
  delegationRoundKind,
  delegationRoundNumber,
  normalizeDelegatedResult,
  validateReceipt,
} from './domain.js'

const DEFAULT_PROVIDER = 'spawn'
const DEFAULT_TIMEOUT_MS = 600000

/** 一个信封的三种结局。**不是**验收项五态 —— 那是 `evaluations[].status`（SDD §15.1）。 */
export const OUTCOMES = Object.freeze(['error', 'blocked', 'ok'])

const error = (reasonCode, message, httpStatus) => ({
  outcome: 'error',
  committed: false,
  reasonCode,
  message,
  httpStatus,
  receipt: null,
  round: null,
})

/**
 * @param {object} deps
 * @param {{read: Function, write: Function}} deps.store
 * @param {() => object|null} deps.subagents   宿主 `subagents` 服务（可能缺席）
 * @param {() => object|null} deps.agents      宿主 `agents` 注册表（可能缺席）
 */
export function createVerificationRunner({ store, subagents, agents }) {
  /** 写一轮 blocked。**不解析 `output` 自由文本** —— 从自然语言猜结论会把「未验证」污染成「通过」。 */
  const writeBlockedRound = async (receipt, reason, provenance) => {
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
    if (appended.errors.length > 0) {
      return error('append-rejected', `阻塞轮次写不进去：${appended.errors.join(' / ')}`, 400)
    }
    await store.write(appended.receipt)
    return {
      outcome: 'blocked',
      committed: true,
      reasonCode: 'delegation-failed',
      message: reason,
      httpStatus: 200,
      receipt: appended.receipt,
      round: null,
    }
  }

  /**
   * 跑一次委派取证。
   *
   * @param {object} input
   * @param {string} input.taskId
   * @param {object} input.parent                活着的父 `Agent` 对象（工具层来自 `exec.agent`）
   * @param {string} input.parentSessionId       权威身份来源（**不接受**调用方自报）
   * @param {string} [input.provider]
   * @param {number} [input.timeoutMs]
   * @param {number} [input.maxTokens]
   * @param {(sessionId: string) => object} [input.resolveChangedFiles]
   */
  async function runVerification({
    taskId,
    parent,
    parentSessionId,
    provider: requestedProvider,
    timeoutMs: requestedTimeoutMs,
    maxTokens,
    resolveChangedFiles,
  }) {
    if (typeof taskId !== 'string' || taskId.trim() === '') {
      return error('invalid-task-id', 'taskId 不能为空', 400)
    }
    const receipt = await store.read(taskId)
    if (!receipt) return error('no-such-task', `没有任务 ${taskId}`, 404)

    const active = (receipt.criteria ?? []).filter((criterion) => criterion && !criterion.deletedAt)
    if (active.length === 0) {
      return error('no-criteria', '这个任务还没有验收项 —— 先确认验收项，再委派取证', 400)
    }

    // ---- P0-3（2026-10-12）：两条取证路径必须遵守**同一条**确认规则 -------------------------
    //
    // 修之前：Agent 提交路径（`tools.js` 的 submit_delivery）对「有未确认项」硬挡 409，
    // 而 UI 路径（本文件）只要求「有未删除的验收项」—— 同一份凭证，一条路拒、一条路照常验证。
    //
    // 统一后的规则（三条一起才叫统一）：
    //  1. **只对已确认项取证**：委派用的 `outputSchema` 与提示词都只含 confirmed 的项；
    //  2. **未确认项被跳过、并被说明**：写进这一轮 `provenance.skippedUnconfirmed`，UI 与开发 Agent 都读得到；
    //  3. **一条 confirmed 都没有 ⇒ 不发起委派**（承诺点之前 4xx，不写轮次），并说明先去确认。
    const confirmed = active.filter((criterion) => Boolean(criterion.confirmedByUserAt))
    const skippedUnconfirmed = active
      .filter((criterion) => !criterion.confirmedByUserAt)
      .map((criterion) => criterion.id)
    if (confirmed.length === 0) {
      return error(
        'no-confirmed-criteria',
        `这个任务的 ${active.length} 条验收项都还没确认 —— 未确认的范围不是契约，先确认再取证（未确认项：${active.map((c) => c.id).join(', ')}）`,
        400,
      )
    }
    // 委派只看得见已确认项：提示词与 schema 都用这份**收窄后的凭证**。
    const delegationReceipt = { ...receipt, criteria: confirmed }

    // ⚠️ 真机 0.2.1-alpha.2 的委派入口叫 **`startActivation(spec)`**，不是 `start(provider, request)`。
    // 凭据：`dsh-tool-subagent/lib/index.js:409`（模型面前的 subagent 工具就是这么发的）、
    // `dsh-subagent/lib/index.js:3032`（定义）。**旧写法在当前运行时上根本不存在**——
    // 表现是「宿主不可委派」，而人第一时间不会怀疑是自己调错了方法名。
    const runtime = subagents()
    if (!runtime?.startActivation) {
      // 消息里带上**当场看到的值**：只写「没有 subagents 服务」的话，
      // 「服务确实缺席」与「拿到的不是那个服务」长得一模一样，真因被吞（2026-10-12 真机踩到）。
      // 三种成因必须说成**三句不同的话**（2026-10-12 真机踩到：headless 的 subagents 服务对象
      // 存在、provider 也在（`list()` 有值），就是**没有 `start` 这个可编程委派入口**，
      // 而我原来的消息写成「没有 subagents 服务」—— 把「服务不提供该 API」说成了「服务不存在」，
      // 排查时会照着错方向找。
      const seen =
        runtime === null || runtime === undefined
          ? `完全没有 subagents 服务（读到 ${String(runtime)}）`
          : `服务在，但没有 \`startActivation\` 这个委派入口（provider 现有：${JSON.stringify(runtime.list?.() ?? null)}）`
      return error(
        'no-delegation-api',
        `宿主不可委派：${seen} —— 模式 A 不可用，请走模式 B（验收包 → 导入）`,
        400,
      )
    }

    // 路由处理器没有工具层的 `exec.agent`，只能按 sessionId 去 AgentRegistry 里查**活着的**那个；
    // 工具层直接把 `exec.agent` 递进来。两条路径在这里汇合，身份都**不来自调用方自报**。
    const parentAgent = parent ?? agents()?.get?.(parentSessionId)
    if (!parentAgent) {
      return error(
        'no-live-agent',
        `会话 ${parentSessionId} 没有活着的 Agent —— 宿主重启后需要先恢复该会话；或改走模式 B（验收包 → 导入）`,
        409,
      )
    }

    const provider =
      typeof requestedProvider === 'string' && requestedProvider.trim() ? requestedProvider.trim() : DEFAULT_PROVIDER
    if (typeof runtime.list === 'function' && !runtime.list().includes(provider)) {
      const available = (runtime.list() ?? []).join(', ') || '无'
      return error('no-such-provider', `宿主没有名为 ${provider} 的委派 provider（现有：${available}）`, 400)
    }

    const timeoutMs =
      Number.isInteger(requestedTimeoutMs) && requestedTimeoutMs > 0 ? requestedTimeoutMs : DEFAULT_TIMEOUT_MS
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('验收超时')), timeoutMs)
    const startedAt = new Date().toISOString()

    // ---- 承诺点：这一行之后的一切失败都写 blocked 轮次，不再返回 4xx ----
    //
    // `spec` 的形状照抄模型面那个 subagent 工具（`dsh-tool-subagent/lib/index.js:395-415`）+ 我们要的 `outputSchema`：
    //   { provider, label, delivery, signal, request: { prompt, parent, outputSchema, agentOptions } }
    // `signal` 必须在 spec 上（真机 `startActivation` 里先 `spec.signal.throwIfAborted()`）——
    // 少了它会在真机上抛一个与「超时」毫无关系的 TypeError。
    let run
    try {
      run = await runtime.startActivation({
        provider,
        label: `验收 ${taskId}`,
        delivery: 'parent',
        signal: controller.signal,
        request: {
          prompt: [{ type: 'text', text: buildDelegationPrompt(delegationReceipt) }],
          parent: parentAgent,
          // `signal` **两处都给**：真机 `startActivation` 读 `spec.signal`，而 `request.signal` 是委派请求
          // 自己的中止信号（模型面那个工具也是这么带的）。只给一处会在真机上抛一个与超时无关的 TypeError。
          signal: controller.signal,
          outputSchema: buildVerifySchema(delegationReceipt.criteria),
          ...(Number.isInteger(maxTokens) && maxTokens > 0 ? { agentOptions: { maxTokens } } : {}),
        },
      })
    } catch (caught) {
      clearTimeout(timer)
      return writeBlockedRound(
        receipt,
        `委派启动失败：${String(caught?.message ?? caught)}`,
        { provider, phase: 'start', skippedUnconfirmed },
      )
    }

    let result
    try {
      result = await run.result
    } catch (caught) {
      clearTimeout(timer)
      await disposeQuietly(run)
      return writeBlockedRound(
        receipt,
        `委派执行失败：${String(caught?.message ?? caught)}`,
        { provider, phase: 'run', skippedUnconfirmed },
      )
    }
    clearTimeout(timer)
    await disposeQuietly(run)

    const finishedAt = new Date().toISOString()
    const provenance = {
      provider,
      // 真机回的是 `{ childId, result, dispose }`（`dsh-subagent/lib/index.js:2081`），**不是 `id`**。
      runId: run?.childId ?? null,
      stopReason: result?.stopReason ?? null,
      parentSessionId,
      diagnostic: result?.diagnostic ?? null,
      // 版本指纹首版**恒 null**（L0 §10 第 9 条、S5）：拿不到就写 null = 「版本未知」，
      // 不许用变更文件列表派生哈希冒充。
      fingerprint: null,
      // P0-3：这一轮**跳过了哪些未确认项**。空数组也要写 —— 「一项都没跳」与「没记这件事」
      // 是两句不同的话，界面与返修清单都靠它说话。
      skippedUnconfirmed,
      ...(resolveChangedFiles && parentSessionId ? { changedFiles: resolveChangedFiles(parentSessionId) } : {}),
    }

    if (result?.structured === undefined) {
      // SDD §5.2 第 2 步：**不去解析 `output` 文本**。
      return writeBlockedRound(
        receipt,
        `委派没有返回结构化结果（stopReason=${String(result?.stopReason)}）—— 不解析自由文本，这一轮记为被阻塞`,
        provenance,
      )
    }

    const normalized = normalizeDelegatedResult(delegationReceipt, result.structured, { startedAt, finishedAt })
    if (normalized.errors.length > 0) {
      // 子 Agent 给了结果但不合契约 ⇒ 仍然写 blocked，把逐条错误原样写进 blockedReason。
      // **不部分写入**（SDD §5.2 第 3 步），也不丢掉「真的跑过一次」这个事实。
      return writeBlockedRound(
        receipt,
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
    if (appended.errors.length > 0) {
      // 已在承诺点之后：**绝不能静默丢掉这一轮**（v0.2.0 修正 —— 旧路由在这里回 4xx 且不落轮次，
      // 与「承诺点之后失败必写 blocked」自相矛盾）。写一轮 blocked 把真实原因留下来。
      return writeBlockedRound(receipt, `落轮次被拒：${appended.errors.join(' / ')}`, {
        ...provenance,
        phase: 'append',
      })
    }

    const check = validateReceipt(appended.receipt)
    if (!check.ok) {
      return writeBlockedRound(receipt, `凭证校验不过：${check.errors.join(' / ')}`, {
        ...provenance,
        phase: 'validate',
      })
    }

    await store.write(appended.receipt)
    return {
      outcome: 'ok',
      committed: true,
      reasonCode: null,
      message: null,
      httpStatus: 200,
      receipt: appended.receipt,
      round: normalized.round,
    }
  }

  return { runVerification }
}

async function disposeQuietly(run) {
  try {
    await run?.dispose?.()
  } catch {
    // 清理失败不该盖掉已经拿到的结论
  }
}
