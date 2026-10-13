/**
 * 工具**输出**契约断言 —— 复刻真机的输出校验，把「模型一调就废」提前到 CI。
 *
 * 为什么需要这条：真机 `dsh-tools` 会**强制**校验工具返回值
 * （`lib/index.js:467-468`：`additionalProperties: false` 时，每个 key 都必须在 `properties` 里，
 * 否则整次调用失败）。而失败信息长成「工具输出校验失败」——
 * 模型只会告诉用户「验收台坏了」，谁都看不出是 schema 少写了一行。
 *
 * **2026-10-12 真机实测踩到**：`acceptance_begin_task` 返回了未声明的 `receiptId`，
 * 连续两次调用全废。所以这里把每个工具的**每条返回路径**都过一遍校验。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { SCHEMA_VERSION } from '../src/dsh/host/domain.js'
import { buildAcceptanceTools } from '../src/dsh/host/tools.js'

/** 复刻真机 `checkSchemaNode` 的输出校验：递归检查 key 是否已声明 + `required` 是否齐。 */
function assertOutputConforms(schema, value, path = 'value') {
  const problems = []
  const visit = (node, val, at) => {
    if (!node || typeof node !== 'object') return
    if (node.type === 'object' || node.properties) {
      if (val === null || typeof val !== 'object' || Array.isArray(val)) {
        problems.push(`${at} 应为对象，实为 ${Array.isArray(val) ? 'array' : typeof val}`)
        return
      }
      const properties = node.properties ?? {}
      // 真机规则：additionalProperties === false ⇒ 未声明的 key 直接判失败。
      if (node.additionalProperties === false) {
        for (const key of Object.keys(val)) {
          if (!Object.hasOwn(properties, key)) problems.push(`"${at}.${key}" is not a declared property (additionalProperties: false)`)
        }
      }
      for (const key of node.required ?? []) {
        if (!Object.hasOwn(val, key)) problems.push(`${at}.${key} is required but missing`)
      }
      for (const [key, child] of Object.entries(properties)) {
        if (Object.hasOwn(val, key)) visit(child, val[key], `${at}.${key}`)
      }
    } else if (node.type === 'array') {
      if (!Array.isArray(val)) {
        problems.push(`${at} 应为数组`)
        return
      }
      for (const [index, item] of val.entries()) visit(node.items, item, `${at}[${index}]`)
    }
  }
  visit(schema, value, path)
  return problems
}

/** 造一个已经确认过验收项的任务，让 submit_delivery 能真的走到委派。 */
function seedReceipt(rounds = []) {
  return {
    schemaVersion: SCHEMA_VERSION,
    receiptId: 'AR-20261012-0001',
    taskId: 't1',
    taskTitle: '',
    requirementText: '原始需求',
    scope: { cwd: null, branch: null, changedFiles: [], changedFilesSource: 'unknown', runUrl: null },
    createdAt: '2026-10-12T00:00:00.000Z',
    updatedAt: '2026-10-12T00:00:00.000Z',
    criteria: [
      { id: 'AC-01', origin: 'original', sourceQuote: '', title: '一条', precondition: '', steps: [], expected: '', method: 'manual', confirmedByUserAt: '2026-10-12T00:00:00.000Z', deletedAt: null },
    ],
    rounds,
    evidence: [],
    repairs: [],
    decision: null,
  }
}

function makeTools({ receipts = {}, runVerification } = {}) {
  return buildAcceptanceTools({
    store: {
      read: async (taskId) => receipts[taskId],
      write: async (receipt) => {
        receipts[receipt.taskId] = receipt
      },
    },
    runVerification: runVerification ?? (async () => ({ outcome: 'ok', committed: true, round: 1 })),
    resolveChangedFiles: () => ({ files: [], source: 'no-session' }),
    warn: () => {},
  })
}

