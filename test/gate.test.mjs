/**
 * 行为断言（`node --test`）。
 *
 * 源码文本层断言（守卫 G1–G8）证明「那行字出现过」；这里证明「它做的是那件事」。
 * 两者都要有：只跑文本断言，一个恒返回 `pending` 的 `deriveCurrentStatuses` 也能全绿。
 *
 * @module test/gate
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  EVIDENCE_KINDS,
  SCHEMA_VERSION,
  STATUSES,
  appendRound,
  buildAcceptancePackage,
  buildMarkdownExport,
  createReceipt,
  deriveCurrentStatuses,
  newReceiptId,
  nextCriterionId,
  scopeDrift,
  staleInLatestRound,
  summarizeCounts,
  validateEvidence,
  validateReceipt,
} from '../src/dsh/host/domain.js'

const T0 = new Date('2026-10-10T09:00:00.000Z')

/** 两个验收项 + 一条命令证据的凭证。 */
function fixture(overrides = {}) {
  const receipt = createReceipt({
    taskId: 'demo-task',
    taskTitle: '演示任务',
    requirementText: '需求原文：导出的报告里不许出现总分。',
    scope: { cwd: '/tmp/demo', changedFiles: ['a.js'], changedFilesSource: 'workspace-changes' },
    now: T0,
    receiptId: 'TR-20261010-0900-abcd',
  })
  receipt.criteria = [
    {
      id: 'AC-01',
      origin: 'original',
      sourceQuote: '不许出现总分',
      title: '导出里没有总分',
      precondition: '',
      steps: ['打开导出'],
      expected: '看不到任何总分',
      method: 'command',
      confirmedByUserAt: T0.toISOString(),
      deletedAt: null,
    },
    {
      id: 'AC-02',
      origin: 'suggested',
      sourceQuote: '',
      title: '顺带检查空状态文案',
      precondition: '',
      steps: [],
      expected: '',
      method: 'manual',
      confirmedByUserAt: null,
      deletedAt: null,
    },
  ]
  Object.assign(receipt, overrides)
  return receipt
}

function evidence(id, criterionId, round) {
  return {
    evidenceId: id,
    criterionId,
    round,
    kind: 'command',
    capturedAt: T0.toISOString(),
    text: '命令跑完没有输出总分',
    exitCode: 0,
    ref: { type: 'command', locator: 'node --test', excerpt: null },
  }
}

function round(number, evaluations, extra = {}) {
  return {
    round: number,
    kind: number === 1 ? 'verify' : 'reverify',
    startedAt: T0.toISOString(),
    finishedAt: new Date(T0.getTime() + number * 60000).toISOString(),
    producedBy: 'agent',
    provenance: null,
    blockedReason: null,
    scopeSnapshot: { fingerprint: null, changedFiles: ['a.js'] },
    evaluations,
    ...extra,
  }
}

test('createReceipt 产出契约形状，且五态计数恒为五键', () => {
  const receipt = createReceipt({ taskId: 'x', requirementText: 'r', now: T0 })
  assert.equal(receipt.schemaVersion, SCHEMA_VERSION)
  assert.match(receipt.receiptId, /^TR-\d{8}-\d{4}-[0-9a-f]{4}$/)
  for (const key of ['criteria', 'rounds', 'evidence', 'repairs']) assert.deepEqual(receipt[key], [])
  assert.equal(receipt.decision, null)
  // 「一个字段都没有」和「有一个字段但没值」是结不了案的；汇总评分字段必须**不存在**。
  for (const banned of ['score', 'passRate', 'completion', 'total']) {
    assert.ok(!(banned in receipt), `凭证顶层不该有 ${banned}`)
  }
  assert.deepEqual(Object.keys(summarizeCounts(receipt)).sort(), [...STATUSES].sort())
  assert.deepEqual(summarizeCounts(receipt), { pending: 0, pass: 0, fail: 0, unknown: 0, blocked: 0 })
})

test('newReceiptId 只用可寻址字符、长度固定', () => {
  const id = newReceiptId(T0, () => 0.5)
  // 时区不进契约：只钉形状（本地时可读、排序可读，不许有空格或斜杠）。
  assert.match(id, /^TR-\d{8}-\d{4}-[0-9a-f]{4}$/)
})

