/**
 * host 半集成测试 —— 用假 `ctx` 把 `apply()` 真的挂起来，走真实 handler。
 *
 * 目的：**重启 DSH 之前**就能发现路由接线、状态码、错误分派的问题。
 * 它不替代重启后的真机验证（`Request` 是本进程构造的，`requestBody: 'buffered'`
 * 与认证都不在这里发生），但它能挡住「8 条路由里有一条拼错」「400 变成 500」这类错误。
 *
 * 假 `ctx` 只实现 `apply()` 真正用到的两件事：`inject(names, cb)` 与
 * `scoped.connection.fetch.register(entry)`。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply, name } from '../src/dsh/host/index.js'

/** 版本号真源 —— 健康路由必须与它一致（不要在测试里钉字面量）。 */
const PACKAGE_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

const ROUTES = [
  '/api/acceptance.health',
  '/api/acceptance.tasks',
  '/api/acceptance.receipt',
  '/api/acceptance.criteria',
  '/api/acceptance.verify',
  '/api/acceptance.package',
  '/api/acceptance.import',
  '/api/acceptance.decision',
  '/api/acceptance.export',
]

/** 挂一个假 ctx；`sessions` / `subagents` / `agents` 可注入以造出各种失败路径。 */
function mount({ sessions, subagents, agents } = {}) {
  const registered = new Map()
  const ctx = {
    logger: { warn() {} },
    inject(names, callback) {
      const scoped = {}
      if (names.includes('connection')) {
        scoped.connection = {
          fetch: {
            register(entry) {
              // 硬约束 3：同一 path 只能注册一次。真宿主会因此整个 fiber 起不来。
              if (registered.has(entry.path)) throw new Error(`同一 path 注册了两次：${entry.path}`)
              registered.set(entry.path, entry)
            },
          },
        }
      }
      if (names.includes('sessions')) scoped.sessions = sessions ?? { get: () => undefined }
      if (names.includes('subagents')) scoped.subagents = subagents
      if (names.includes('agents')) scoped.agents = agents
      callback(scoped)
    },
  }
  return { registered, ctx }
}

/**
 * 造一个假委派运行时。
 *
 * `result` 是 `run.result` 的解析值；`resultError` 让它 reject；`startError` 让 `start` 直接抛。
 * 三者对应三种真实失败：执行失败 / 启动失败 / 正常返回（含「没给 structured」）。
 */
function fakeSubagents({ result, resultError, startError, providers = ['spawn'] } = {}) {
  const calls = []
  const state = { disposed: 0 }
  return {
    calls,
    state,
    list: () => providers,
    async start(provider, request) {
      calls.push({ provider, request })
      if (startError) throw new Error(startError)
      return {
        id: 'child-session-1',
        result: resultError ? Promise.reject(new Error(resultError)) : Promise.resolve(result),
        dispose: async () => {
          state.disposed += 1
        },
      }
    },
  }
}

/** 只有一个叫 `live` 的会话是「活着的 Agent」，用来同时验「查得到」和「查不到」。 */
const liveAgents = { get: (id) => (id === 'live' ? { id: 'live', session: { id: 'live' } } : undefined) }

function makeCall(registered) {
  return async function call(path, init = {}) {
    const entry = registered.get(path)
    assert.ok(entry, `没有注册路由 ${path}`)
    const method = init.method ?? 'GET'
    assert.ok(entry.methods.includes(method), `${path} 不接受 ${method}`)
    const url = new URL(`http://localhost${path}`)
    for (const [key, value] of Object.entries(init.query ?? {})) url.searchParams.set(key, value)
    const request = new Request(url, {
      method,
      ...(init.body === undefined
        ? {}
        : { body: typeof init.body === 'string' ? init.body : JSON.stringify(init.body) }),
    })
    return entry.fetch(request)
  }
}

