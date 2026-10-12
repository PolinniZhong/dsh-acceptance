/**
 * 客户端**产物**的行为测试。
 *
 * 为什么要单独测产物：源码层的守卫（G7 扫禁用词、G6 对 stamp）都看不见一类失败 ——
 * 产物被 `window.__ModuleLoader__.load` 收下之后**注册失败或渲染时抛错**。宿主侧
 * `@deepseek-ai/dsh-client-modules/lib/index.js:739` 对这种情况是硬失败：
 *
 *   client-modules: bundle <url> loaded without registering "<id>" via __ModuleLoader__.load
 *
 * 而它只在**重启 DSH、浏览器真的去加载**时才发生。所以这里把 shell 的两步动作
 * （收下 factory → 调用 apply → 渲染 tab）在本进程里原样做一遍。
 *
 * 找不到 react / react-dom 时**默认失败**（不是跳过）—— 静默跳过和「守卫没跑」长得
 * 一模一样。确实要在没有前端依赖的环境里放过它，显式设：
 *   DSH_ACCEPTANCE_SKIP_CLIENT_RENDER=1
 *
 * @module test/client-bundle
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BUNDLE = join(ROOT, 'dist/client.js')
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

/** 决定 tab 显示名的常量，L0 §1 写着它必须是「验收台」。 */
const TAB_LABEL = '验收台'
const VIEW_ID = 'acceptance'

/**
 * 加载 react / react-dom。
 *
 * 本仓库的插件以 `link:` 挂在 profile 里，自己**不带**前端依赖（已实测），所以按候选
 * 目录逐个试；`DSH_ACCEPTANCE_REACT_DIR` 可显式指定一个 node_modules 目录。
 */
function loadReactRuntime() {
  const candidates = [
    process.env.DSH_ACCEPTANCE_REACT_DIR,
    join(ROOT, 'node_modules'),
    // 同级的 Skill Trace 插件带完整前端依赖，是本机的现成来源。
    join(ROOT, '..', '..', '10_DSH_Skill_Trace', 'node_modules'),
  ].filter(Boolean)

  const tried = []
  for (const dir of candidates) {
    if (!existsSync(dir)) {
      tried.push(`${dir}（目录不存在）`)
      continue
    }
    try {
      const req = createRequire(join(dir, 'anchor.cjs'))
      return {
        dir,
        React: req('react'),
        renderToStaticMarkup: req('react-dom/server').renderToStaticMarkup,
      }
    } catch (error) {
      tried.push(`${dir}（${error?.code ?? error?.message ?? error}）`)
    }
  }

  if (process.env.DSH_ACCEPTANCE_SKIP_CLIENT_RENDER === '1') return null
  throw new Error(
    '找不到 react / react-dom，客户端产物无法真正渲染。\n' +
      '请在插件目录下 `npm install`，或设 `DSH_ACCEPTANCE_REACT_DIR=<某个 node_modules 目录>`；\n' +
      '确实要放过这条测试，显式设 `DSH_ACCEPTANCE_SKIP_CLIENT_RENDER=1`（不是默认行为）。\n' +
      '试过：\n' +
      tried.map((line) => `  - ${line}`).join('\n'),
  )
}

/**
 * 按 web shell 的方式加载产物：给一个 `window`，收下 `load()` 注册的那个 factory。
 *
 * **不调用 factory** —— 它一进来就要 `require('react')`，调用方负责决定喂什么。
 *
 * @returns `{ registration, registrations, factoryRequiring(extra) }`
 */
function loadBundle() {
  const source = readFileSync(BUNDLE, 'utf8')
  const registrations = []
  const windowShim = { __ModuleLoader__: { load: (reg) => registrations.push(reg) } }

  // 产物是 `window.__ModuleLoader__.load({...})`，把 window 作为参数喂进去即可。
  new Function('window', source)(windowShim)

  const registration = registrations[0]
  /** 调 factory 并记录它要求过的外部模块；`extra` 里没有的一律当漂移。 */
  const factoryRequiring = (extra = {}) => {
    const externals = []
    const mod = registration.factory((specifier) => {
      externals.push(specifier)
      if (Object.hasOwn(extra, specifier)) return extra[specifier]
      throw new Error(`产物要求了未预期的外部模块：${specifier}`)
    })
    return { mod, externals }
  }

  return { registration, registrations, factoryRequiring }
}

const runtime = loadReactRuntime()

/**
 * 「载入 + apply」的用例不需要真的 React（apply 不渲染）。只有最后的真实渲染用例需要。
 * 用 stub 顶上，好让显式跳过渲染的环境仍然跑得完其余四条。
 */
const STUB_REACT = {
  createElement: (...args) => ({ __stubElement: args }),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useRef: () => ({ current: null }),
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
}
const ReactForLoad = runtime ? runtime.React : STUB_REACT

test('产物被 shell 收下时，注册 id 恰好是包名（否则 :739 硬失败，tab 永远不出现）', () => {
  const { registrations, registration } = loadBundle()
  assert.equal(registrations.length, 1, '一次 load 只该注册一个模块')
  assert.equal(registration.id, PKG.name)
  assert.equal(registration.id, 'dsh-acceptance')
  assert.equal(typeof registration.factory, 'function')
})

test('factory 只要求 react，返回的 exports 声明 inject 与 apply', () => {
  const { factoryRequiring } = loadBundle()
  const { mod, externals } = factoryRequiring({ react: ReactForLoad })
  assert.deepEqual(externals, ['react'], '产物对外的依赖必须只有 react（seed 表内）')
  assert.deepEqual(mod.inject, ['slots', 'locale'])
  assert.equal(typeof mod.apply, 'function')
})