test('deriveCurrentStatuses 取**降序第一条**结论，且不向前回退', () => {
  const receipt = fixture()
  receipt.evidence = [evidence('EV-0001', 'AC-01', 1), evidence('EV-0002', 'AC-01', 2)]
  receipt.rounds = [
    round(1, [{ criterionId: 'AC-01', status: 'fail', evidenceIds: [], reproductionSteps: ['点导出'] }]),
    round(2, [{ criterionId: 'AC-01', status: 'pass', evidenceIds: ['EV-0002'] }]),
  ]
  assert.equal(deriveCurrentStatuses(receipt)['AC-01'], 'pass')

  // 最新一轮没有提到它 ⇒ 保留旧结论（界面上必须同时标「本轮未复查」），**不**退回 pending。
  receipt.rounds = [
    round(1, [{ criterionId: 'AC-01', status: 'pass', evidenceIds: ['EV-0001'] }]),
    round(2, [{ criterionId: 'AC-02', status: 'unknown', evidenceIds: [] }]),
  ]
  const statuses = deriveCurrentStatuses(receipt)
  assert.equal(statuses['AC-01'], 'pass')
  assert.equal(statuses['AC-02'], 'unknown')
  assert.deepEqual([...staleInLatestRound(receipt)], ['AC-01'])
})

test('没有轮次时全部是 pending，且全部算「本轮未复查」', () => {
  const receipt = fixture()
  assert.deepEqual(deriveCurrentStatuses(receipt), { 'AC-01': 'pending', 'AC-02': 'pending' })
  assert.deepEqual([...staleInLatestRound(receipt)].sort(), ['AC-01', 'AC-02'])
})

test('已删除的验收项不出现在状态与计数里', () => {
  const receipt = fixture()
  receipt.criteria[1].deletedAt = T0.toISOString()
  const statuses = deriveCurrentStatuses(receipt)
  assert.ok(!('AC-02' in statuses))
  assert.deepEqual(summarizeCounts(receipt), { pending: 1, pass: 0, fail: 0, unknown: 0, blocked: 0 })
})

test('appendRound 只增不改、拒非法状态、拒不存在的验收项', () => {
  const receipt = fixture()
  receipt.evidence = [evidence('EV-0001', 'AC-01', 1)]

  const bad = appendRound(receipt, round(1, [{ criterionId: 'AC-01', status: 'maybe' }]))
  assert.ok(bad.errors.length > 0)
  assert.equal(bad.receipt.rounds.length, 0)

  const ghost = appendRound(receipt, round(1, [{ criterionId: 'AC-99', status: 'pass' }]))
  assert.ok(ghost.errors.some((message) => message.includes('AC-99')))

  const badProducer = appendRound(receipt, round(1, [], { producedBy: 'robot' }))
  assert.ok(badProducer.errors.some((message) => message.includes('producedBy')))

  const good = appendRound(receipt, round(1, [{ criterionId: 'AC-01', status: 'pass', evidenceIds: ['EV-0001'] }]))
  assert.deepEqual(good.errors, [])
  assert.equal(good.receipt.rounds.length, 1)
  // 原对象没被就地改 —— 只增不改。
  assert.equal(receipt.rounds.length, 0)
})

test('validateReceipt：fail 必须带复现步骤，否则整份凭证不合法', () => {
  const receipt = fixture()
  receipt.rounds = [round(1, [{ criterionId: 'AC-01', status: 'fail', evidenceIds: [] }])]
  const result = validateReceipt(receipt)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((message) => message.includes('复现步骤')))

  receipt.rounds = [
    round(1, [{ criterionId: 'AC-01', status: 'fail', evidenceIds: [], reproductionSteps: ['点导出按钮'] }]),
  ]
  assert.equal(validateReceipt(receipt).ok, true)
})

test('validateReceipt：证据必须指向存在的验收项、id 不许重复、original 缺一不可', () => {
  const receipt = fixture()
  receipt.evidence = [evidence('EV-0001', 'AC-99', 1), evidence('EV-0001', 'AC-01', 1)]
  const result = validateReceipt(receipt)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((message) => message.includes('不存在的验收项')))
  assert.ok(result.errors.some((message) => message.includes('重复')))

  const empty = fixture({ requirementText: '   ' })
  assert.equal(validateReceipt(empty).ok, false)
})

test('scopeDrift：变更范围不同 ⇒ 可能已过期；相同 ⇒ 只说版本未知', () => {
  const receipt = fixture()
  const drifted = scopeDrift(receipt, round(1, [], { scopeSnapshot: { fingerprint: null, changedFiles: ['b.js'] } }))
  assert.deepEqual(drifted, { changed: true, reason: 'scope-drifted' })
  const same = scopeDrift(receipt, round(1, [], { scopeSnapshot: { fingerprint: null, changedFiles: ['a.js'] } }))
  assert.deepEqual(same, { changed: false, reason: 'unknown-version' })
})