/** 每个用例一个临时 dataRoot —— 不让测试之间通过 store 串味。 */
async function withStore(run, options) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-acceptance-test-'))
  try {
    const { registered, ctx } = mount(options)
    apply(ctx, { dataRoot: root })
    await run({ registered, call: makeCall(registered), root })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function readJson(response) {
  return { status: response.status, body: await response.json() }
}

/** 建一个含 AC-01 的任务，省掉每个用例的重复。 */
async function seedTask(call, taskId = 't1') {
  const created = await readJson(
    await call('/api/acceptance.tasks', {
      method: 'POST',
      body: { taskId, requirementText: '原始需求：点导出要出 CSV' },
    }),
  )
  assert.equal(created.status, 200, JSON.stringify(created.body))
  const added = await readJson(
    await call('/api/acceptance.criteria', {
      method: 'POST',
      body: { taskId, ops: [{ op: 'add', criterion: { title: '能导出 CSV', origin: 'original' } }] },
    }),
  )
  assert.equal(added.status, 200, JSON.stringify(added.body))
  return taskId
}

// ---------------------------------------------------------------------------
// 接线
// ---------------------------------------------------------------------------

test('apply() 把 ROUTES 里每条路由都注册上，全部在 /api 之下、无 PUT、无重复 path', async () => {
  await withStore(async ({ registered }) => {
    assert.deepEqual([...registered.keys()].sort(), [...ROUTES].sort())
    for (const [path, entry] of registered) {
      assert.ok(path.startsWith('/api/'), `${path} 不在 /api 之下`)
      assert.ok(!entry.methods.includes('PUT'), `${path} 用了 PUT`)
      assert.deepEqual(entry.methods.filter((m) => !['GET', 'HEAD', 'POST'].includes(m)), [])
      assert.equal(entry.requestBody, 'buffered', `${path} 的 requestBody 不是 buffered`)
    }
    assert.deepEqual(registered.get('/api/acceptance.tasks').methods, ['GET', 'POST'])
    assert.deepEqual(registered.get('/api/acceptance.criteria').methods, ['POST'])
  })
})

test('模块导出 name 与 apply', () => {
  assert.equal(name, 'dsh-acceptance')
  assert.equal(typeof apply, 'function')
})

test('health 报出五态与数据根，并禁止缓存', async () => {
  await withStore(async ({ call, root }) => {
    const response = await call('/api/acceptance.health')
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const body = await response.json()
    assert.equal(body.ok, true)
    assert.equal(body.plugin, 'dsh-acceptance')
    // 版本号**只有一个真源**：跟 package.json 比，而不是把一个字面量钉在这里
    // （曾经钉过 '0.1.0'，结果包里升到 0.1.1 时这条测试还在替旧值背书 —— 踩过的坑 P-021）。
    assert.equal(body.version, PACKAGE_VERSION, `健康路由报的版本 ${body.version} 与 package.json 的 ${PACKAGE_VERSION} 不一致`)
    assert.equal(body.schemaVersion, 1)
    assert.deepEqual(body.statuses, ['pending', 'pass', 'fail', 'unknown', 'blocked'])
    assert.equal(body.statusLabels.pass, '通过')
    assert.equal(body.dataRoot, root)
  })
})

// ---------------------------------------------------------------------------
// 任务与凭证
// ---------------------------------------------------------------------------

test('建任务后可读回；凭证顶层没有汇总字段', async () => {
  await withStore(async ({ call }) => {
    const created = await readJson(
      await call('/api/acceptance.tasks', {
        method: 'POST',
        body: { taskId: 't1', requirementText: '需求原文' },
      }),
    )
    assert.equal(created.status, 200)
    assert.equal(created.body.receipt.taskId, 't1')
    assert.equal(created.body.receipt.schemaVersion, 1)
    assert.deepEqual(created.body.receipt.criteria, [])
    assert.deepEqual(created.body.receipt.rounds, [])
    assert.equal(created.body.receipt.decision, null)
    assert.match(created.body.receipt.receiptId, /^TR-\d{8}-\d{4}-[0-9a-f]{4}$/)
    assert.equal(created.body.receipt.scope.changedFilesSource, 'no-session')

    for (const forbidden of ['score', 'passRate', 'completion', 'total']) {
      assert.ok(!(forbidden in created.body.receipt), `凭证顶层出现了 ${forbidden}`)
    }

    const listed = await readJson(await call('/api/acceptance.tasks'))
    assert.equal(listed.body.tasks.length, 1)
    assert.deepEqual(listed.body.broken, [])

    const fetched = await readJson(await call('/api/acceptance.receipt', { query: { taskId: 't1' } }))
    assert.equal(fetched.status, 200)
    assert.deepEqual(fetched.body.derived.statuses, {})
    assert.deepEqual(fetched.body.derived.stale, [])
    assert.deepEqual(fetched.body.derived.counts, { pending: 0, pass: 0, fail: 0, unknown: 0, blocked: 0 })
  })
})

test('重复 taskId 返回 409、缺 requirementText 返回 400', async () => {
  await withStore(async ({ call }) => {
    await call('/api/acceptance.tasks', { method: 'POST', body: { taskId: 'dup', requirementText: 'x' } })
    const again = await readJson(
      await call('/api/acceptance.tasks', { method: 'POST', body: { taskId: 'dup', requirementText: 'y' } }),
    )
    assert.equal(again.status, 409)
    assert.equal(again.body.ok, false)

    const empty = await readJson(
      await call('/api/acceptance.tasks', { method: 'POST', body: { taskId: 'e1', requirementText: '   ' } }),
    )
    assert.equal(empty.status, 400)
    assert.match(empty.body.error, /requirementText/)
  })
})

test('读不存在的任务返回 404', async () => {
  await withStore(async ({ call }) => {
    const missing = await readJson(await call('/api/acceptance.receipt', { query: { taskId: 'nope' } }))
    assert.equal(missing.status, 404)
    assert.match(missing.body.error, /没有任务/)
  })
})

// ---------------------------------------------------------------------------
// 验收项：add / confirm / delete
// ---------------------------------------------------------------------------

test('验收项 add → confirm 只能一次 → delete，且 id 不复用', async () => {
  await withStore(async ({ call, root }) => {
    await seedTask(call)

    const confirmed = await readJson(
      await call('/api/acceptance.criteria', {
        method: 'POST',
        body: { taskId: 't1', ops: [{ op: 'confirm', id: 'AC-01' }] },
      }),
    )
    assert.equal(confirmed.status, 200)
    assert.ok(confirmed.body.receipt.criteria[0].confirmedByUserAt)

    // 确认过的定义不许原地改，再确认一次要报错（SDD §2.2）
    const twice = await readJson(
      await call('/api/acceptance.criteria', {
        method: 'POST',
        body: { taskId: 't1', ops: [{ op: 'confirm', id: 'AC-01' }] },
      }),
    )
    assert.equal(twice.status, 400)
    assert.match(twice.body.errors[0], /已确认过/)

    const deleted = await readJson(
      await call('/api/acceptance.criteria', {
        method: 'POST',
        body: { taskId: 't1', ops: [{ op: 'delete', id: 'AC-01' }] },
      }),
    )
    assert.equal(deleted.status, 200)
    assert.ok(deleted.body.receipt.criteria[0].deletedAt)

    // 删除后新增：id 必须继续往后走，不复用 AC-01
    const added = await readJson(
      await call('/api/acceptance.criteria', {
        method: 'POST',
        body: { taskId: 't1', ops: [{ op: 'add', criterion: { title: '第二条' } }] },
      }),
    )
    assert.equal(added.body.receipt.criteria.map((c) => c.id).join(','), 'AC-01,AC-02')

    // 已删除项不进派生状态，也不进计数
    const fetched = await readJson(await call('/api/acceptance.receipt', { query: { taskId: 't1' } }))
    assert.deepEqual(Object.keys(fetched.body.derived.statuses), ['AC-02'])
    assert.equal(fetched.body.derived.counts.pending, 1)

    assert.ok(root.length > 0)
  })
})

test('未知操作与非法的 criterion.title 被拒', async () => {
  await withStore(async ({ call }) => {
    await seedTask(call)
    const bad = await readJson(
      await call('/api/acceptance.criteria', {
        method: 'POST',
        body: { taskId: 't1', ops: [{ op: 'rename', id: 'AC-01' }] },
      }),
    )
    assert.equal(bad.status, 400)
    assert.match(bad.body.errors[0], /未知操作/)

    const emptyTitle = await readJson(
      await call('/api/acceptance.criteria', {
        method: 'POST',
        body: { taskId: 't1', ops: [{ op: 'add', criterion: { title: '  ' } }] },
      }),
    )
    assert.equal(emptyTitle.status, 400)
    // 单一错误走 `{ error }`，批量校验失败走 `{ errors: [] }`（客户端两种都要接）
    assert.match(emptyTitle.body.error, /criterion\.title/)
    assert.equal(emptyTitle.body.errors, undefined)
  })
})

// ---------------------------------------------------------------------------
// 模式 B：验收包与导入
// ---------------------------------------------------------------------------

test('验收包带上 schema 原文与「裸 JSON 对象」要求', async () => {
  await withStore(async ({ call }) => {
    await seedTask(call)
    const response = await call('/api/acceptance.package', { method: 'POST', body: { taskId: 't1' } })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type'), /text\/markdown/)
    const text = await response.text()
    assert.match(text, /evaluations/)
    assert.match(text, /evidence/)
    assert.match(text, /裸 JSON 对象/)
    assert.match(text, /不能为空 —— 原始需求是这张凭证存在的理由|原始需求/)
  })
})

test('导入合法一轮（含证据）→ 证据落库、状态变 pass', async () => {
  await withStore(async ({ call }) => {
    await seedTask(call)
    const imported = await readJson(
      await call('/api/acceptance.import', {
        method: 'POST',
        body: {
          taskId: 't1',
          payload: {
            evaluations: [{ criterionId: 'AC-01', status: 'pass', evidenceIds: ['EV-0001'] }],
            evidence: [
              {
                evidenceId: 'EV-0001',
                criterionId: 'AC-01',
                round: 1,
                kind: 'command',
                capturedAt: '2026-10-10T01:00:00.000Z',
                text: 'health 路由返回 200',
                exitCode: 0,
                ref: {
                  type: 'command',
                  locator: "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3099/api/acceptance.health",
                },
              },
            ],
          },
        },
      }),
    )
    assert.equal(imported.status, 200, JSON.stringify(imported.body))
    assert.equal(imported.body.receipt.rounds.length, 1)
    assert.equal(imported.body.receipt.rounds[0].round, 1)
    assert.equal(imported.body.receipt.rounds[0].kind, 'verify')
    assert.equal(imported.body.receipt.rounds[0].producedBy, 'pasted')
    // 模式 B 的证据必须真的落进 receipt.evidence —— 否则 evidenceIds 指不到东西，整轮会被拒，
    // 于是「保底通道」永远记不了「通过」。
    assert.equal(imported.body.receipt.evidence.length, 1)
    assert.equal(imported.body.receipt.evidence[0].evidenceId, 'EV-0001')

    const fetched = await readJson(await call('/api/acceptance.receipt', { query: { taskId: 't1' } }))
    assert.deepEqual(fetched.body.derived.statuses, { 'AC-01': 'pass' })
    assert.equal(fetched.body.derived.counts.pass, 1)
  })
})

test('模式 B 也拒绝「没有证据的通过」——与模式 A 同一条硬规则', async () => {
  await withStore(async ({ call }) => {
    await seedTask(call)
    const response = await readJson(
      await call('/api/acceptance.import', {
        method: 'POST',
        body: { taskId: 't1', payload: { evaluations: [{ criterionId: 'AC-01', status: 'pass' }] } },
      }),
    )
    assert.equal(response.status, 400, JSON.stringify(response.body))
    assert.match(response.body.errors.join(' | '), /没有任何证据/)
    const fetched = await readJson(await call('/api/acceptance.receipt', { query: { taskId: 't1' } }))
    assert.deepEqual(fetched.body.receipt.rounds, [])
    assert.deepEqual(fetched.body.receipt.evidence, [])
  })
})

test('模式 B 的证据要过同一套校验：形态 / 轮次 / 唯一性', async () => {
  await withStore(async ({ call }) => {
    await seedTask(call)
    const good = {
      evidenceId: 'EV-0001',
      criterionId: 'AC-01',
      round: 1,
      kind: 'command',
      capturedAt: '2026-10-10T01:00:00.000Z',
      text: 'health 路由返回 200',
      exitCode: 0,
      ref: { type: 'command', locator: 'curl -s http://127.0.0.1:3099/api/acceptance.health' },
    }
    const evaluations = [{ criterionId: 'AC-01', status: 'pass', evidenceIds: ['EV-0001'] }]
    const cases = [
      [{ ...good, exitCode: undefined }, /exitCode/],
      [{ ...good, round: 2 }, /round 应写 1/],
      [{ ...good, ref: { type: 'file', locator: '/tmp/x:1' } }, /ref\.type/],
    ]
    for (const [evidence, pattern] of cases) {
      const response = await readJson(
        await call('/api/acceptance.import', {
          method: 'POST',
          body: { taskId: 't1', payload: { evaluations, evidence: [evidence] } },
        }),
      )
      assert.equal(response.status, 400, `期望 400：${JSON.stringify(evidence)}`)
      assert.match(response.body.errors.join(' | '), pattern)
    }
    const duplicated = await readJson(
      await call('/api/acceptance.import', {
        method: 'POST',
        body: { taskId: 't1', payload: { evaluations, evidence: [good, good] } },
      }),
    )
    assert.equal(duplicated.status, 400, JSON.stringify(duplicated.body))
    assert.match(duplicated.body.errors.join(' | '), /已经用过/)

    // 全部被拒 ⇒ 一轮也没落，一条证据也没落
    const after = await readJson(await call('/api/acceptance.receipt', { query: { taskId: 't1' } }))
    assert.deepEqual(after.body.receipt.rounds, [])
    assert.deepEqual(after.body.receipt.evidence, [])
  })
})

test('导入的 payload 允许是 JSON 字符串', async () => {
  await withStore(async ({ call }) => {
    await seedTask(call)
    const imported = await readJson(
      await call('/api/acceptance.import', {
        method: 'POST',
        body: {
          taskId: 't1',
          payload: JSON.stringify({ evaluations: [{ criterionId: 'AC-01', status: 'unknown' }] }),
        },
      }),
    )
    assert.equal(imported.status, 200, JSON.stringify(imported.body))
    assert.equal(imported.body.receipt.rounds[0].evaluations[0].status, 'unknown')
  })
})

test('导入被拒的三种形态：非法状态 / 指向不存在的项 / fail 无复现步骤', async () => {
  await withStore(async ({ call }) => {
    await seedTask(call)
    const cases = [
      [{ criterionId: 'AC-01', status: 'done' }, /status 必须是/],
      [{ criterionId: 'AC-99', status: 'pass' }, /不存在的验收项/],
      [{ criterionId: 'AC-01', status: 'fail' }, /复现步骤/],
    ]
    for (const [evaluation, pattern] of cases) {
      const response = await readJson(
        await call('/api/acceptance.import', {
          method: 'POST',
          body: { taskId: 't1', payload: { evaluations: [evaluation] } },
        }),
      )
      assert.equal(response.status, 400, `期望 400：${JSON.stringify(evaluation)}`)
      assert.match(response.body.errors.join(' | '), pattern)
    }
    // 三次都被拒 ⇒ 一轮也没落进去
    const fetched = await readJson(await call('/api/acceptance.receipt', { query: { taskId: 't1' } }))
    assert.deepEqual(fetched.body.receipt.rounds, [])
  })
})

test('导入时 payload 是坏 JSON 字符串 ⇒ 400 不是 500', async () => {
  await withStore(async ({ call }) => {
    await seedTask(call)
    const response = await readJson(
      await call('/api/acceptance.import', {
        method: 'POST',
        body: { taskId: 't1', payload: '{ not json' },
      }),
    )
    assert.equal(response.status, 400, '坏 payload 必须是客户端错误，不能算服务端故障')
    assert.equal(response.body.ok, false)
  })
})

test('请求体不是合法 JSON ⇒ 400', async () => {
  await withStore(async ({ call }) => {
    const response = await readJson(
      await call('/api/acceptance.tasks', { method: 'POST', body: '{"taskId":' }),
    )
    assert.equal(response.status, 400)
    assert.match(response.body.error, /不是合法 JSON/)
  })
})

// ---------------------------------------------------------------------------
// 用户决定与导出
// ---------------------------------------------------------------------------

test('用户决定记下当时的五态计数，且它是记录不是分数', async () => {
  await withStore(async ({ call }) => {
    await seedTask(call)
    // 「通过」必须带证据（L0 §10 第 2 条，模式 A / B 同规矩），所以这里不能只写一个 status。
    await call('/api/acceptance.import', {
      method: 'POST',
      body: {
        taskId: 't1',
        payload: {
          evaluations: [{ criterionId: 'AC-01', status: 'pass', evidenceIds: ['EV-0001'] }],
          evidence: [
            {
              evidenceId: 'EV-0001',
              criterionId: 'AC-01',
              round: 1,
              kind: 'command',
              capturedAt: '2026-10-10T01:00:00.000Z',
              text: '命令通过',
              exitCode: 0,
              ref: { type: 'command', locator: 'node --test' },
            },
          ],
        },
      },
    })
    const decided = await readJson(
      await call('/api/acceptance.decision', {
        method: 'POST',
        body: { taskId: 't1', decision: 'accept', note: '可以了' },
      }),
    )
    assert.equal(decided.status, 200)
    assert.equal(decided.body.receipt.decision.value, 'accept')
    assert.equal(decided.body.receipt.decision.note, '可以了')
    assert.deepEqual(decided.body.receipt.decision.countsAtDecision, {
      pending: 0,
      pass: 1,
      fail: 0,
      unknown: 0,
      blocked: 0,
    })

    const empty = await readJson(
      await call('/api/acceptance.decision', { method: 'POST', body: { taskId: 't1', decision: '' } }),
    )
    assert.equal(empty.status, 400)
  })
})

test('导出的 Markdown 有「本轮未复查 / 版本未知」，且没有折算词', async () => {
  await withStore(async ({ call }) => {
    await seedTask(call)
    await call('/api/acceptance.criteria', {
      method: 'POST',
      body: { taskId: 't1', ops: [{ op: 'add', criterion: { title: '第二条' } }] },
    })
    // 只复查 AC-01 ⇒ AC-02 应被标成「本轮未复查」
    await call('/api/acceptance.import', {
      method: 'POST',
      body: {
        taskId: 't1',
        payload: {
          evaluations: [{ criterionId: 'AC-01', status: 'pass', evidenceIds: ['EV-0001'] }],
          evidence: [
            {
              evidenceId: 'EV-0001',
              criterionId: 'AC-01',
              round: 1,
              kind: 'command',
              capturedAt: '2026-10-10T01:00:00.000Z',
              text: '命令通过',
              exitCode: 0,
              ref: { type: 'command', locator: 'node --test' },
            },
          ],
        },
      },
    })

    const response = await call('/api/acceptance.export', { query: { taskId: 't1', format: 'md' } })
    assert.equal(response.status, 200)
    const text = await response.text()
    assert.match(text, /本轮未复查/)
    assert.match(text, /版本未知/)
    assert.match(text, /原始需求：点导出要出 CSV/)
    for (const forbidden of ['通过率', '完成率', '健康度', '质量分', 'score', 'passRate', 'completion']) {
      assert.ok(!text.includes(forbidden), `导出里出现了折算词 ${forbidden}`)
    }
  })
})

test('不支持的导出格式被拒', async () => {
  await withStore(async ({ call }) => {
    await seedTask(call)
    const response = await readJson(
      await call('/api/acceptance.export', { query: { taskId: 't1', format: 'pdf' } }),
    )
    assert.equal(response.status, 400)
    assert.match(response.body.error, /不支持的导出格式/)
  })
})

// ---------------------------------------------------------------------------
// 三种「空变更范围」必须说成三句不同的话（L0 §10 第 10 条）
// ---------------------------------------------------------------------------

test('三种空变更范围各自标出成因', async () => {
  const noSession = await mkdtemp(join(tmpdir(), 'dsh-acc-a-'))
  const noTurn = await mkdtemp(join(tmpdir(), 'dsh-acc-b-'))
  const noSummary = await mkdtemp(join(tmpdir(), 'dsh-acc-c-'))
  try {
    const read = async (root, sessions) => {
      const { registered, ctx } = mount({ sessions })
      apply(ctx, { dataRoot: root })
      const call = makeCall(registered)
      const response = await readJson(
        await call('/api/acceptance.tasks', {
          method: 'POST',
          body: { taskId: 'x', requirementText: 'r' },
          query: { sessionId: 's1' },
        }),
      )
      return response.body.receipt.scope.changedFilesSource
    }

    // 1) 完全不传 sessionId
    const a = await read(noSession, undefined)
    // 2) 有会话，但父会话里没有 workspace/changes 事件
    const b = await read(noTurn, { get: () => ({ events: [] }) })
    // 3) 有事件，但摘要服务缺席（宿主重启后摘要只在内存里）
    const c = await read(noSummary, {
      get: () => ({ events: [{ type: 'workspace/changes', seq: 3 }] }),
    })

    assert.equal(a, 'no-session')
    assert.equal(b, 'no-turn-recorded')
    assert.equal(c, 'summary-unavailable')
    assert.equal(new Set([a, b, c]).size, 3)
  } finally {
    await Promise.all([noSession, noTurn, noSummary].map((dir) => rm(dir, { recursive: true, force: true })))
  }
})

test('taskId 非法时 store 直接抛，路由把它变成 500 而不是静默清洗', async () => {
  await withStore(async ({ call }) => {
    const response = await readJson(await call('/api/acceptance.receipt', { query: { taskId: '../escape' } }))
    assert.equal(response.body.ok, false)
    assert.ok([400, 500].includes(response.status), `状态码应是 4xx/5xx，实为 ${response.status}`)
    assert.match(response.body.error, /taskId/)
  })
})

// ---------------------------------------------------------------------------
// 模式 A：委派（SDD §5）
//
// 承诺点（`runtime.start()` 那一行）之前失败 ⇒ 4xx 且**不写轮次**；
// 之后失败 ⇒ 写一轮 `blocked`。这条规则靠下面两组用例钉住。
// ---------------------------------------------------------------------------

test('模式 A：承诺之前失败一律 4xx，且一条轮次都不留', async () => {
  const noRuntime = fakeSubagents({})
  await withStore(
    async ({ call }) => {
      await seedTask(call, 't1')
      const response = await readJson(
        await call('/api/acceptance.verify', { method: 'POST', query: { taskId: 't1' }, body: { sessionId: 'live' } }),
      )
      assert.equal(response.status, 400)
      assert.match(response.body.error, /subagents/)
      const read = await readJson(await call('/api/acceptance.receipt', { query: { taskId: 't1' } }))
      assert.equal(read.body.receipt.rounds.length, 0, '承诺之前失败不该在凭证里留下轮次')
    },
    { subagents: undefined, agents: liveAgents },
  )
  assert.equal(noRuntime.calls.length, 0)
})

test('模式 A：会话没有活着的 Agent ⇒ 409，且提示可照做的下一步', async () => {
  const subagents = fakeSubagents({ result: { structured: { criteria: [] } } })
  await withStore(
    async ({ call }) => {
      await seedTask(call, 't1')
      const response = await readJson(
        await call('/api/acceptance.verify', {
          method: 'POST',
          query: { taskId: 't1' },
          body: { sessionId: 'dead-after-restart' },
        }),
      )
      assert.equal(response.status, 409)
      assert.match(response.body.error, /没有活着的 Agent/)
      assert.match(response.body.error, /模式 B/, '必须告诉用户还有模式 B 可走')
      assert.equal(subagents.calls.length, 0)
    },
    { subagents, agents: liveAgents },
  )
})

test('模式 A：provider 不存在 ⇒ 400 并列出可用的', async () => {
  const subagents = fakeSubagents({ result: { structured: { criteria: [] } }, providers: ['spawn', 'fork'] })
  await withStore(
    async ({ call }) => {
      await seedTask(call, 't1')
      const response = await readJson(
        await call('/api/acceptance.verify', {
          method: 'POST',
          query: { taskId: 't1' },
          body: { sessionId: 'live', provider: 'acp' },
        }),
      )
      assert.equal(response.status, 400)
      assert.match(response.body.error, /spawn, fork/)
      assert.equal(subagents.calls.length, 0)
    },
    { subagents, agents: liveAgents },
  )
})

test('模式 A：委派成功 ⇒ 追加一轮，证据 id 与 round 由宿主分配', async () => {
  const subagents = fakeSubagents({
    result: {
      stopReason: 'end-turn',
      structured: {
        criteria: [
          {
            id: 'AC-01',
            status: 'pass',
            evidence: [
              {
                kind: 'command',
                text: '导出目录下出现了 report.csv',
                locator: 'npm run export -- --out report.csv',
                exitCode: 0,
              },
            ],
          },
        ],
      },
    },
  })
  await withStore(
    async ({ call }) => {
      await seedTask(call, 't1')
      const response = await readJson(
        await call('/api/acceptance.verify', { method: 'POST', query: { taskId: 't1' }, body: { sessionId: 'live' } }),
      )
      assert.equal(response.status, 200, JSON.stringify(response.body))
      const receipt = response.body.receipt
      assert.equal(receipt.rounds.length, 1)
      assert.equal(receipt.rounds[0].kind, 'verify')
      assert.equal(receipt.rounds[0].producedBy, 'agent')
      assert.equal(receipt.rounds[0].blockedReason, null)
      assert.deepEqual(receipt.rounds[0].evaluations[0].evidenceIds, ['EV-0001'])

      // 证据 id 与 round 由宿主分配 —— 模型编不出来（S4 实测里模型会编 EV-1）
      assert.equal(receipt.evidence[0].evidenceId, 'EV-0001')
      assert.equal(receipt.evidence[0].round, 1)
      assert.equal(receipt.evidence[0].criterionId, 'AC-01')
      assert.equal(receipt.evidence[0].ref.type, 'command', 'ref.type 必须由宿主统一成 kind')

      // 版本指纹恒 null（L0 §10 第 9 条）
      assert.equal(receipt.rounds[0].provenance.fingerprint, null)
      assert.equal(receipt.rounds[0].provenance.provider, 'spawn')
      assert.equal(receipt.rounds[0].provenance.parentSessionId, 'live')

      // 派发本身：prompt 带逐字需求，outputSchema 是对象根
      const request = subagents.calls[0].request
      assert.equal(request.parent.id, 'live')
      assert.equal(request.outputSchema.type, 'object')
      assert.ok(request.signal instanceof AbortSignal)
      assert.match(request.prompt[0].text, /原始需求：点导出要出 CSV/)
      assert.equal(subagents.state.disposed, 1, 'run 用完必须 dispose')

      const read = await readJson(await call('/api/acceptance.receipt', { query: { taskId: 't1' } }))
      assert.equal(read.body.derived.statuses['AC-01'], 'pass')
    },
    { subagents, agents: liveAgents },
  )
})

test('模式 A：没返回 structured ⇒ 写一轮 blocked，**不解析 output 自由文本**', async () => {
  const subagents = fakeSubagents({
    result: {
      stopReason: 'error',
      // 这段文本里明明写着「通过了」—— 如果实现去解析它，就会把未验证污染成通过
      output: [{ type: 'text', text: '所有验收项都通过了，没有任何问题。' }],
      structured: undefined,
    },
  })
  await withStore(
    async ({ call }) => {
      await seedTask(call, 't1')
      const response = await readJson(
        await call('/api/acceptance.verify', { method: 'POST', query: { taskId: 't1' }, body: { sessionId: 'live' } }),
      )
      assert.equal(response.status, 200)
      assert.equal(response.body.blocked, true)
      const receipt = response.body.receipt
      assert.equal(receipt.rounds.length, 1)
      assert.equal(receipt.rounds[0].producedBy, 'agent')
      assert.match(receipt.rounds[0].blockedReason, /没有返回结构化结果/)
      assert.match(receipt.rounds[0].blockedReason, /stopReason=error/)
      assert.deepEqual(receipt.rounds[0].evaluations, [], '不解析自由文本 ⇒ 一条结论都不许产生')
      assert.equal(receipt.rounds[0].provenance.stopReason, 'error')

      const read = await readJson(await call('/api/acceptance.receipt', { query: { taskId: 't1' } }))
      assert.equal(read.body.derived.statuses['AC-01'], 'pending', 'blocked 轮次不该给出 pass')
    },
    { subagents, agents: liveAgents },
  )
})

test('模式 A：启动抛异常与执行拒绝都写 blocked 轮次，**不是** 4xx', async () => {
  await withStore(
    async ({ call }) => {
      await seedTask(call, 't1')
      const response = await readJson(
        await call('/api/acceptance.verify', { method: 'POST', query: { taskId: 't1' }, body: { sessionId: 'live' } }),
      )
      assert.equal(response.status, 200, '承诺之后的失败必须写成凭证里的轮次，不能只是转瞬即逝的报错')
      assert.equal(response.body.blocked, true)
      assert.match(response.body.receipt.rounds[0].blockedReason, /委派启动失败/)
      assert.equal(response.body.receipt.rounds[0].provenance.phase, 'start')
    },
    { subagents: fakeSubagents({ startError: 'unsupported JSON schema' }), agents: liveAgents },
  )

  await withStore(
    async ({ call }) => {
      await seedTask(call, 't1')
      const response = await readJson(
        await call('/api/acceptance.verify', { method: 'POST', query: { taskId: 't1' }, body: { sessionId: 'live' } }),
      )
      assert.equal(response.status, 200)
      assert.match(response.body.receipt.rounds[0].blockedReason, /委派执行失败/)
      assert.equal(response.body.receipt.rounds[0].provenance.phase, 'run')
    },
    { subagents: fakeSubagents({ resultError: 'child crashed' }), agents: liveAgents },
  )
})

test('模式 A：pass 没有证据 / fail 没有复现步骤 ⇒ 整轮 blocked，一条结论都不写入', async () => {
  for (const [structured, expected] of [
    [{ criteria: [{ id: 'AC-01', status: 'pass', evidence: [] }] }, /一条可寻址的证据都没有/],
    [
      {
        criteria: [
          {
            id: 'AC-01',
            status: 'fail',
            evidence: [{ kind: 'file', text: '函数不存在', locator: '/tmp/export.js:1' }],
          },
        ],
      },
      /没写复现步骤/,
    ],
  ]) {
    await withStore(
      async ({ call }) => {
        await seedTask(call, 't1')
        const response = await readJson(
          await call('/api/acceptance.verify', {
            method: 'POST',
            query: { taskId: 't1' },
            body: { sessionId: 'live' },
          }),
        )
        assert.equal(response.status, 200)
        assert.equal(response.body.blocked, true)
        assert.match(response.body.receipt.rounds[0].blockedReason, expected)
        assert.deepEqual(response.body.receipt.rounds[0].evaluations, [], '不部分写入')
        assert.deepEqual(response.body.receipt.evidence, [], '被拒的证据不留在凭证里')
      },
      { subagents: fakeSubagents({ result: { stopReason: 'end-turn', structured } }), agents: liveAgents },
    )
  }
})

test('模式 A：漏项显式落成 unknown 并注明原因 —— 沉默不等于通过', async () => {
  const subagents = fakeSubagents({ result: { stopReason: 'end-turn', structured: { criteria: [] } } })
  await withStore(
    async ({ call }) => {
      await seedTask(call, 't1')
      const response = await readJson(
        await call('/api/acceptance.verify', { method: 'POST', query: { taskId: 't1' }, body: { sessionId: 'live' } }),
      )
      assert.equal(response.status, 200)
      assert.equal(response.body.blocked, undefined, '漏项不是契约违规，仍是有效一轮')
      const evaluation = response.body.receipt.rounds[0].evaluations[0]
      assert.equal(evaluation.criterionId, 'AC-01')
      assert.equal(evaluation.status, 'unknown')
      assert.match(evaluation.note, /没有这一项的结论/)
      assert.deepEqual(evaluation.evidenceIds, [])
    },
    { subagents, agents: liveAgents },
  )
})