/** 每条返回路径都要过输出校验。 */
async function checkAll(toolName, cases, options) {
  const receipts = {}
  for (const [, , receipt] of cases) if (receipt) receipts[receipt.taskId] = receipt
  const tools = makeTools({ receipts, ...options })
  const tool = tools.find((candidate) => candidate.name === toolName)
  assert.ok(tool, `没有工具 ${toolName}`)
  assert.ok(tool.output?.schema, `${toolName} 没有 output.schema`)
  const checked = []
  for (const [label, args, , exec = { agent: { id: 'a', session: { id: 'live' } } }] of cases) {
    const value = await tool.execute(args, exec)
    const problems = assertOutputConforms(tool.output.schema, value)
    assert.deepEqual(problems, [], `${toolName} / ${label} 的输出不合 schema：\n  ${problems.join('\n  ')}`)
    checked.push(label)
  }
  return checked
}

test('begin_task：成功与四条失败路径的输出都合 schema（真机强制校验，越界即整次调用失败）', async () => {
  const checked = await checkAll('acceptance_begin_task', [
    ['成功', { requirementText: '原始需求', criteria: [{ title: '一条', origin: 'original' }] }],
    ['无 Agent 上下文', { requirementText: 'x' }, null, {}],
    ['空需求', { requirementText: '   ' }],
    ['缺 requirementText', {}],
    ['内部错误', { requirementText: 'x', criteria: [{ title: '坏' }] }, null],
  ])
  assert.ok(checked.length >= 4)
})

test('submit_delivery：契约未确认 / 任务不存在 / 正常提交的输出都合 schema', async () => {
  const unconfirmed = { ...seedReceipt(), criteria: seedReceipt().criteria.map((c) => ({ ...c, confirmedByUserAt: null })) }
  const checked = await checkAll('acceptance_submit_delivery', [
    ['正常提交', { taskId: 't1' }, seedReceipt()],
    ['验收项未确认', { taskId: 't1' }, unconfirmed],
    ['任务不存在', { taskId: 'nope' }],
    ['缺 taskId', {}],
    ['非法 taskId', { taskId: '../etc/passwd' }],
    ['没有委派服务', { taskId: 't1' }, seedReceipt()],
  ])
  assert.ok(checked.includes('正常提交'))
})

test('submit_delivery：委派被阻塞时也走同一条输出契约', async () => {
  const blocked = makeTools({
    receipts: { t1: seedReceipt() },
    runVerification: async () => ({ outcome: 'blocked', committed: true, message: '子 Agent 起不来' }),
  })
  const tool = blocked.find((candidate) => candidate.name === 'acceptance_submit_delivery')
  const value = await tool.execute({ taskId: 't1' }, { agent: { id: 'a', session: { id: 'live' } } })
  assert.equal(value.ok, false)
  assert.equal(value.reason, 'blocked-round')
  assert.deepEqual(assertOutputConforms(tool.output.schema, value), [])
})

test('get_result：有轮次 / 无轮次 / 取不到，三种输出都合 schema', async () => {
  const withRound = seedReceipt([
    {
      round: 1,
      kind: 'verify',
      startedAt: '2026-10-12T00:00:00.000Z',
      finishedAt: '2026-10-12T00:01:00.000Z',
      producedBy: 'agent',
      provenance: { provider: 'spawn', fingerprint: null },
      blockedReason: null,
      evaluations: [
        { criterionId: 'AC-01', status: 'unknown', evidenceIds: [], reproductionSteps: [], note: '没查到' },
      ],
    },
  ])
  const checked = await checkAll('acceptance_get_result', [
    ['有轮次', { taskId: 't1' }, withRound],
    ['无轮次', { taskId: 't1' }, seedReceipt()],
    ['任务不存在', { taskId: 'nope' }],
    ['缺 taskId', {}],
  ])
  assert.equal(checked.length, 4)
})

test('工具的输出 schema 里，凡声明 additionalProperties:false 的节点都必须与真实返回一致', async () => {
  // 反向钉住：目前**故意**在三处根节点用了 true（错误分支的字段不该逼着 schema 跟着长）。
  // 但一旦有人把它改回 false，就会再次出现「模型一调就废」—— 所以这里断言它现在是 true 并说明理由。
  const tools = makeTools()
  for (const tool of tools) {
    assert.equal(
      tool.output.schema.additionalProperties,
      true,
      `${tool.name} 的 output.schema.additionalProperties 被改成了 false —— 真机会严格校验，错误分支多一个字段就整次调用失败`,
    )
  }
})