test('导出：两个标注必须出现，且原始需求与建议补充分列', () => {
  const receipt = fixture()
  receipt.evidence = [evidence('EV-0001', 'AC-01', 1)]
  receipt.rounds = [
    round(1, [
      { criterionId: 'AC-01', status: 'pass', evidenceIds: ['EV-0001'] },
      { criterionId: 'AC-02', status: 'unknown', evidenceIds: [] },
    ]),
    round(2, [{ criterionId: 'AC-02', status: 'pass', evidenceIds: [] }]),
  ]
  receipt.decision = {
    value: '接受',
    note: '',
    decidedAt: T0.toISOString(),
    countsAtDecision: summarizeCounts(receipt),
  }

  const markdown = buildMarkdownExport(receipt, { now: T0 })
  assert.ok(markdown.includes('本轮未复查'), '导出必须带「本轮未复查」——否则导出比界面更可信')
  assert.ok(markdown.includes('版本未知'), '导出必须带「版本未知」')
  assert.ok(markdown.includes('TR-20261010-0900-abcd'))
  assert.ok(markdown.includes('需求原文：导出的报告里不许出现总分。'), '原始需求必须逐字出现')
  assert.ok(markdown.indexOf('origin=original') < markdown.indexOf('origin=suggested'), '两类必须分列')
  assert.ok(markdown.includes('未验证'), 'unknown 必须写成「未验证」')
  for (const status of STATUSES) assert.ok(markdown.includes(status), `五态 ${status} 都要在汇总里出现`)

  // 反向钉住：折算词一个都不许回来。
  for (const word of ['完成率', '通过率', '质量分', '健康度']) {
    assert.ok(!markdown.includes(word), `导出里出现了折算词「${word}」`)
  }
  for (const token of ['score', 'passRate', 'completion']) {
    assert.ok(!markdown.toLowerCase().includes(token.toLowerCase()), `导出里出现了禁止字段 ${token}`)
  }
})

test('导出：变更范围为空时，说清楚是**哪一种**空', () => {
  const ran = fixture({ scope: { changedFiles: [], changedFilesSource: 'workspace-changes' } })
  const same = buildMarkdownExport(ran, { now: T0 })
  assert.ok(same.includes('没有记录到任何文件改动'))
  assert.ok(same.includes('shell 命令造成的改动不在其中'))

  const lost = fixture({ scope: { changedFiles: [], changedFilesSource: 'summary-unavailable' } })
  assert.ok(buildMarkdownExport(lost, { now: T0 }).includes('无法判断有没有改动'))

  const noTurn = fixture({ scope: { changedFiles: [], changedFilesSource: 'no-turn-recorded' } })
  assert.ok(buildMarkdownExport(noTurn, { now: T0 }).includes('无法判断有没有改动'))

  // 三种「空」必须是三句不同的话 —— 这正是 L0 §10 第 10 条要保的东西。
  assert.notEqual(buildMarkdownExport(ran, { now: T0 }), buildMarkdownExport(lost, { now: T0 }))
})

test('验收包必须带回复的 JSON 契约原文与三条硬规则', () => {
  const pkg = buildAcceptancePackage(fixture())
  assert.ok(pkg.includes('AC-01') && pkg.includes('AC-02'))
  assert.ok(pkg.includes('需求原文：导出的报告里不许出现总分。'))
  assert.ok(pkg.includes('"evaluations"') && pkg.includes('"evidence"'), '必须带 schema 原文')
  assert.ok(pkg.includes('裸 JSON 对象'), '必须说清回复形态')
  for (const kind of EVIDENCE_KINDS) assert.ok(pkg.includes(kind), `schema 要列出证据类型 ${kind}`)
  assert.ok(pkg.includes('unknown'), '必须写明查不到要写 unknown，不许猜成 pass')
})

test('证据定位符的五类形态都要说得出理由，非法形态一律拒', () => {
  // G5 已跑全量反例；这里只钉住「拒绝的形态是带错误的拒绝，而不是降级成空 locator」。
  const base = {
    evidenceId: 'EV-0001',
    criterionId: 'AC-01',
    round: 1,
    capturedAt: T0.toISOString(),
    text: '观察',
  }
  const noLocator = validateEvidence({ ...base, kind: 'file', ref: { type: 'file', locator: '   ' } })
  assert.equal(noLocator.ok, false)
  assert.ok(noLocator.errors.length > 0, '拒绝必须带错误信息，不能静默返回空 locator')

  const ok = validateEvidence({ ...base, kind: 'command', exitCode: 1, ref: { type: 'command', locator: 'ls' } })
  assert.equal(ok.ok, true, '退出码非零的命令证据是**合法**证据 —— 它只是结论为未通过')
})

test('nextCriterionId 永不复用已删除的 id', () => {
  assert.equal(nextCriterionId([]), 'AC-01')
  assert.equal(nextCriterionId([{ id: 'AC-01' }, { id: 'AC-02', deletedAt: 'x' }]), 'AC-03')
  assert.equal(nextCriterionId([{ id: 'AC-07' }, { id: 'junk' }]), 'AC-08')
})