test('apply() 把 tab 注册进 conversation.view：id/order/locale 与 L0 决策一致', () => {
  const { factoryRequiring } = loadBundle()
  const { mod } = factoryRequiring({ react: ReactForLoad })

  const localeRegs = []
  const injected = []
  const registrations = []
  const ctx = {
    locale: { register: (ns, dicts) => localeRegs.push({ ns, dicts }) },
    slots: {
      inject: (name, cb) => {
        injected.push(name)
        return cb()
      },
      register: (desc, render) => registrations.push({ desc, render }),
    },
  }

  mod.apply(ctx)

  assert.deepEqual(injected, ['conversation.view'])
  assert.equal(registrations.length, 1)

  const { desc, render } = registrations[0]
  assert.equal(desc.name, 'conversation.view')
  assert.equal(desc.id, VIEW_ID)
  assert.equal(desc.order, 80, 'order 80 是 L0 §1 定下的；改了要同步 L0')
  assert.equal(desc.locale, 'dsh-acceptance')
  assert.equal(desc.label(), TAB_LABEL)
  assert.equal(typeof render, 'function')

  assert.equal(localeRegs.length, 1)
  assert.equal(localeRegs[0].ns, 'dsh-acceptance')
  const { zh, en } = localeRegs[0].dicts
  assert.equal(zh.tab, TAB_LABEL)
  // 两份字典键集必须一致：缺键会静默兜底成键名（中文界面里露出英文单词），不会报错。
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
  for (const [key, value] of Object.entries(zh)) {
    assert.ok(typeof value === 'string' && value.length > 0, `中文字典 ${key} 是空的`)
    assert.ok(typeof en[key] === 'string' && en[key].length > 0, `英文字典 ${key} 是空的`)
  }
})

test('五态文案齐全，且中文用词是用户界面评审定稿的那五个', () => {
  // 2026-10-10 评审把显示名从「待验证 / 未验证 / 被阻塞」改成「待验收 / 无法判断 / 环境阻塞」。
  // **改的只是显示名**：宿主 STATUSES 仍是 pending/pass/fail/unknown/blocked，派生与导出按键走。
  const { factoryRequiring } = loadBundle()
  const { mod } = factoryRequiring({ react: ReactForLoad })
  const text = mod.__pure.STATUS_TEXT
  assert.deepEqual(Object.keys(text).sort(), ['blocked', 'fail', 'pass', 'pending', 'unknown'])
  const expected = { pending: '待验收', pass: '通过', fail: '未通过', unknown: '无法判断', blocked: '环境阻塞' }
  for (const [status, label] of Object.entries(expected)) {
    assert.equal(text[status].zh, label, `${status} 的中文文案被改动了`)
    assert.ok(text[status].en, `${status} 缺英文文案`)
  }
  // 每个状态都要有一句解释：「无法判断」与「未验证」混成同一件事是最容易出的歧义。
  const hint = mod.__pure.STATUS_HINT
  for (const status of Object.keys(expected)) {
    assert.ok(hint[status]?.zh, `${status} 缺中文解释`)
    assert.ok(hint[status]?.en, `${status} 缺英文解释`)
  }
})

test('首屏默认选中最近更新的那一条任务；已经选中过就不动它', () => {
  const { factoryRequiring } = loadBundle()
  const { mod } = factoryRequiring({ react: ReactForLoad })
  const pick = mod.__pure.pickDefaultTask
  assert.equal(typeof pick, 'function', '产物没有导出 pickDefaultTask，首屏默认选中就没法被测试')
  const list = [{ taskId: 'task-new' }, { taskId: 'task-old' }] // 服务端按 updatedAt 倒序
  assert.equal(pick(list, null), 'task-new', '什么都没选时应该落到列表第一条（最近更新的）')
  assert.equal(pick(list, 'task-old'), 'task-old', '用户已经选过了，不该被改掉')
  assert.equal(pick([], null), null, '一个任务都没有时不该凭空选一个')
  assert.equal(pick([], 'task-old'), 'task-old', '列表请求失败拿到空数组时，不该清掉用户的选择')
})

test('「一个任务都没有」和「有任务但没选中」是两句不同的话', () => {
  // 曾经两句共用 emptyTitle：列表里明明有 6 条，首屏却写「还没有验收任务」，
  // 用户据此以为插件没装上。这里把两句话钉住。
  const { factoryRequiring } = loadBundle()
  const { mod } = factoryRequiring({ react: ReactForLoad })
  for (const value of Object.values(mod.__pure.STATUS_TEXT)) assert.ok(value)
  const src = readFileSync(BUNDLE, 'utf8')
  for (const key of ['emptyTitle', 'emptyBody', 'pickOneTitle', 'pickOneBody']) {
    assert.ok(src.includes(key), `产物里找不到字典键 ${key}`)
  }
  const zh = src.match(/pickOneTitle:"([^"]+)"/)
  const zhEmpty = src.match(/emptyTitle:"([^"]+)"/)
  assert.ok(zh && zhEmpty, '拿不到 pickOneTitle / emptyTitle 的字面量')
  assert.notEqual(zh[1], zhEmpty[1], '两句话又合并成同一句了')
})

