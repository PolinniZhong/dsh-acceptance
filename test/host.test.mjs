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
  const registeredTools = new Map()
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
      // `tools` 服务：真的收下注册的工具，工具层的用例才调得到（v0.2.0）。
      if (names.includes('tools')) {
        scoped.tools = {
          register(tool) {
            if (registeredTools.has(tool.name)) throw new Error(`同一个工具注册了两次：${tool.name}`)
            registeredTools.set(tool.name, tool)
          },
        }
      }
      callback(scoped)
    },
  }
  return { registered, registeredTools, ctx }
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
    // 形状照抄**真机**：`startActivation({ provider, label, delivery, signal, request })`
    // ⇒ `{ childId, result, dispose }`（`dsh-subagent/lib/index.js:3032` / `:2081`）。
    // 旧用例这里写的是 `start(provider, request)` ⇒ `{ id, result, dispose }` —— 那是**不存在**的 API，
    // 而假运行时让所有用例照常通过。改成本形状之后，任何调用方退回旧写法都会立刻红。
    async startActivation(spec) {
      calls.push(spec)
      if (startError) throw new Error(startError)
      return {
        childId: 'child-session-1',
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
    const { registered, registeredTools, ctx } = mount(options)
    apply(ctx, { dataRoot: root })
    await run({ registered, registeredTools, call: makeCall(registered), root })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

/** 调一个已注册的模型可调用工具。`exec` 缺省就是「有活着的 Agent」的正常情形。 */
async function callTool(registeredTools, toolName, args, exec = { agent: { id: 'live', session: { id: 'live' } } }) {
  const tool = registeredTools.get(toolName)
  assert.ok(tool, `没有注册工具 ${toolName}`)
  return tool.execute(args, exec)
}

async function readJson(response) {
  return { status: response.status, body: await response.json() }
}

/** 建一个含 AC-01 的任务，省掉每个用例的重复。 */
async function seedTask(call, taskId = 't1', { confirm = true } = {}) {
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
  // P0-3（2026-10-12）：**未确认的范围不是契约**，取证路径只对已确认项工作。
  // 所以「一个可以取证的任务」必须包含「用户确认过验收项」这一步 —— 种子要如实模拟它，
  // 否则所有委派用例都会撞在 `no-confirmed-criteria` 上（那不是用例坏了，是种子少了真实的一步）。
  // `{ confirm: false }` 给「专门测确认这件事本身」的用例用。
  if (confirm) await confirmCriteria(call, taskId, ['AC-01'])
  return taskId
}

/** 模拟「用户在验收台点确认」。确认权只属于人，测试里由这一步代劳。 */
async function confirmCriteria(call, taskId, ids) {
  const confirmed = await readJson(
    await call('/api/acceptance.criteria', {
      method: 'POST',
      body: { taskId, ops: ids.map((id) => ({ op: 'confirm', id })) },
    }),
  )
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body))
  return confirmed
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

test('health 报出「现在有没有委派能力」—— 界面靠它在**动作之前**说明原因（v0.1.2 §5.4）', async () => {
  // 没有 subagents 服务 ⇒ delegate=false（界面据此禁用主入口并给出替代路径）
  await withStore(async ({ call }) => {
    const { status, body } = await readJson(await call('/api/acceptance.health'))
    assert.equal(status, 200)
    assert.deepEqual(body.capabilities, { delegate: false })
  })
  // 有 subagents 服务 ⇒ delegate=true。⚠️ 它**不是保证**：能不能真跑仍由承诺点之前的 4xx 决定。
  await withStore(
    async ({ call }) => {
      const { body } = await readJson(await call('/api/acceptance.health'))
      assert.deepEqual(body.capabilities, { delegate: true })
    },
    { subagents: { list: () => [], start: async () => ({}) } },
  )
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
    await seedTask(call, 't1', { confirm: false })

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

// ---------------------------------------------------------------------------
// 工具层（SDD §14）—— 开发 Agent 主动登记 / 提交 / 取回结论
// ---------------------------------------------------------------------------

test('工具层：三个工具都注册上了，且名字与声明的常量一致', async () => {
  const { TOOL_NAMES } = await import('../src/dsh/host/tools.js')
  await withStore(async ({ registeredTools }) => {
    for (const toolName of TOOL_NAMES) {
      assert.ok(registeredTools.has(toolName), `没注册 ${toolName}`)
    }
    assert.equal(registeredTools.size, TOOL_NAMES.length, '多注册了未登记的工具')
  }, { agents: liveAgents })
})

test('工具层：begin_task 登记原始需求与未确认的验收项，**不替用户确认**', async () => {
  await withStore(
    async ({ registeredTools, call }) => {
      const result = await callTool(registeredTools, 'acceptance_begin_task', {
        requirementText: '原始需求：点导出要出 CSV',
        taskTitle: '导出 CSV',
        criteria: [
          { title: '能导出 CSV', origin: 'original', expected: '点击导出后下载到 .csv 文件' },
          { title: '导出按钮有加载态', origin: 'suggested' },
        ],
      })
      assert.equal(result.ok, true, JSON.stringify(result))
      assert.equal(result.criteriaCount, 2)
      assert.equal(result.originalCount, 1)
      assert.equal(result.suggestedCount, 1)

      // 原始需求逐字保存；验收项一律**未确认** —— 确认权在用户（SDD §2.2、PRD §4 第 2 步）。
      const read = await readJson(await call('/api/acceptance.receipt', { query: { taskId: result.taskId } }))
      const receipt = read.body.receipt
      assert.equal(receipt.requirementText, '原始需求：点导出要出 CSV')
      assert.equal(receipt.criteria.length, 2)
      assert.equal(receipt.criteria[0].origin, 'original')
      assert.equal(receipt.criteria[1].origin, 'suggested')
      for (const criterion of receipt.criteria) {
        assert.equal(criterion.confirmedByUserAt, null, `${criterion.id} 被 Agent 自动确认了`)
      }
      assert.deepEqual(receipt.rounds, [], '登记需求不该产生轮次')
    },
    { agents: liveAgents },
  )
})

test('工具层：begin_task 没有 Agent 上下文 ⇒ 回信封，**不抛**（守卫 G20）', async () => {
  await withStore(
    async ({ registeredTools }) => {
      const tool = registeredTools.get('acceptance_begin_task')
      const result = await tool.execute({ requirementText: 'x' }, {})
      assert.equal(result.ok, false)
      assert.equal(result.reason, 'no-agent')
    },
    { agents: liveAgents },
  )
})

test('工具层：requirementText 为空 ⇒ 拒绝（没有原始需求就没有验收契约）', async () => {
  await withStore(
    async ({ registeredTools }) => {
      const result = await callTool(registeredTools, 'acceptance_begin_task', { requirementText: '   ' })
      assert.equal(result.ok, false)
      assert.equal(result.reason, 'invalid-requirement')
    },
    { agents: liveAgents },
  )
})

test('工具层：参数 schema 里**不许**出现 sessionId / workspace / cwd（守卫 G14）', async () => {
  await withStore(
    async ({ registeredTools }) => {
      for (const [toolName, tool] of registeredTools) {
        const json = JSON.stringify(tool.parameters ?? {})
        for (const forbidden of ['sessionId', 'workspace', 'cwd']) {
          assert.ok(!json.includes(forbidden), `${toolName} 的参数里出现了 ${forbidden} —— 身份只能由宿主解析`)
        }
      }
    },
    { agents: liveAgents },
  )
})

test('工具层：submit_delivery 在验收项未确认时拒绝取证 —— 未确认的范围不是契约', async () => {
  let called = 0
  const subagents = fakeSubagents({ result: { stopReason: 'end-turn', structured: { criteria: [] } } })
  await withStore(
    async ({ registeredTools }) => {
      const begun = await callTool(registeredTools, 'acceptance_begin_task', {
        requirementText: '原始需求：点导出要出 CSV',
        criteria: [{ title: '能导出 CSV', origin: 'original' }],
      })
      const submitted = await callTool(registeredTools, 'acceptance_submit_delivery', { taskId: begun.taskId })
      assert.equal(submitted.ok, false)
      assert.equal(submitted.reason, 'criteria-not-confirmed')
      called += 1
    },
    { subagents, agents: liveAgents },
  )
  assert.equal(called, 1)
  assert.equal(subagents.calls.length, 0, '未确认的契约不该触发任何委派')
})

test('工具层：登记 → 确认 → 提交 ⇒ 委派一次并逐条回传结论', async () => {
  const structured = {
    criteria: [
      {
        id: 'AC-01',
        status: 'pass',
        evidence: [
          {
            kind: 'command',
            text: '跑导出命令',
            locator: 'node -e "require(\'./export.js\')"',
            exitCode: 0,
          },
        ],
      },
    ],
  }
  const subagents = fakeSubagents({ result: { stopReason: 'end-turn', structured } })
  await withStore(
    async ({ registeredTools, call }) => {
      const begun = await callTool(registeredTools, 'acceptance_begin_task', {
        requirementText: '原始需求：点导出要出 CSV',
        criteria: [{ title: '能导出 CSV', origin: 'original', expected: '导出出 .csv' }],
      })
      const confirmed = await readJson(
        await call('/api/acceptance.criteria', {
          method: 'POST',
          body: { taskId: begun.taskId, ops: [{ op: 'confirm', id: 'AC-01' }] },
        }),
      )
      assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body))

      const submitted = await callTool(registeredTools, 'acceptance_submit_delivery', {
        taskId: begun.taskId,
        summary: '写了导出函数',
        commandsRun: [{ command: 'node -e "..."', exitCode: 0 }],
      })
      assert.equal(submitted.ok, true, JSON.stringify(submitted))
      assert.equal(submitted.runStatus, 'succeeded')
      assert.equal(submitted.criteria.length, 1)
      assert.equal(submitted.criteria[0].status, 'pass')
      assert.equal(submitted.criteria[0].evidenceIds.length, 1, '结论必须带宿主分配的 evidenceId')
      // 声明只是线索：它不产生验收项状态，也不进 evidence。
      assert.equal(subagents.calls.length, 1)
    },
    { subagents, agents: liveAgents },
  )
})

test('工具层：get_result 是只读的 —— 调它不产生轮次、不改凭证', async () => {
  const subagents = fakeSubagents({ result: { stopReason: 'end-turn', structured: { criteria: [] } } })
  await withStore(
    async ({ registeredTools }) => {
      const begun = await callTool(registeredTools, 'acceptance_begin_task', {
        requirementText: '原始需求：点导出要出 CSV',
        criteria: [{ title: '能导出 CSV', origin: 'original' }],
      })
      const first = await callTool(registeredTools, 'acceptance_get_result', { taskId: begun.taskId })
      const second = await callTool(registeredTools, 'acceptance_get_result', { taskId: begun.taskId })
      assert.equal(first.ok, true)
      assert.equal(first.round, 0)
      assert.deepEqual(first, second, '两次取回必须完全相同 —— 只读就是不产生任何东西')
      assert.equal(subagents.calls.length, 0)
    },
    { subagents, agents: liveAgents },
  )
})

test('工具层：取不存在的任务 ⇒ 回信封而不是抛（守卫 G20）', async () => {
  await withStore(
    async ({ registeredTools }) => {
      // 格式合法但不存在 ⇒ no-such-task；格式非法 ⇒ invalid-task-id（不许说成 internal-error）。
      const missing = await callTool(registeredTools, 'acceptance_get_result', { taskId: 'no-such-task' })
      assert.equal(missing.ok, false)
      assert.equal(missing.reason, 'no-such-task')

      const malformed = await callTool(registeredTools, 'acceptance_get_result', { taskId: '没有这个任务' })
      assert.equal(malformed.ok, false)
      assert.equal(malformed.reason, 'invalid-task-id')

      const empty = await callTool(registeredTools, 'acceptance_get_result', {})
      assert.equal(empty.ok, false)
      assert.equal(empty.reason, 'invalid-task-id')
    },
    { agents: liveAgents },
  )
})

test('模式 A：服务在但没有可编程委派入口 ⇒ 说成「宿主不可委派」，不是「没有服务」', async () => {
  // 2026-10-12 真机踩到：headless 的 subagents 服务对象存在、`list()` 有 provider，
  // 就是没有 `start`。旧消息写成「没有 subagents 服务」—— 把「不提供该 API」说成「服务不存在」，
  // 排查时会照着错方向找。三种成因必须是三句不同的话。
  const noStart = { list: () => ['spawn', 'fork'] }
  await withStore(
    async ({ call }) => {
      await seedTask(call, 't1')
      const response = await readJson(
        await call('/api/acceptance.verify', { method: 'POST', query: { taskId: 't1' }, body: { sessionId: 'live' } }),
      )
      assert.equal(response.status, 400)
      assert.match(response.body.error, /服务在/, '必须说清服务本身在，缺的是委派入口')
      assert.match(response.body.error, /start/)
      assert.match(response.body.error, /spawn/)
    },
    { subagents: noStart, agents: liveAgents },
  )
})

test('工具层：没有 subagents 服务时提交 ⇒ 回信封（承诺点之前，不写轮次）', async () => {
  await withStore(
    async ({ registeredTools, call }) => {
      const begun = await callTool(registeredTools, 'acceptance_begin_task', {
        requirementText: '需求',
        criteria: [{ title: '一条', origin: 'original' }],
      })
      await call('/api/acceptance.criteria', {
        method: 'POST',
        body: { taskId: begun.taskId, ops: [{ op: 'confirm', id: 'AC-01' }] },
      })
      const submitted = await callTool(registeredTools, 'acceptance_submit_delivery', { taskId: begun.taskId })
      assert.equal(submitted.ok, false)
      assert.equal(submitted.reason, 'no-delegation-api')
      const receipt = await readJson(await call('/api/acceptance.receipt', { query: { taskId: begun.taskId } }))
      assert.equal(receipt.body.receipt.rounds.length, 0, '承诺点之前失败不许留轮次')
    },
    { agents: liveAgents },
  )
})

test('工具层 / S6a：工具上下文里的 exec.agent 就是签发给子 Agent 的 parent，且落轮次带证据', async () => {
  // 这条钉的是 S6a 在**本进程内**可验的那一半：委派拿到的 `parent` 必须来自
  // `exec.agent`（工具上下文里唯一可信的身份来源），而不是按 sessionId 去注册表里另查一个
  // —— 后者在真机上仍可能查到**别的**会话，把结论记到错的凭证上。
  const structured = {
    criteria: [
      {
        id: 'AC-01',
        status: 'pass',
        evidence: [
          { kind: 'file', text: '导出行', locator: '/tmp/export.js:12' },
        ],
      },
    ],
  }
  const subagents = fakeSubagents({ result: { stopReason: 'end-turn', structured } })
  const toolAgent = { id: 'tool-agent', session: { id: 'live' } }
  await withStore(
    async ({ registeredTools, call }) => {
      const begun = await callTool(registeredTools, 'acceptance_begin_task', {
        requirementText: '原始需求：点导出要出 CSV',
        criteria: [{ title: '能导出 CSV', origin: 'original' }],
      })
      await call('/api/acceptance.criteria', {
        method: 'POST',
        body: { taskId: begun.taskId, ops: [{ op: 'confirm', id: 'AC-01' }] },
      })
      const submitted = await callTool(
        registeredTools,
        'acceptance_submit_delivery',
        { taskId: begun.taskId, summary: '写了导出函数' },
        { agent: toolAgent },
      )
      assert.equal(submitted.ok, true, JSON.stringify(submitted))

      // 1) 签发出去的 `parent` 必须**恒等于** exec.agent 那个对象。
      assert.equal(subagents.calls.length, 1)
      assert.equal(subagents.calls[0].request.parent, toolAgent, 'parent 不是 exec.agent —— 身份被换成了注册表里查到的另一个')
      // 2) outputSchema 必须同时给（N1：只有宿主 API 有这个参数）。
      assert.equal(subagents.calls[0].request.outputSchema.type, 'object')
      // 3) 落下来的轮次带真实 locator 的证据，且 producedBy 是 agent。
      const read = await readJson(await call('/api/acceptance.receipt', { query: { taskId: begun.taskId } }))
      const receipt = read.body.receipt
      assert.equal(receipt.rounds.length, 1)
      assert.equal(receipt.rounds[0].producedBy, 'agent')
      assert.equal(receipt.rounds[0].provenance.fingerprint, null, '版本指纹首版恒 null')
      assert.equal(receipt.evidence.length, 1)
      assert.equal(receipt.evidence[0].ref.locator, '/tmp/export.js:12')
    },
    { subagents, agents: { get: () => undefined } },
  )
})

test('工具层 / S6a：`parent` 必须是注册表里那个**活着的**对象 —— 冒充/已销毁的必须被拒', async () => {
  // 真机规则（`dsh-subagent/lib/types/index.js:144`）逐字：
  //   subagent creation requires the exact live parent agent → 违反抛 UNAUTHORIZED
  // 即 `agents.get(parent.id) !== parent` 就拒。这条把「为什么身份只能来自 exec.agent」从**风格**变成**机制**：
  // 自己拼一个 parent、或拿一个宿主重启前就死掉的 Agent，都会**确定性失败**。
  const structured = { criteria: [{ id: 'AC-01', status: 'unknown', evidence: [], note: '查不到' }] }
  const liveAgent = { id: 'live', session: { id: 'live' } }

  // 假运行时按真机的规则判定 parent：拿注册表核对引用。
  const registry = new Map([['live', liveAgent]])
  const strictSubagents = {
    calls: [],
    list: () => ['spawn'],
    // 真机形状：`startActivation(spec)`，且 **spec.signal 必须在**（真机先 `spec.signal.throwIfAborted()`）。
    async startActivation(spec) {
      this.calls.push(spec)
      if (!spec.signal) throw new TypeError("Cannot read properties of undefined (reading 'throwIfAborted')")
      const request = spec.request
      if (registry.get(request.parent?.id) !== request.parent) {
        throw new Error('subagent creation requires the exact live parent agent')
      }
      return { childId: 'child', result: Promise.resolve({ stopReason: 'end-turn', structured }), dispose: async () => {} }
    },
  }

  const seedConfirmed = async (registeredTools, call) => {
    const begun = await callTool(registeredTools, 'acceptance_begin_task', {
      requirementText: '原始需求',
      criteria: [{ title: '一条', origin: 'original' }],
    })
    await call('/api/acceptance.criteria', {
      method: 'POST',
      body: { taskId: begun.taskId, ops: [{ op: 'confirm', id: 'AC-01' }] },
    })
    return begun.taskId
  }

  // ① 正例：exec.agent 就是注册表里那个对象 ⇒ 通过，且**落一轮**。
  await withStore(
    async ({ registeredTools, call }) => {
      const taskId = await seedConfirmed(registeredTools, call)
      const submitted = await callTool(
        registeredTools,
        'acceptance_submit_delivery',
        { taskId },
        { agent: liveAgent },
      )
      assert.equal(submitted.ok, true, JSON.stringify(submitted))
      const read = await readJson(await call('/api/acceptance.receipt', { query: { taskId } }))
      assert.equal(read.body.receipt.rounds.length, 1)
    },
    { subagents: strictSubagents, agents: { get: (id) => registry.get(id) } },
  )

  // ② 反例：冒充的 parent（同 id 但**不是**注册表里那个对象）⇒ 被拒，且按承诺点分层写一轮 blocked。
  const impostor = { id: 'live', session: { id: 'live' } }
  await withStore(
    async ({ registeredTools, call }) => {
      const taskId = await seedConfirmed(registeredTools, call)
      const submitted = await callTool(
        registeredTools,
        'acceptance_submit_delivery',
        { taskId },
        { agent: impostor },
      )
      assert.equal(submitted.ok, false, '冒充的 parent 不该成功')
      assert.equal(submitted.reason, 'blocked-round')
      const read = await readJson(await call('/api/acceptance.receipt', { query: { taskId } }))
      assert.equal(read.body.receipt.rounds.length, 1, '承诺点之后失败必须留一轮')
      assert.match(read.body.receipt.rounds[0].blockedReason, /exact live parent/)
      assert.deepEqual(read.body.receipt.rounds[0].evaluations, [], '不部分写入')
    },
    { subagents: strictSubagents, agents: { get: (id) => registry.get(id) } },
  )
})

// ---------------------------------------------------------------------------
// P0-3（2026-10-12）：两条取证路径遵守**同一条**确认规则
// ---------------------------------------------------------------------------

test('P0-3：一条 confirmed 都没有 ⇒ 不发起委派（承诺点之前 4xx，不写轮次）', async () => {
  const subagents = fakeSubagents({ result: { stopReason: 'end-turn', structured: { criteria: [] } } })
  await withStore(
    async ({ call }) => {
      // 种一个**未确认**的任务：这正是 P0-2 描述的「0 确认」状态
      await seedTask(call, 't1', { confirm: false })
      const response = await readJson(
        await call('/api/acceptance.verify', { method: 'POST', query: { taskId: 't1' }, body: { sessionId: 'live' } }),
      )
      assert.equal(response.status, 400)
      assert.match(response.body.error, /都还没确认/)
      assert.match(response.body.error, /AC-01/, '要把未确认项列出来，人一眼知道去确认什么')
      assert.equal(subagents.calls.length, 0, '一条确认都没有就不该发起委派')
      const receipt = await readJson(await call('/api/acceptance.receipt', { query: { taskId: 't1' } }))
      assert.equal(receipt.body.receipt.rounds.length, 0, '承诺点之前失败不留轮次')
    },
    { subagents, agents: liveAgents },
  )
})

test('P0-3：部分确认 ⇒ 只对已确认项取证，未确认项被跳过并写进 provenance', async () => {
  const structured = {
    criteria: [
      { id: 'AC-01', status: 'pass', evidence: [{ kind: 'file', text: 'x', locator: '/tmp/a.js:1' }] },
    ],
  }
  const subagents = fakeSubagents({ result: { stopReason: 'end-turn', structured } })
  await withStore(
    async ({ call }) => {
      await seedTask(call, 't1', { confirm: false })
      // 再加一条，然后**只确认 AC-01** —— AC-02 保持未确认
      await call('/api/acceptance.criteria', {
        method: 'POST',
        body: { taskId: 't1', ops: [{ op: 'add', criterion: { title: '第二条', origin: 'original' } }] },
      })
      await confirmCriteria(call, 't1', ['AC-01'])

      const response = await readJson(
        await call('/api/acceptance.verify', { method: 'POST', query: { taskId: 't1' }, body: { sessionId: 'live' } }),
      )
      assert.equal(response.status, 200, JSON.stringify(response.body))

      // ① 委派**只带已确认的那一条**（提示词与 schema 都收窄）
      const request = subagents.calls[0].request
      assert.ok(!JSON.stringify(request.outputSchema).includes('AC-02'), 'schema 里不该出现未确认项')
      assert.ok(!request.prompt[0].text.includes('第二条'), '提示词里不该出现未确认项')

      // ② 被跳过的项被**写下来**（不是静默）
      const round = response.body.receipt.rounds[0]
      assert.deepEqual(round.provenance.skippedUnconfirmed, ['AC-02'])

      // ③ 未确认项仍然「待验收」，**没有**因为这一轮而变成通过
      const receipt = await readJson(await call('/api/acceptance.receipt', { query: { taskId: 't1' } }))
      const criteria = receipt.body.receipt.criteria
      assert.equal(criteria.find((c) => c.id === 'AC-02').confirmedByUserAt, null, '宿主没替用户确认')
      assert.equal(receipt.body.derived.statuses['AC-02'] ?? 'pending', 'pending', '未确认项不得被当成已取证')
      assert.equal(receipt.body.derived.statuses['AC-01'], 'pass')
    },
    { subagents, agents: liveAgents },
  )
})

test('P0-3：Agent 提交路径与 UI 路径同规则 —— 一条 confirmed 都没有时两侧都拒', async () => {
  const subagents = fakeSubagents({ result: { stopReason: 'end-turn', structured: { criteria: [] } } })
  await withStore(
    async ({ call, registeredTools }) => {
      const begun = await callTool(registeredTools, 'acceptance_begin_task', {
        requirementText: '需求',
        criteria: [{ title: '一条', origin: 'original' }],
      })
      // 都不确认
      const submitted = await callTool(registeredTools, 'acceptance_submit_delivery', { taskId: begun.taskId })
      assert.equal(submitted.ok, false)
      assert.equal(submitted.reason, 'criteria-not-confirmed', 'Agent 路径拒')

      const verified = await readJson(
        await call('/api/acceptance.verify', {
          method: 'POST',
          query: { taskId: begun.taskId },
          body: { sessionId: 'live' },
        }),
      )
      assert.equal(verified.status, 400, 'UI 路径同样拒')
      assert.match(verified.body.error, /都还没确认/)
      assert.equal(subagents.calls.length, 0, '两条路径都不该发起委派')
    },
    { subagents, agents: liveAgents },
  )
})
