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