test('取数路径是相对形态（无前导 /）且在 api/acceptance. 之下 —— L0 §6.2 取数纪律', () => {
  const { factoryRequiring } = loadBundle()
  const { mod } = factoryRequiring({ react: ReactForLoad })
  const routes = Object.values(mod.__pure.ROUTE)
  // 这里守的是**形态**不是条数：客户端目前只消费宿主 9 条里的一个子集。
  assert.ok(routes.length >= 5, `路由常量太少：${routes.length}`)
  const seen = new Set()
  for (const route of routes) {
    assert.equal(typeof route, 'string')
    assert.ok(!route.startsWith('/'), `${route} 带了前导斜杠，浏览器里会解析成绝对路径`)
    assert.ok(route.startsWith('api/acceptance.'), `${route} 不在 api/acceptance. 之下`)
    assert.ok(!seen.has(route), `${route} 重复`)
    seen.add(route)
  }
})

test('注册进去的那个 render 能真的渲染出 tab 文案（不是只有源码长得对）', (t) => {
  if (!runtime) {
    t.skip('DSH_ACCEPTANCE_SKIP_CLIENT_RENDER=1：按要求跳过了真实渲染')
    return
  }
  const { factoryRequiring } = loadBundle()
  const { mod } = factoryRequiring({ react: runtime.React })

  const registrations = []
  mod.apply({
    locale: { register: () => {} },
    slots: {
      inject: (_name, cb) => cb(),
      register: (desc, render) => registrations.push({ desc, render }),
    },
  })

  const element = registrations[0].render({ sessionId: 'probe-session' })
  assert.ok(element && typeof element === 'object', 'render 该返回一个 React 元素')

  const html = runtime.renderToStaticMarkup(element)
  assert.ok(html.length > 0, '渲染出了空字符串')
  assert.ok(
    html.includes(TAB_LABEL),
    `首屏 HTML 里没有「${TAB_LABEL}」—— 挂载即白屏。实际 HTML：\n${html.slice(0, 400)}`,
  )
})

// ---------------------------------------------------------------------------
// 写入路径：产物里的 IO 层必须把 host 的**两种错误形态**都变成原文
//
// 客户端把 4xx 当成功是最容易漏的一类 bug：界面看起来只是「点了没反应」，
// 而真正的原因（哪一条证据不合格、哪一版和哪一版对不上）根本没出现在人眼前。
// ---------------------------------------------------------------------------

/** 临时顶掉全局 fetch：产物里的 IO 层用的是全局 fetch，测完必须换回来。 */
async function withFetch(handler, work) {
  const original = globalThis.fetch
  globalThis.fetch = handler
  try {
    // 必须 await：`finally` 在 work() 返回 promise 的那一刻就会跑，
    // 不等它的话第二个请求会用回真的 fetch（实测表现是 ECONNREFUSED :80）。
    return await work()
  } finally {
    globalThis.fetch = original
  }
}

function ioOf() {
  const { factoryRequiring } = loadBundle()
  const { mod } = factoryRequiring({ react: ReactForLoad })
  assert.ok(mod.__io, '产物没有导出 __io 面包屑，写入路径没法被测试')
  return mod.__io
}

test('postJson 成功时发 POST + JSON，并把 sessionId 放进 query（宿主从 query 读它）', async () => {
  const { postJson } = ioOf()
  const seen = []
  await withFetch(
    async (url, init) => {
      seen.push({ url: String(url), init })
      return new Response(JSON.stringify({ ok: true, receipt: { taskId: 'AR-1' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
    async () => {
      const body = await postJson('api/acceptance.tasks', { requirementText: '需求' }, { sessionId: 'S-1' })
      assert.equal(body.receipt.taskId, 'AR-1')
    },
  )
  assert.equal(seen.length, 1)
  assert.equal(seen[0].init.method, 'POST')
  assert.equal(seen[0].init.headers['content-type'], 'application/json')
  assert.deepEqual(JSON.parse(seen[0].init.body), { requirementText: '需求' })
  assert.ok(seen[0].url.includes('sessionId=S-1'), `sessionId 没进 query：${seen[0].url}`)
})

test('postJson 把 {errors:[…]} 逐条拼进错误消息（host 的第一种错误形态）', async () => {
  const { postJson } = ioOf()
  await assert.rejects(
    () =>
      withFetch(
        async () =>
          new Response(
            JSON.stringify({ ok: false, errors: ['AC-01 判为通过却没有任何证据', '第 2 轮引用了不存在的证据 EV-9'] }),
            { status: 400, headers: { 'content-type': 'application/json' } },
          ),
        () => postJson('api/acceptance.import', {}),
      ),
    (err) => {
      assert.ok(err.message.includes('AC-01 判为通过却没有任何证据'), err.message)
      assert.ok(err.message.includes('EV-9'), err.message)
      return true
    },
  )
})

test('postJson 也认 {error} 单条形态，且 HTTP 200 但 ok:false 同样算失败', async () => {
  const { postJson } = ioOf()
  await assert.rejects(
    () =>
      withFetch(
        async () =>
          new Response(JSON.stringify({ ok: false, error: '凭证不存在' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        () => postJson('api/acceptance.criteria', {}),
      ),
    /凭证不存在/,
  )
})

test('getText / postText 按**文本**收 Markdown（.package 与 .export 回的不是 JSON）', async () => {
  const { getText, postText } = ioOf()
  const md = '# 验收凭证\n\n| 状态 | 数量 |\n'
  const seen = []
  await withFetch(
    async (url, init) => {
      seen.push({ url: String(url), init })
      return new Response(md, { status: 200, headers: { 'content-type': 'text/markdown; charset=utf-8' } })
    },
    async () => {
      assert.equal(await postText('api/acceptance.package', { taskId: 'AR-1' }), md)
      assert.equal(await getText('api/acceptance.export', { taskId: 'AR-1', format: 'md' }), md)
    },
  )
  assert.equal(seen[0].init.method, 'POST')
  assert.notEqual(seen[1].init.method, 'POST')
  assert.ok(seen[1].url.includes('format=md'), seen[1].url)
})

test('文本路由出错时仍然抛原文（404 的 JSON 错误体不能被当成 Markdown 收下）', async () => {
  const { getText } = ioOf()
  await assert.rejects(
    () =>
      withFetch(
        async () =>
          new Response(JSON.stringify({ ok: false, error: '凭证不存在' }), {
            status: 404,
            headers: { 'content-type': 'application/json' },
          }),
        () => getText('api/acceptance.export', { taskId: 'nope' }),
      ),
    /凭证不存在/,
  )
})

test('客户端真的消费了全部 9 条路由 —— 含写入通道与模式 A 委派（G10 的「子集」关系要有实际内容）', () => {
  const { factoryRequiring } = loadBundle()
  const { mod } = factoryRequiring({ react: ReactForLoad })
  const routes = Object.values(mod.__pure.ROUTE)
  const needed = [
    'api/acceptance.tasks',
    'api/acceptance.criteria',
    'api/acceptance.import',
    'api/acceptance.decision',
    'api/acceptance.package',
    'api/acceptance.export',
    'api/acceptance.verify',
  ]
  for (const route of needed) {
    assert.ok(routes.includes(route), `客户端没有消费 ${route}`)
  }
  // 宿主一共 9 条；客户端把 9 条全接上了（模式 A 的 .verify 是最后一条）。
  // 条数写死是有意的：新增一条宿主路由而客户端没接，这个断言会提醒你别让它永远悬着。
  assert.equal(routes.length, 9, `ROUTE 应该有 9 条（宿主 9 条全被消费），实为 ${routes.length}`)
})

// ---------------------------------------------------------------------------
// 改版后的界面规则：能被源码断言钉住的都钉住（用户 2026-10-10 评审 §4.4–§4.8）
// ---------------------------------------------------------------------------

test('人工判定用的证据编号是「现有最大值 +1」，但**不判断任何状态**', () => {
  const { factoryRequiring } = loadBundle()
  const { mod } = factoryRequiring({ react: ReactForLoad })
  const next = mod.__pure.nextEvidenceId
  assert.equal(typeof next, 'function', '产物没有导出 nextEvidenceId')
  assert.equal(next({ evidence: [] }), 'EV-0001')
  assert.equal(next({ evidence: [{ evidenceId: 'EV-0007' }, { evidenceId: 'EV-0003' }] }), 'EV-0008')
  assert.equal(next({ evidence: [{ evidenceId: '不是这个形态' }] }), 'EV-0001')
  assert.equal(next(null), 'EV-0001')
})

test('修复说明只抄事实：待处理项带标准与状态，不把「没验证」写成失败或已修好', () => {
  const { factoryRequiring } = loadBundle()
  const { mod } = factoryRequiring({ react: ReactForLoad })
  const receipt = {
    taskId: 'task-1',
    requirementText: '健康检查接口要能返回 200。',
    criteria: [
      { id: 'AC-01', title: '健康检查 200', expected: '打开地址服务返回 200。' },
      { id: 'AC-02', title: '五态齐全', expected: '响应里有五种状态。' },
    ],
    evidence: [{ evidenceId: 'EV-0001', criterionId: 'AC-01', kind: 'command', text: 'curl -i /health' }],
    rounds: [{ round: 1, evaluations: [{ criterionId: 'AC-02', status: 'unknown', note: '只看到三种。' }] }],
  }
  const text = mod.__pure.buildRepairText(receipt, { 'AC-01': 'pass', 'AC-02': 'unknown' }, receipt.criteria)
  assert.ok(text.includes('AC-02'), '没有列出待处理的项')
  assert.ok(text.includes('无法判断'), '没有写清这一项是什么状态')
  assert.ok(text.includes('响应里有五种状态。'), '没有带上验收标准')
  assert.ok(text.includes('只看到三种。'), '没有带上验收备注')
  assert.ok(!text.includes('AC-01'), '已经通过的项不该出现在修复说明里')
  assert.ok(!text.includes('已修好') && !text.includes('已经修好'), '把没有验证的东西写成了已修好')
})

test('没全通过时「接受交付」不可点，并把剩下的项逐条写出来（不能只靠变灰）', (t) => {
  if (!runtime) {
    t.skip('DSH_ACCEPTANCE_SKIP_CLIENT_RENDER=1：按要求跳过了真实渲染')
    return
  }
  const { factoryRequiring } = loadBundle()
  const { mod } = factoryRequiring({ react: runtime.React })
  const t_ = (key) => key
  const criteria = [
    { id: 'AC-01', title: '健康检查 200' },
    { id: 'AC-02', title: '五态齐全' },
  ]
  const acceptButton = (html) => {
    const match = html.match(/<button[^>]*acc-btn-primary[^>]*>/)
    assert.ok(match, `没有渲染出主按钮：\n${html.slice(0, 600)}`)
    return match[0]
  }

  const open = runtime.renderToStaticMarkup(
    runtime.React.createElement(mod.__views.FooterBar, {
      t: t_,
      busy: false,
      decision: null,
      criteria,
      statuses: { 'AC-01': 'pass', 'AC-02': 'unknown' },
      onDecide: () => {},
      onExport: async () => '',
      onRepair: () => '',
    }),
  )
  assert.ok(acceptButton(open).includes('disabled'), '还有一项不是通过，「接受交付」却可点')
  assert.ok(open.includes('AC-02'), '禁用时没有说明还剩哪一项')
  assert.ok(open.includes('无法判断'), '没写清剩下的那一项是什么状态')

  const done = runtime.renderToStaticMarkup(
    runtime.React.createElement(mod.__views.FooterBar, {
      t: t_,
      busy: false,
      decision: null,
      criteria,
      statuses: { 'AC-01': 'pass', 'AC-02': 'pass' },
      onDecide: () => {},
      onExport: async () => '',
      onRepair: () => '',
    }),
  )
  assert.ok(!acceptButton(done).includes('disabled'), '全部通过了，「接受交付」还是禁用')
  assert.ok(done.includes('decisionSummaryPass'), '全部通过时没给出短摘要')
})

test('逐条判定区有五个动作，并且「重新验证」旁边写清了它到底会做什么', (t) => {
  if (!runtime) {
    t.skip('DSH_ACCEPTANCE_SKIP_CLIENT_RENDER=1：按要求跳过了真实渲染')
    return
  }
  const { factoryRequiring } = loadBundle()
  const { mod } = factoryRequiring({ react: runtime.React })
  const t_ = (key) => key
  const html = runtime.renderToStaticMarkup(
    runtime.React.createElement(mod.__views.JudgementBlock, {
      t: t_,
      busy: false,
      criterion: { id: 'AC-01', title: '健康检查 200' },
      status: 'pass',
      onJudge: () => {},
    }),
  )
  for (const label of ['judgePass', 'judgeFail', 'judgeUnknown', 'judgeBlocked', 'judgeClear']) {
    assert.ok(html.includes(label), `判定区少了「${label}」`)
  }
  assert.ok(html.includes('judgementHint'), '没有解释「点一下会写一轮人工记录」')
  assert.ok(html.includes('<textarea'), '没有验收备注输入框')
})

test('证据默认折叠：摘要里有编号、种类与弱化来源，完整输出在 details 里', (t) => {
  if (!runtime) {
    t.skip('DSH_ACCEPTANCE_SKIP_CLIENT_RENDER=1：按要求跳过了真实渲染')
    return
  }
  const { factoryRequiring } = loadBundle()
  const { mod } = factoryRequiring({ react: runtime.React })
  const t_ = (key) => key
  const html = runtime.renderToStaticMarkup(
    runtime.React.createElement(mod.__views.EvidenceRow, {
      t: t_,
      evidence: {
        evidenceId: 'EV-0001',
        criterionId: 'AC-01',
        kind: 'command',
        text: '第一行观察\n第二行细节',
        exitCode: 0,
        capturedAt: '2026-10-10T02:00:00.000Z',
        ref: { type: 'command', locator: 'curl -s -o /dev/null -w %{http_code} http://127.0.0.1:3080/' },
      },
    }),
  )
  assert.ok(html.includes('<details'), '证据没有折叠')
  assert.ok(html.includes('<summary'), '证据没有摘要行')
  assert.ok(html.includes('EV-0001'))
  assert.ok(html.includes('kindCommand'))
  assert.ok(html.includes('退出码 0'), '摘要行没带弱化来源（退出码）')
  assert.ok(html.includes('第一行观察'), '摘要行没有一句话观察到什么')
  assert.ok(html.includes('第二行细节'), '折叠里没有完整输出')
})

// ---------------------------------------------------------------------------
// v0.1.2 §5「首次使用与验收流程引导」：每一节都要有会红的断言
//
// 首屏那几张屏（空状态 / 有任务没选中）在静态渲染里本来出不来 —— 它们由 useEffect 里的
// 取数决定。产物为此留了一个**只读的测试接缝** `__testInitial`（浏览器里永远不传），
// 所以下面几条是**真的把那段界面渲染出来**再断言，不是拿源码文本碰运气。
// ---------------------------------------------------------------------------

/** 渲染 Workbench 的某一屏：`boot` 就是那个测试接缝。 */
function bootOf() {
  const { factoryRequiring } = loadBundle()
  const { mod } = factoryRequiring({ react: runtime.React })
  const noop = async () => ({})
  const io = { getJson: noop, getText: async () => '', postJson: noop, postText: async () => '' }
  const render = (boot) =>
    runtime.renderToStaticMarkup(
      runtime.React.createElement(mod.__views.Workbench, {
        sessionId: 'probe',
        __testInitial: { io, loading: false, ...boot },
      }),
    )
  return { mod, render }
}

/**
 * 拿真的中文字典当 `t`。**不要用 `t => t` 回显键名**：那样断言只能证明「用了一个键」，
 * 证明不了用户会看到方案里那句原话。
 */
function zhDictOf(mod) {
  const regs = []
  mod.apply({
    locale: { register: (_ns, dicts) => regs.push(dicts) },
    slots: { inject: (_name, cb) => cb(), register: () => {} },
  })
  const zh = regs[0]?.zh ?? {}
  return (key) => zh[key] ?? key
}

/** 只渲染一个小组件（默认用真的中文字典，所以断言看得见用户实际读到的那句话）。 */
function viewHtml(mod, name, props = {}) {
  return runtime.renderToStaticMarkup(
    runtime.React.createElement(mod.__views[name], { t: zhDictOf(mod), ...props }),
  )
}

const TASK = { taskId: 'task-1', taskTitle: '健康检查接口' }

test('§5.1 没有任务时是「开始一次交付验收」的开始页，四条引号里的原话一个不少', (t) => {
  if (!runtime) {
    t.skip('DSH_ACCEPTANCE_SKIP_CLIENT_RENDER=1：按要求跳过了真实渲染')
    return
  }
  const { render } = bootOf()
  const html = render({ tasks: [] })
  for (const line of [
    '开始一次交付验收',
    '把本次开发需求列成检查项，再根据证据决定是否接受交付。',
    '新建验收任务',
    '写下需求 → 确认验收项 → 查看证据并作出决定',
  ]) {
    assert.ok(html.includes(line), `首屏少了方案 §5.1 的原话「${line}」：\n${html.slice(0, 700)}`)
  }
})

test('§5.1「查看示例」明说自己是示例，且不出现任何像真实任务/真实证据的东西', (t) => {
  if (!runtime) {
    t.skip('DSH_ACCEPTANCE_SKIP_CLIENT_RENDER=1：按要求跳过了真实渲染')
    return
  }
  const { render } = bootOf()
  const html = render({ tasks: [] })
  assert.ok(html.includes('查看示例'), '没有渲染出「查看示例」入口')
  assert.ok(html.includes('示例，不会写入凭证也不会创建任务'), '示例没有显式标注')
  // 这条是**反例**：示例块里一条真实证据编号都不许有 —— 它最容易让示例看起来像真凭证。
  assert.match(html, /示例/, '示例块不见了')
  const sampleBlock = html.slice(html.indexOf('查看示例'))
  assert.ok(!/EV-\d{4}/.test(sampleBlock), `示例里出现了像真实证据的东西：\n${sampleBlock.slice(0, 400)}`)
  assert.ok(!/AC-\d{2}/.test(sampleBlock), '示例里出现了像真实验收项编号的东西')
})

test('§5.1「一个任务都没有」与「有任务但没选中」是两句不同的话，且空状态没有决定栏', (t) => {
  if (!runtime) {
    t.skip('DSH_ACCEPTANCE_SKIP_CLIENT_RENDER=1：按要求跳过了真实渲染')
    return
  }
  const { render } = bootOf()
  const empty = render({ tasks: [] })
  const pick = render({ tasks: [TASK] })
  assert.ok(empty.includes('开始一次交付验收'), '空状态没走开始页')
  assert.ok(pick.includes('选择一个任务继续'), '有任务但没选中时没说「选择一个任务继续」')
  assert.ok(!pick.includes('开始一次交付验收'), '把「有任务但没选中」渲染成了空状态')
  // 「还没有验收任务」时还没有可决定的对象：决定栏不该出现（§8）。
  // 注意判据要挑决定栏独有的东西 —— 开始页那句解释里本来就含「是否接受交付」。
  assert.ok(!empty.includes('acc-foot'), '空状态就摆了决定栏')
  assert.ok(!pick.includes('acc-foot'), '没选中任务时摆了决定栏')
})

test('§5.2 新建任务表单用新文案，并且在空状态里也能被打开', (t) => {
  if (!runtime) {
    t.skip('DSH_ACCEPTANCE_SKIP_CLIENT_RENDER=1：按要求跳过了真实渲染')
    return
  }
  const { mod, render } = bootOf()
  const form = viewHtml(mod, 'NewTaskForm', { busy: false, onCreate: () => {} })
  for (const line of [
    '这次开发做了什么？（可选）',
    '把你最初交给开发 Agent 的需求粘贴到这里',
    '保留原始表述。后续会把每条验收项和这份需求对应起来。',
    '创建并设置验收项',
  ]) {
    assert.ok(form.includes(line), `新建任务表单少了「${line}」`)
  }
  // 空状态里点「新建验收任务」就能写下需求 —— 不必先切到别处。
  const html = render({ tasks: [], taskId: null, showNew: true })
  assert.ok(html.includes('把你最初交给开发 Agent 的需求粘贴到这里'), '空状态里打不开新建任务表单')
})

test('§5.3 验收项整理提示词是纯文本：带齐六件事，并把需求原文逐字带进去', () => {
  const { factoryRequiring } = loadBundle()
  const { mod } = factoryRequiring({ react: ReactForLoad })
  const text = mod.__pure.acceptancePromptText
  assert.equal(typeof text, 'function', '产物没有导出 acceptancePromptText')
  const requirement = '健康检查接口要返回 200，并且响应里有 status 字段。'
  const prompt = text(requirement)
  for (const word of ['逐条', '通过条件', '验证方式', '原始需求', '建议补充', '待澄清']) {
    assert.ok(prompt.includes(word), `提示词少了「${word}」`)
  }
  assert.ok(prompt.includes(requirement), '提示词没有把需求原文逐字带进去')
  // 它只是文本：不许宣称已经调用模型或已生成验收项。
  assert.ok(!prompt.includes('已生成') && !prompt.includes('已经调用'), '提示词在宣称插件做了什么')
  // 没有需求时也不能吐出半截提示词。
  assert.ok(text('').includes('（这里放你的原始需求）'), '没有需求原文时没有给出占位说明')
  assert.ok(text(null).includes('原始需求'), 'null 输入把提示词弄坏了')
})

test('§5.4 取证入口说人话：主选项 + 次选项，正文里不出现「模式 A / 模式 B」', (t) => {
  if (!runtime) {
    t.skip('DSH_ACCEPTANCE_SKIP_CLIENT_RENDER=1：按要求跳过了真实渲染')
    return
  }
  const { mod } = bootOf()
  const main = viewHtml(mod, 'ReverifyButton', { busy: false, sessionId: 'S-1', activeCount: 2, onVerify: () => {} })
  for (const line of [
    '让独立 Agent 帮我验证',
    '由 DSH 委派独立 Agent 检查已确认的验收项，并返回结构化证据。',
    '验证过程可能不可见，最长等待时间以当前实现为准。',
  ]) {
    assert.ok(main.includes(line), `主取证入口少了「${line}」`)
  }
  const second = viewHtml(mod, 'MoreWays', { busy: false, onGenerate: async () => '', onImport: async () => {} })
  assert.ok(second.includes('我已经有检查结果'), '次选项不见了')
  assert.ok(
    second.includes('从验收包获取结构化格式，在外部完成检查后，将结果导入验收台。'),
    '次选项没有一句解释',
  )
  const all = main + second
  assert.ok(!all.includes('模式 A') && !all.includes('模式 B'), '主流程里还露着「模式 A / 模式 B」')
  // 展开次选项**之前**不显示生成验收包、粘贴 JSON 这些技术步骤。
  assert.ok(!second.includes('粘贴结构化结果'), '次选项还没展开就把技术步骤摆出来了')
})

test('§5.4 委派前置不满足时，动作前就写清原因，并给出替代路径', (t) => {
  if (!runtime) {
    t.skip('DSH_ACCEPTANCE_SKIP_CLIENT_RENDER=1：按要求跳过了真实渲染')
    return
  }
  const { mod } = bootOf()
  const noSession = viewHtml(mod, 'ReverifyButton', { busy: false, sessionId: null, activeCount: 2, onVerify: () => {} })
  const noCriteria = viewHtml(mod, 'ReverifyButton', { busy: false, sessionId: 'S-1', activeCount: 0, onVerify: () => {} })
  for (const html of [noSession, noCriteria]) {
    assert.ok(html.includes('我已经有检查结果'), '前置不满足时没有给出替代路径')
    assert.ok(/<button[^>]*disabled/.test(html), '前置不满足时按钮居然是可点的')
  }
  assert.ok(noSession.includes('这个页面没拿到会话 ID，无法委派。'), '没说清缺的是会话 ID')
  assert.ok(noCriteria.includes('还没有验收项'), '没说清缺的是验收项')
})

test('§5.4 宿主没有委派能力时也在动作前说明；但「不知道」不许显示成「不可用」', (t) => {
  if (!runtime) {
    t.skip('DSH_ACCEPTANCE_SKIP_CLIENT_RENDER=1：按要求跳过了真实渲染')
    return
  }
  const { mod } = bootOf()
  const base = { busy: false, sessionId: 'S-1', activeCount: 2, onVerify: () => {} }
  // 宿主明说没有（health.capabilities.delegate === false）⇒ 禁用 + 原因 + 替代路径
  const unsupported = viewHtml(mod, 'ReverifyButton', { ...base, delegateAvailable: false })
  assert.ok(/<button[^>]*disabled/.test(unsupported), '宿主说没有委派能力，按钮却可点')
  assert.ok(unsupported.includes('当前宿主没有可用的委派能力'), '没说清为什么不能委派')
  assert.ok(unsupported.includes('我已经有检查结果'), '没给出替代路径')
  // 老版本宿主没有这个字段 = 未知 ⇒ **不拦**（把「不知道」当「不可用」会冤枉一个本来能跑的宿主）
  const unknown = viewHtml(mod, 'ReverifyButton', { ...base, delegateAvailable: undefined })
  assert.ok(!/<button[^>]*disabled/.test(unknown), '字段缺失（未知）时不该禁用按钮')
  assert.ok(!unknown.includes('当前宿主没有可用的委派能力'), '字段缺失时不该说人家没有能力')
})

test('§5.5 下一步指引是宿主 counts 的纯函数映射，六种情形各一句', () => {
  const { factoryRequiring } = loadBundle()
  const { mod } = factoryRequiring({ react: ReactForLoad })
  const hint = mod.__pure.nextStepHint
  assert.equal(typeof hint, 'function', '产物没有导出 nextStepHint')
  const counts = (patch) => ({ pending: 0, pass: 0, fail: 0, unknown: 0, blocked: 0, ...patch })

  // 全部还没结论，而且一条证据都没有 ⇒ 说「先开始验证」。
  assert.equal(hint(counts({ pending: 2 }), { evidenceCount: 0 }), 'stepNoEvidence')
  // 只要有证据，「还没有证据」那句就不成立，退回「还有验收项没有结论」。
  assert.equal(hint(counts({ pending: 2 }), { evidenceCount: 1 }), 'stepPending')
  assert.equal(hint(counts({ pending: 1, fail: 1 }), { evidenceCount: 2 }), 'stepFail')
  assert.equal(hint(counts({ pending: 1, blocked: 1 }), { evidenceCount: 2 }), 'stepBlocked')
  assert.equal(hint(counts({ pending: 1, unknown: 1 }), { evidenceCount: 2 }), 'stepUnknown')
  assert.equal(hint(counts({ pass: 3 }), { evidenceCount: 3 }), 'stepAllPass')
  // 有结论的项优先于没结论的项：fail 压过 pending。
  assert.equal(hint(counts({ pending: 9, fail: 1 }), { evidenceCount: 5 }), 'stepFail')
  // 输入坏掉时不许抛（宿主可能老、字段可能缺）。
  assert.equal(typeof hint(undefined, undefined), 'string')
  assert.equal(typeof hint({}, {}), 'string')
})

test('§5.5 指引读的是宿主派生的 counts，并在底部决定栏里显示出来', (t) => {
  if (!runtime) {
    t.skip('DSH_ACCEPTANCE_SKIP_CLIENT_RENDER=1：按要求跳过了真实渲染')
    return
  }
  const { mod } = bootOf()
  const criteria = [{ id: 'AC-01', title: '健康检查 200' }]
  const html = viewHtml(mod, 'FooterBar', {
    busy: false,
    decision: null,
    criteria,
    statuses: { 'AC-01': 'fail' },
    evidenceCount: 1,
    stepHint: mod.__pure.nextStepHint({ pending: 0, pass: 0, fail: 1, unknown: 0, blocked: 0 }, { evidenceCount: 1 }),
    onDecide: () => {},
    onExport: async () => '',
    onRepair: () => '',
  })
  assert.ok(html.includes('下一步'), '决定栏没有「下一步」标签')
  assert.ok(
    html.includes('发现不符合要求的项目。可以生成修复说明并交回开发 Agent。'),
    '决定栏没有显示与当前结果匹配的那一句',
  )
})

test('§5.6 修复说明按四类分开写（不统称失败），并保留原话里的含义', () => {
  const { factoryRequiring } = loadBundle()
  const { mod } = factoryRequiring({ react: ReactForLoad })
  const criteria = [
    { id: 'AC-01', title: 'a' },
    { id: 'AC-02', title: 'b' },
    { id: 'AC-03', title: 'c' },
    { id: 'AC-04', title: 'd' },
    { id: 'AC-05', title: 'e' },
  ]
  const statuses = { 'AC-01': 'pass', 'AC-02': 'fail', 'AC-03': 'unknown', 'AC-04': 'blocked', 'AC-05': 'pending' }
  const text = mod.__pure.buildRepairText({ requirementText: '需求原文' }, statuses, criteria)
  for (const heading of ['已证实未通过', '尚无法判断', '环境阻塞', '待验收']) {
    assert.ok(text.includes(heading), `修复说明少了「${heading}」这一组`)
  }
  // 通过的项一条都不列（它不需要修），只用一句话说明还有多少项已通过。
  assert.ok(!text.includes('AC-01'), '把已通过的项也列进了修复说明')
  assert.ok(text.includes('另有 1 项已通过'), '没有说明还有几项已通过')
  // 「没验证」不许被写成「已失败」。
  assert.ok(!text.includes('全部失败'), '把四类统称成了失败')
})

test('§5.5 下一步只显示一处（不重复占地方），且一条证据都没有时与「有证据但没结论」分开说', (t) => {
  if (!runtime) {
    t.skip('DSH_ACCEPTANCE_SKIP_CLIENT_RENDER=1：按要求跳过了真实渲染')
    return
  }
  const { mod, render } = bootOf()
  const receipt = {
    taskId: 't1',
    taskTitle: '健康检查',
    requirementText: '需求原文',
    criteria: [{ id: 'AC-01', title: '健康检查 200' }],
    evidence: [],
    rounds: [],
    decision: null,
    scope: { cwd: '/tmp', changedFilesSource: 'no-session' },
  }
  const detail = {
    receipt,
    derived: {
      statuses: { 'AC-01': 'pending' },
      counts: { pending: 1, pass: 0, fail: 0, unknown: 0, blocked: 0 },
      stale: [],
    },
  }
  const html = render({
    tasks: [TASK],
    taskId: 'task-1',
    detail,
  })
  assert.equal(
    html.split('<div class="acc-step">').length - 1,
    1,
    '「下一步」出现了不止一处 —— 同一句话重复占地方（§4.5 视觉克制）',
  )
  assert.ok(html.includes('先开始验证，当前还没有可供判断的证据。'), '一条证据都没有时没说「先开始验证」')
  assert.ok(html.includes('让独立 Agent 帮我验证'), '主取证入口不见了')
  assert.ok(html.includes('确认验收标准'), '验收项的确认按钮不见了')
})

test('§5.6 导出与决定的用途写在按钮旁边，三个决定齐全', (t) => {
  if (!runtime) {
    t.skip('DSH_ACCEPTANCE_SKIP_CLIENT_RENDER=1：按要求跳过了真实渲染')
    return
  }
  const { mod } = bootOf()
  const html = viewHtml(mod, 'FooterBar', {
    busy: false,
    decision: null,
    criteria: [{ id: 'AC-01', title: 'a' }],
    statuses: { 'AC-01': 'pending' },
    evidenceCount: 0,
    stepHint: 'stepNoEvidence',
    onDecide: () => {},
    onExport: async () => '',
    onRepair: () => '',
  })
  for (const label of ['接受交付', '要求修复', '暂缓验收', '导出验收记录', '生成修复说明']) {
    assert.ok(html.includes(label), `决定栏少了「${label}」`)
  }
  assert.ok(html.includes('整理未通过、尚未确定和被环境阻塞的事项，交给开发 Agent 继续处理。'), '没说修复说明是干什么的')
  assert.ok(html.includes('导出当前验收凭证，不会触发新的验证。'), '没说导出只导出凭证')
})

test('§5.7 版本未知保留事实，并解释「为什么未知」，不编造指纹', (t) => {
  if (!runtime) {
    t.skip('DSH_ACCEPTANCE_SKIP_CLIENT_RENDER=1：按要求跳过了真实渲染')
    return
  }
  const { mod } = bootOf()
  const html = viewHtml(mod, 'DetailPane', {
    criterion: { id: 'AC-01', title: 'a', origin: 'original' },
    receipt: {
      requirementText: '需求原文',
      criteria: [],
      evidence: [],
      rounds: [],
      scope: { cwd: '/tmp', changedFilesSource: 'no-session' },
    },
    status: 'pending',
    stale: new Set(),
  })
  assert.ok(html.includes('版本未知'), '把「版本未知」这条事实藏起来了')
  assert.ok(
    html.includes('当前没有取得可靠的代码版本快照，因此本次凭证无法确认绑定到哪个代码版本。'),
    '没有解释「版本未知」的原因',
  )
  // 没有可靠依据时不许显示确定的「已过期」。
  assert.ok(!html.includes('已过期'), '在没有可靠依据时说了「已过期」')
})
