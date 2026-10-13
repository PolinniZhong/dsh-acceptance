#!/usr/bin/env node
/**
 * 守卫（SDD §11）。`npm run verify`。
 *
 * 口头规则不会自己活下去 —— 它必须变成**会红的**东西，否则下一个人不知道它存在。
 * 这里分两类：
 *  - **源码文本层断言**（G1–G4、G7）：跑在源码上，不需要浏览器、不需要起 DSH。
 *    文案断言跑在**去掉英文字典之后**的源码上 —— 只活在 `const EN = {…}` 里的一句文案
 *    不算存在。因此 G2/G3 先剥离 `EN = {…}` 字面量再搜。
 *  - **纯函数行为断言**（G5、G8）：直接 import `domain.js` 跑反例。
 *
 * 守卫**不是**断言「某个页面还在」。契约要反向钉住：**删掉的东西不许悄悄回来。**
 *
 * @module scripts/verify-project
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { shippedBundleIsFresh } from './build-client.mjs'
import {
  DEFAULT_ROUND_LIMIT,
  ORIGINS,
  PRODUCERS,
  SCHEMA_VERSION,
  STATUS_LABELS,
  STATUSES,
  buildDelegationPrompt,
  buildVerifySchema,
  nextCriterionId,
  validateEvidence,
  validateRepairItem,
} from '../src/dsh/host/domain.js'
import { SCHEMA_ALLOWED_KEYS, TOOL_NAMES, buildAcceptanceTools } from '../src/dsh/host/tools.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const results = []
const asyncChecks = []

/**
 * 跑一个守卫。支持两种形态，而且**不能混着计数**：
 *
 *  - **同步** —— 大多数守卫，立刻进 `results`；
 *  - **返回 Promise**（G12 要真读一次 DSH 运行时的源码）—— 放进 `asyncChecks`，由报告段统一 await。
 *
 * 为什么不用 `async function guard()`：那样**每个**守卫都会在报告打印之后才 push 结果，
 * 表现是守卫数变少、「全绿」看起来正常 —— 这是「守卫看起来在跑」的第二种假象
 * （第一种是 G16 空转，见 L1 §6）。同步的必须当场计数。
 */
function guard(id, title, fn) {
  try {
    const detail = fn()
    if (detail instanceof Promise) {
      asyncChecks.push(
        detail.then(
          (value) => results.push({ id, title, ok: true, detail: value ?? '' }),
          (error) => results.push({ id, title, ok: false, detail: String(error?.message ?? error) }),
        ),
      )
      return
    }
    results.push({ id, title, ok: true, detail: detail ?? '' })
  } catch (error) {
    results.push({ id, title, ok: false, detail: String(error?.message ?? error) })
  }
}

/** 报告前统一收口：异步守卫没跑完就不许出报告。 */
async function settleGuards() {
  await Promise.all(asyncChecks)
}

function fail(message) {
  throw new Error(message)
}

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

const SRC_FILES = walk(resolve(ROOT, 'src'))
const read = (file) => readFileSync(file, 'utf8')
const rel = (file) => relative(ROOT, file)

/** 剥离英文字典字面量后的源码 —— 只活在字典里的一句文案不算存在。 */
function withoutEnglishDictionary(source) {
  return source.replace(/const EN = \{[\s\S]*?\n\}/g, 'const EN = {}')
}

// --- G1 路由字面 -----------------------------------------------------------
guard('G1', 'host 路由：全部在 /api 之下、精确路径、一个 path 只注册一次、无 PUT', () => {
  const host = read(resolve(ROOT, 'src/dsh/host/index.js'))
  if (/\bwebServer\b/.test(host)) {
    fail('host 仍引用 webServer —— 路由必须走 ctx.connection.fetch.register（决策 D-015）')
  }
  const paths = [...host.matchAll(/route\(\s*'([^']+)'/g)].map((match) => match[1])
  if (paths.length === 0) fail('没有找到任何 route(...) 注册')
  const bad = paths.filter((path) => !/^\/api\/acceptance\.[a-z][a-z0-9]*$/.test(path))
  if (bad.length > 0) fail(`路径不合规（必须在 /api 之下、只含小写与点）：${bad.join(', ')}`)
  const duplicates = paths.filter((path, index) => paths.indexOf(path) !== index)
  if (duplicates.length > 0) {
    fail(`同一 path 注册了多次（会抛 already registered）：${[...new Set(duplicates)].join(', ')}`)
  }
  if (/'PUT'/.test(host)) fail("路由声明了 PUT —— 该机制只支持 'GET' | 'HEAD' | 'POST'")
  return `${paths.length} 条：${paths.join(', ')}`
})

// --- G2 禁用词 -------------------------------------------------------------
guard('G2', '源码里不出现四个折算词（完成率 / 通过率 / 质量分 / 健康度）', () => {
  const WORDS = ['\u5b8c\u6210\u7387', '\u901a\u8fc7\u7387', '\u8d28\u91cf\u5206', '\u5065\u5eb7\u5ea6']
  const hits = []
  for (const file of SRC_FILES) {
    const source = withoutEnglishDictionary(read(file))
    for (const word of WORDS) if (source.includes(word)) hits.push(`${rel(file)} 含「${word}」`)
  }
  if (hits.length > 0) fail(hits.join('；'))
  return `扫了 ${SRC_FILES.length} 个源文件`
})

// --- G3 禁止字段 -----------------------------------------------------------
guard('G3', '凭证里不存在 score / passRate / completion 类字段', () => {
  const TOKENS = ['score', 'passRate', 'completion', 'passedCount', 'totalCount']
  const hits = []
  for (const file of SRC_FILES) {
    const source = withoutEnglishDictionary(read(file))
    for (const token of TOKENS) {
      const pattern = new RegExp(`['"\`]${token}['"\`]|\\b${token}\\s*:`)
      if (pattern.test(source)) hits.push(`${rel(file)} 出现 ${token}`)
    }
  }
  if (hits.length > 0) fail(hits.join('；'))
  return `禁词 ${TOKENS.length} 个，零命中`
})

// --- G4 状态词表 -----------------------------------------------------------
guard('G4', '状态词表恰好是 pending/pass/fail/unknown/blocked 五个', () => {
  const EXPECTED = ['pending', 'pass', 'fail', 'unknown', 'blocked']
  if (JSON.stringify([...STATUSES]) !== JSON.stringify(EXPECTED)) {
    fail(`STATUSES = ${JSON.stringify(STATUSES)}，期望 ${JSON.stringify(EXPECTED)}`)
  }
  const declared = [...read(resolve(ROOT, 'src/dsh/host/domain.js')).matchAll(/STATUSES = Object\.freeze\(\[([^\]]*)\]\)/g)]
  if (declared.length !== 1) fail(`STATUSES 的 frozen 字面量应恰有 1 处，实为 ${declared.length} 处`)
  if (JSON.stringify([...ORIGINS]) !== JSON.stringify(['original', 'suggested'])) {
    fail('origin 词表被改动了 —— 它是一等字段')
  }
  if (JSON.stringify([...PRODUCERS]) !== JSON.stringify(['agent', 'manual', 'pasted'])) {
    fail('producedBy 词表被改动了')
  }
  if (SCHEMA_VERSION !== 1) fail(`schemaVersion 应为 1，实为 ${SCHEMA_VERSION}`)
  return `五态 + 2 origin + 3 producer`
})

// --- G5 证据合法性（行为反例） ---------------------------------------------
guard('G5', '五类证据的非法形态**全部**被拒，合法形态全部通过', () => {
  const base = {
    evidenceId: 'EV-0001',
    criterionId: 'AC-01',
    round: 1,
    capturedAt: '2026-10-10T00:00:00.000Z',
    text: '观察到的东西',
  }
  const VALID = [
    { kind: 'command', exitCode: 0, ref: { type: 'command', locator: 'node --test' } },
    { kind: 'file', ref: { type: 'file', locator: '/tmp/a.js:12' } },
    { kind: 'file', ref: { type: 'file', locator: '/tmp/a.js:12-30' } },
    { kind: 'url', ref: { type: 'url', locator: 'https://example.com/x' } },
    { kind: 'screenshot', ref: { type: 'screenshot', locator: '/tmp/shot.png' } },
    { kind: 'observation', ref: { type: 'observation', locator: '我\uFF5C2026-10-10\uFF5C本机\uFF5C按钮无响应' } },
  ]
  const INVALID = [
    { why: '没有 ref', patch: { kind: 'file', ref: undefined } },
    { why: 'locator 为空', patch: { kind: 'file', ref: { type: 'file', locator: '   ' } } },
    { why: 'ref.type 与 kind 不一致', patch: { kind: 'file', ref: { type: 'url', locator: '/tmp/a.js:1' } } },
    { why: 'file 用相对路径', patch: { kind: 'file', ref: { type: 'file', locator: 'src/a.js:1' } } },
    { why: 'file 没有行号', patch: { kind: 'file', ref: { type: 'file', locator: '/tmp/a.js' } } },
    { why: 'file 行区间倒置', patch: { kind: 'file', ref: { type: 'file', locator: '/tmp/a.js:30-12' } } },
    { why: 'command 缺 exitCode', patch: { kind: 'command', ref: { type: 'command', locator: 'ls' } } },
    { why: 'command 多行', patch: { kind: 'command', exitCode: 0, ref: { type: 'command', locator: 'ls\npwd' } } },
    { why: 'url 不是 http(s)', patch: { kind: 'url', ref: { type: 'url', locator: 'ftp://x/y' } } },
    { why: 'screenshot 非图片后缀', patch: { kind: 'screenshot', ref: { type: 'screenshot', locator: '/tmp/a.txt' } } },
    { why: 'observation 只有 2 个竖线', patch: { kind: 'observation', ref: { type: 'observation', locator: '我\uFF5C本机\uFF5C没反应' } } },
    { why: 'observation 有 4 个竖线', patch: { kind: 'observation', ref: { type: 'observation', locator: '我\uFF5C今天\uFF5C本机\uFF5C按钮\uFF5C没反应' } } },
    { why: 'kind 不在五类里', patch: { kind: 'vibes', ref: { type: 'vibes', locator: 'x' } } },
    { why: 'text 为空', patch: { kind: 'file', text: '  ', ref: { type: 'file', locator: '/tmp/a.js:1' } } },
    { why: '没有 evidenceId', patch: { kind: 'file', evidenceId: undefined, ref: { type: 'file', locator: '/tmp/a.js:1' } } },
  ]

  for (const item of VALID) {
    const result = validateEvidence({ ...base, ...item })
    if (!result.ok) fail(`合法证据被拒：${JSON.stringify(item)} → ${result.errors.join('；')}`)
  }
  for (const item of INVALID) {
    const result = validateEvidence({ ...base, ...item.patch })
    if (result.ok) fail(`非法证据被接受：${item.why}`)
  }
  return `${VALID.length} 条合法全通过，${INVALID.length} 条非法全被拒`
})

// --- G6 产物新鲜度 ---------------------------------------------------------
guard('G6', 'dist/client.js 由当前客户端源码构建（源码哈希 stamp 一致）', () => {
  if (!shippedBundleIsFresh()) {
    fail('dist/client.js 已过期或缺失 —— 跑 `npm run build:client`。浏览器跑的是 dist，不是源码。')
  }
  return 'stamp 与源码哈希一致'
})

// --- G7 客户端零判定 -------------------------------------------------------
guard('G7', '客户端不做判定：不引用 host 域逻辑，不自己推导状态', () => {
  const client = read(resolve(ROOT, 'src/dsh/client/client.js'))
  if (/require\([^)]*host[^)]*\)/.test(client)) fail('客户端 require 了 host 侧模块 —— 判定必须留在 host')
  const BANNED = ['deriveCurrentStatuses', 'validateReceipt', 'validateEvidence', 'summarizeCounts', 'nextCriterionId']
  const hits = BANNED.filter((name) => client.includes(name))
  if (hits.length > 0) fail(`客户端出现判定函数：${hits.join(', ')}`)
  // 反向钉住：客户端不许自己算「最新一轮」以外的状态迁移。
  if (/status\s*=\s*['"]pass['"]/.test(client)) fail('客户端在给状态赋值 —— 状态只能来自 host')
  return `零判定函数引用；客户端 ${Buffer.byteLength(client)} B`
})

// --- G8 id 不复用 ----------------------------------------------------------
guard('G8', '验收项 id 单调递增，**永不复用**已删除的 id', () => {
  const a = nextCriterionId([])
  if (a !== 'AC-01') fail(`空表应得 AC-01，实为 ${a}`)
  const b = nextCriterionId([{ id: 'AC-01' }, { id: 'AC-02' }])
  if (b !== 'AC-03') fail(`应得 AC-03，实为 ${b}`)
  // 已删除的 id 仍占位 —— 这是「不复用」的全部意义。
  const c = nextCriterionId([{ id: 'AC-01' }, { id: 'AC-02', deletedAt: '2026-10-10' }])
  if (c !== 'AC-03') fail(`删除过的 id 被复用了：应得 AC-03，实为 ${c}`)
  const d = nextCriterionId([{ id: 'AC-09' }, { id: 'garbage' }])
  if (d !== 'AC-10') fail(`应得 AC-10，实为 ${d}`)
  return 'AC-01 → AC-03（含删除）→ AC-10 ✓'
})

// --- G9 委派 schema 落在宿主允许的子集内 ------------------------------------
guard('G9', '委派用的 outputSchema 只用宿主允许的关键字（多一个都会被 start() 直接拒绝）', () => {
  // 宿主 `assertObjectJsonSchema` 的白名单（`@deepseek-ai/dsh-tools`）。
  // 这里的价值在于**失败时机**：schema 写错不会在构建或单测里暴露，要等重启 DSH、
  // 真去委派的那一刻才炸 —— 那时候没人会想到是 schema 写错了。
  // 白名单取自**真机快照**（`design/dsh-tool-schema-rules.json`，从 0.2.1-alpha.2 的
  // `dsh-tools/lib/index.js` 抄下）。此前这里是手抄的一份近似实现 —— 手抄迟早与真机分叉，
  // 而分叉的表现是「委派在真机上直接被 start() 拒绝」，本地全绿。G12 与它共用同一份快照。
  const rules = JSON.parse(read(resolve(ROOT, 'design/dsh-tool-schema-rules.json')))
  const ALLOWED = new Set(rules.keywords)

  const schema = buildVerifySchema([
    { id: 'AC-01', title: '活的' },
    { id: 'AC-02', title: '已删的', deletedAt: '2026-10-10' },
  ])
  if (schema.type !== 'object') fail(`根必须是 type:"object"，实为 ${JSON.stringify(schema.type)}`)

  const bad = []
  const visit = (node, path) => {
    // `enum` / `required` 的内容是**值**不是关键字，到这里就不再往下当关键字扫。
    if (Array.isArray(node) || !node || typeof node !== 'object') return
    for (const [key, value] of Object.entries(node)) {
      if (!ALLOWED.has(key)) {
        bad.push(`${path}.${key}`)
        continue
      }
      if (key === 'properties') {
        for (const [prop, sub] of Object.entries(value ?? {})) visit(sub, `${path}.properties.${prop}`)
      } else if (key === 'items') {
        visit(value, `${path}.items`)
      } else if (key === 'oneOf') {
        ;(value ?? []).forEach((sub, index) => visit(sub, `${path}.oneOf[${index}]`))
      }
    }
  }
  visit(schema, 'schema')
  if (bad.length > 0) fail(`用了宿主不认的关键字：${bad.join(' / ')}`)

  const leaf = schema.properties.criteria.items.properties
  // enum 不能为空，否则 schema 自身非法 —— 没有未删除的验收项时该由路由先拦下，不该走到这里
  const ids = leaf.id.enum
  if (!Array.isArray(ids) || ids.length !== 1 || ids[0] !== 'AC-01') {
    fail(`id 的 enum 必须恰好是**未删除**的验收项，实为 ${JSON.stringify(ids)}`)
  }
  if (leaf.status.enum.length !== STATUSES.length) fail('status 的 enum 必须恰是五态')
  if (leaf.evidence.items.properties.kind.enum.length < 1) fail('证据 kind 的 enum 不能为空')
  return '关键字全在白名单内；id enum 已排除已删除项 ✓'
})

// --- G10 跨半契约：客户端调用的路由宿主都注册过 ------------------------------
guard('G10', '客户端调用到的每条 /api/acceptance.* 路由，宿主半都注册过', () => {
  // 两半分开演化，最容易出的错是客户端先调一条宿主还没实现的路由。它在浏览器里只表现
  // 为一直转圈或静默 404 —— 构建过、单测过、其余守卫也全绿。这里把两边拉一起对一次。
  const hostRoutes = new Set(
    [...read(resolve(ROOT, 'src/dsh/host/index.js')).matchAll(/route\(\s*'(\/api\/[^']+)'/g)].map((m) =>
      m[1].replace(/^\//, ''),
    ),
  )
  if (hostRoutes.size === 0) fail('宿主源码里一条路由都没扫到 —— 是提取正则失效，不是真的没有')

  const clientRoutes = new Set(
    [...read(resolve(ROOT, 'dist/client.js')).matchAll(/"(api\/acceptance\.[a-zA-Z.]+)"/g)].map((m) => m[1]),
  )
  if (clientRoutes.size === 0) fail('客户端产物里一条路由字面量都没扫到 —— 是提取正则失效')

  const orphans = [...clientRoutes].filter((route) => !hostRoutes.has(route))
  if (orphans.length > 0) fail(`客户端调了宿主没注册的路由：${orphans.join(' / ')}`)

  const unused = [...hostRoutes].filter((route) => !clientRoutes.has(route))
  return `客户端 ${clientRoutes.size} 条 ⊆ 宿主 ${hostRoutes.size} 条；客户端暂未使用：${unused.join(', ') || '（无）'}`
})

// --- G11 设计 Token 单一真源 -------------------------------------------------
guard('G11', '设计 Token：消费方的 Token 块与快照逐字一致，块外零裸色值，字号/圆角都在尺度表内', () => {
  // 真源**不在本仓库** —— 它是跨项目的 UI 设计系统（skill `dsh-plugin-ui`）。本仓库的
  // `design/tokens.css` 只是快照，消费方（原型 Demo，以后还有插件客户端）把它整块内联。
  // 文字规范挡不住漂移，所以这里把三件事变成会红的：
  //   ① 快照 vs 真源（真源不在本机时**明说跳过** —— 静默通过和没查长得一样）
  //   ② 消费方的 Token 块 vs 快照（内联副本手改过一次就红）
  //   ③ 消费方在 Token 块之外有没有自己发明颜色 / 字号 / 圆角
  const MARK = '/* dsh-plugin-ui · 设计 Token 单一真源（canonical）'
  const MEDIA = '@media (prefers-color-scheme:dark){'
  const FONT_SIZES = new Set(['10.5px', '11px', '11.5px', '12px', '12.5px', '13.5px', '14px', '15px'])
  const RADII = new Set(['0', '50%', 'inherit'])

  const snapshot = read(resolve(ROOT, 'design/tokens.css'))
  const declared = /stamp: dsh-plugin-ui-tokens ([0-9a-f]{16})/.exec(snapshot)
  if (!declared) fail('design/tokens.css 里没有 stamp 行 —— 它不是从真源 vendor 来的')

  // ① 快照 vs 真源。真源由 skill 装到 ~/.agents/skills/dsh-plugin-ui（symlink）。
  const canonical =
    process.env.DSH_PLUGIN_UI_TOKENS ?? join(homedir(), '.agents/skills/dsh-plugin-ui/assets/tokens.css')
  let sourceNote
  if (existsSync(canonical)) {
    const found = /stamp: dsh-plugin-ui-tokens ([0-9a-f]{16})/.exec(read(canonical))
    if (!found) fail(`真源 ${canonical} 里没有 stamp 行`)
    if (found[1] !== declared[1]) {
      fail(`Token 快照落后于真源：真源 ${found[1]} ≠ 快照 ${declared[1]} —— 从真源重新 vendor 一次`)
    }
    sourceNote = `真源一致（stamp ${declared[1]}）`
  } else {
    sourceNote = `⚠ 真源不在本机（${canonical}）—— 只比对了快照自身，没比对真源`
  }

  /** Token 区段 = MARK 注释起、到 prefers-color-scheme 那一段的收尾 `}` 为止。 */
  function region(text) {
    const at = text.indexOf(MARK)
    if (at === -1) return null
    const media = text.indexOf(MEDIA, at)
    if (media === -1) fail('有 stamp 注释却没有 @media (prefers-color-scheme:dark) —— Token 区段边界不明确')
    const end = text.indexOf('\n}\n', media)
    if (end === -1) fail('Token 区段的收尾 `}` 找不到 —— 边界不明确就不要猜')
    return { at, end: end + 3, text: text.slice(at, end + 3) }
  }
  const squash = (css) => css.replace(/\s+/g, ' ').trim()
  const canonicalRegion = region(snapshot)
  if (!canonicalRegion) fail('快照 design/tokens.css 里找不到 Token 区段标记')

  const consumers = [
    resolve(ROOT, '..', '00_调研与Demo', 'Agent交付验收台_MVP_HTML_Demo.html'),
    resolve(ROOT, 'src/dsh/client/client.js'),
  ]
  const notes = []
  for (const file of consumers) {
    const text = read(file)
    const here = region(text)
    if (!here) fail(`${rel(file)} 里没有内联 Token 块（找不到 marker「${MARK}」）`)
    if (squash(here.text) !== squash(canonicalRegion.text)) {
      fail(`${rel(file)} 的 Token 块与快照不一致 —— 用 skill 的 scripts/sync-tokens.mjs 重新内联，不要手改`)
    }
    const outside = text.slice(0, here.at) + text.slice(here.end)
    // `var(--dsw-…,#hex)` 的兜底值是允许的，先剥掉再找「自己发明的颜色」
    const bare = outside.replace(/var\(--dsw-[^,)]+,[^)]*\)/g, 'var(--dsw-token)')
    const colors = [...new Set(bare.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/g) ?? [])]
    if (colors.length > 0) fail(`${rel(file)} 在 Token 块之外自己发明了颜色：${colors.join(' / ')}`)
    const fonts = [...outside.matchAll(/font-size\s*:\s*([^;}]+)/g)].map((m) => m[1].trim())
    const badFonts = [...new Set(fonts.filter((v) => !v.startsWith('var(--dui-') && !FONT_SIZES.has(v)))]
    if (badFonts.length > 0) fail(`${rel(file)} 用了尺度表之外的字号：${badFonts.join(' / ')}`)
    const radii = [...outside.matchAll(/border-radius\s*:\s*([^;}]+)/g)].flatMap((m) => m[1].trim().split(/\s+/))
    const badRadii = [...new Set(radii.filter((v) => !v.startsWith('var(--dui-') && !RADII.has(v)))]
    if (badRadii.length > 0) fail(`${rel(file)} 用了尺度表之外的圆角：${badRadii.join(' / ')}`)
    notes.push(`${rel(file)} ✓ 字号 ${new Set(fonts).size} 档 / 圆角 ${new Set(radii).size} 种，都在尺度表内`)
  }

  // 注册表外还有没有别人「自己带样式」？有就把**实测债务**打印出来。
  // 注册表外不等于没问题 ——「没查」看起来和「没问题」一模一样，所以这里宁可吵。
  const debts = []
  for (const file of SRC_FILES) {
    if (consumers.includes(file)) continue
    const text = read(file)
    const colors = text.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/g) ?? []
    if (colors.length === 0) continue
    debts.push(`${rel(file)}（未登记）：颜色字面量 ${colors.length} 处 / ${new Set(colors).size} 色`)
  }

  const registryNote =
    debts.length > 0 ? `未登记的带样式文件 → ${debts.join('；')}` : 'src/ 下没有未登记的带样式文件'
  return [sourceNote, `消费方 ${consumers.length} 个：${notes.join('；')}`, registryNote].join('\n        ')
})


// --- v0.2.0：工具层与返修闭环（G12–G20） -----------------------------------
//
// 这一组守卫钉的是 SDD §14–§16 的新规则。它们的共同理由是**失败时机**：
// 工具 schema 写错、身份从参数里取、返修项不举证 —— 这些在构建、单测、以及
// 「看一眼源码」时全都看不出来，要等真机上模型调了一次工具才现形。
// 与 G9 同因，所以和 G9 一样必须提前到 `npm run verify`。

/**
 * 构造三个工具实例，store 只给最小假实现。
 * `read` 需要返回凭证的地方由调用方自己塞。
 */
function fakeTools({ receipts = {} } = {}) {
  const written = []
  const tools = buildAcceptanceTools({
    store: {
      read: async (taskId) => receipts[taskId],
      write: async (receipt) => {
        written.push(receipt)
        receipts[receipt.taskId] = receipt
      },
    },
    runVerification: async () => {
      throw new Error('守卫不该真的发起委派')
    },
    resolveChangedFiles: () => ({ files: [], source: 'no-session' }),
    warn: () => {},
  })
  return { tools, written, receipts }
}

/** 按名字取工具。取不到就红 —— 工具被改名而守卫没跟上，必须看得见。 */
function toolNamed(tools, name) {
  const tool = tools.find((candidate) => candidate.name === name)
  if (!tool) fail(`没有名为 ${name} 的工具（实际：${tools.map((t) => t.name).join(', ')}）`)
  return tool
}

// --- G12 工具 schema 过**真机校验器** ---------------------------------------
/**
 * 定位已安装的 DSH 运行时（它把包放在 `app.asar` 里，只有 Electron 的 Node 读得进去）。
 *
 * 找不到就返回 null，由守卫**报红** —— 「没查」和「没问题」长得一模一样，
 * 所以这条不许静默跳过（本项目的既有纪律，见 L1 §6）。
 */
/**
 * 真机规则快照（`design/dsh-tool-schema-rules.json`）—— 从已安装运行时的源码里抄下来的。
 *
 * 守卫读**快照**而不是去 spawn 一次 Electron：守卫要快、无依赖、在 CI 里也跑得动。
 * 快照会随 DSH 升级**悄悄过期**（过期后守卫仍然全绿，只是守的是一份过时规则），
 * 所以另有一个**可复跑**的核对脚本证明它没过期：
 *
 *     node scripts/verify-schema-rules.mjs      # 要装着的运行时；分叉即 exit 1
 *
 * 顺带记住一条：`existsSync` 在**任何含 `.asar` 的路径上都返回 false**，连真实存在的
 * `…/Resources/app.asar` 也是 —— 所以「运行时在不在」不能用它判，只能用「跑得起来」判。
 */
guard('G12', '工具的 parameters 与 output.schema 都只用真机快照允许的关键字（且每个工具都有 output）', () => {
  const snapshotPath = resolve(ROOT, 'design/dsh-tool-schema-rules.json')
  if (!existsSync(snapshotPath)) {
    fail(`缺真机规则快照 ${rel(snapshotPath)} —— 没有它就只能手抄白名单，迟早与真机分叉。`)
  }
  const rules = JSON.parse(read(snapshotPath))
  const ALLOWED = new Set(rules.keywords)
  const TYPES = new Set(rules.types)
  if (ALLOWED.size === 0 || TYPES.size === 0) fail('快照里的 keywords / types 是空的 —— 快照被写坏了')

  const { tools } = fakeTools()
  if (tools.length !== TOOL_NAMES.length) fail(`工具数 ${tools.length} ≠ TOOL_NAMES ${TOOL_NAMES.length}`)

  const bad = []
  const visit = (node, path) => {
    // `enum` / `required` 的内容是**值**不是关键字，到这里就不再往下当关键字扫。
    if (Array.isArray(node) || !node || typeof node !== 'object') return
    for (const [key, value] of Object.entries(node)) {
      if (!ALLOWED.has(key)) {
        bad.push(`${path}.${key} 不在白名单内`)
        continue
      }
      if (key === 'properties') {
        for (const [prop, sub] of Object.entries(value ?? {})) visit(sub, `${path}.properties.${prop}`)
      } else if (key === 'items') {
        visit(value, `${path}.items`)
      } else if (key === 'oneOf') {
        if (!Array.isArray(value) || value.length < 2) bad.push(`${path}.oneOf 必须是长度 ≥ 2 的数组`)
        ;(value ?? []).forEach((sub, index) => visit(sub, `${path}.oneOf[${index}]`))
      }
    }
    // 真机细则：type 与 oneOf 不能并存；type 必须是单个字符串（不支持数组）。
    if (Object.hasOwn(node, 'type') && Object.hasOwn(node, 'oneOf')) bad.push(`${path} 同时声明了 type 与 oneOf`)
    if (Object.hasOwn(node, 'type')) {
      if (Array.isArray(node.type)) bad.push(`${path}.type 是数组 —— 真机不支持 type 数组`)
      else if (typeof node.type === 'string' && !TYPES.has(node.type)) bad.push(`${path}.type "${node.type}" 不是受支持的类型`)
    }
  }

  for (const tool of tools) {
    // 真机 `register()` 的第一件事（`dsh-tools/lib/index.js:2879`）：
    // 缺 `output` 或 `output.render` **当场抛**，而注册在循环里 ⇒ 把**整批**工具一起带崩。
    if (!tool.output || typeof tool.output.render !== 'function') {
      bad.push(`${tool.name} 缺 output { schema, render } —— register() 会抛，并把整批工具一起带崩`)
      continue
    }
    if (!tool.parameters || typeof tool.parameters !== 'object') bad.push(`${tool.name} 没有 parameters`)
    else {
      if (tool.parameters.type !== 'object') bad.push(`${tool.name}.parameters 的根必须是 type:"object"`)
      visit(tool.parameters, `${tool.name}.parameters`)
    }
    if (tool.output.schema.type !== 'object') bad.push(`${tool.name}.output.schema 的根必须是 type:"object"`)
    visit(tool.output.schema, `${tool.name}.output.schema`)
  }
  if (bad.length > 0) fail(`会被真机拒绝：${bad.join(' / ')}`)
  return `${tools.length} 个工具都过真机快照（@deepseek-ai/dsh-tools ${rules.source.version}）✓ 快照核对：node scripts/verify-schema-rules.mjs`
})

// --- G21 委派 API 的名字与形状必须与真机一致 --------------------------------
guard('G21', '委派用的是真机的 `startActivation(spec)`，且读回的字段是 `childId`（不是 `start` / `id`）', () => {
  // 为什么必须是守卫：**调错方法名在本地全绿**。旧代码写的是 `runtime.start(provider, request)` ——
  // 真机 `dsh-subagent` 的服务对象上**没有**这个方法（它的实例方法只有 resolveMaxDepth / interrupt /
  // listChildren / listDescendants / interruptByParent / registerProvider / startActivation）。
  // 表现是「宿主不可委派」，而人第一时间不会怀疑是自己调错了名字。
  // 凭据：`dsh-tool-subagent/lib/index.js:409`（模型面前那个 subagent 工具就这么发的）、
  //      `dsh-subagent/lib/index.js:3032`（定义）、`:2081`（回执 `{ childId, result, dispose }`）。
  const source = read(resolve(ROOT, 'src/dsh/host/verification.js'))
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  if (!/\.startActivation\s*\(/.test(code)) fail('verification.js 里没有调用 `startActivation` —— 委派入口名错了')
  if (/\.start\s*\(/.test(code)) fail('verification.js 里出现了 `.start(` —— 真机 subagents 服务上没有这个方法')
  if (!/run\?\.childId/.test(code)) fail('读回执用的是 `run?.id`？真机回的是 `{ childId, result, dispose }`')
  if (!/signal:\s*controller\.signal/.test(code)) fail('`signal` 没给 —— 真机 `startActivation` 先读 `spec.signal.throwIfAborted()`')

  // spec 的六个字段缺一不可（形状照抄模型面工具）。
  for (const key of ['provider', 'label', 'delivery', 'signal', 'request']) {
    if (!new RegExp(`\\b${key}\\s*:`).test(code)) fail(`spec 缺字段 \`${key}\``)
  }
  if (!/delivery:\s*'parent'/.test(code)) fail("`delivery` 必须是 'parent'")

  // 假运行时也必须用真机形状 —— 否则用例会在一个不存在的 API 上全绿。
  const testSource = read(resolve(ROOT, 'test/host.test.mjs'))
  if (!/async startActivation\(/.test(testSource)) fail('test/host.test.mjs 的假运行时还是旧形状（缺少 startActivation）')
  if (/async start\(/.test(testSource)) fail('test/host.test.mjs 里还有 `async start(` —— 假运行时在模拟一个不存在的 API')

  return "`startActivation(spec)` + `childId` + `spec.signal` ✓；假运行时与真机同形 ✓"
})

// --- G22 委派提示词与证据校验器必须同步 --------------------------------
guard('G22', '委派提示词把五类 locator 的**确切格式**写给验收 Agent（提示词与校验器脱节 ⇒ 每轮都因格式被拒）', () => {
  // 为什么必须有这条：真机实测（2026-10-12）连续**四轮**委派**全部**因证据格式被拒 ——
  // 子 Agent 交上来的 observation 只有一句话、command 不带 exitCode、file 用相对路径。
  // 根因不是它不配合，而是**提示词只说了「要可寻址」，没说格式长什么样**，而校验器是严格的。
  // 后果很实：每轮白跑一次委派（真金白银的 token），凭证里只有 blocked。
  const prompt = buildDelegationPrompt({
    requirementText: '原始需求',
    criteria: [{ id: 'AC-01', origin: 'original', title: '一条', method: 'manual', deletedAt: null }],
  })

  const required = [
    ['恰好 3 个', 'observation 的「3 个全角竖线」要求'],
    ['｜', 'observation 的分隔符本体'],
    ['exitCode', 'command 的整数退出码'],
    ['整数', '「整数」这个限定词'],
    [':42', 'file 的绝对路径:行号示例'],
    ['.png', 'screenshot 的扩展名'],
    ['https://', 'url 的前缀'],
    ['unknown', '拿不到合规证据时的出路'],
  ]
  const missing = required.filter(([needle]) => !prompt.includes(needle)).map(([, label]) => label)
  if (missing.length > 0) fail(`委派提示词缺：${missing.join(' / ')}`)

  // 五种 kind 的名字都要出现，否则子 Agent 不知道该写哪种。
  const absentKinds = ['command', 'file', 'url', 'screenshot', 'observation'].filter((kind) => !prompt.includes(`\`${kind}\``))
  if (absentKinds.length > 0) fail(`提示词里没点名这些证据种类：${absentKinds.join(' / ')}`)

  // 反向：提示词不许承诺校验器不接受的东西（最常见的两处口误）。
  if (/相对路径/.test(prompt.replace(/不给相对路径|相对路径或漏掉行号/g, ''))) {
    fail('提示词里出现了「相对路径」的正面说法 —— 校验器只认绝对路径')
  }
  return `五类 locator 格式齐备（含 3 个「｜」、整数 exitCode、路径:行号）✓ 提示词 ${prompt.length} 字符`
})

// --- G23 两条取证路径遵守同一条确认规则（P0-3） -----------------------------
guard('G23', 'UI 路径与 Agent 路径都只对**已确认**项取证：未确认项被跳过并写明，一条都没有则拒', () => {
  // 为什么必须有这条：2026-10-12 用户真机走查发现两条路**规则不一致** ——
  // Agent 提交路径对「有未确认项」硬挡，而 UI 路径只要求「有未删除的验收项」就照常验证。
  // 同一份凭证，一条拒一条放，用户看到的是两个自相矛盾的结论。
  const verification = read(resolve(ROOT, 'src/dsh/host/verification.js'))
  const tools = read(resolve(ROOT, 'src/dsh/host/tools.js'))
  const vCode = verification.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const tCode = tools.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  // ① UI 路径必须**真的按 confirmedByUserAt 收窄**，而不是只在注释里说
  if (!/confirmedByUserAt/.test(vCode)) {
    fail('verification.js 里没有 `confirmedByUserAt` —— UI 路径又在验证未确认项了（P0-3 的原始缺陷）')
  }
  if (!/confirmed\s*=\s*active\.filter\(/.test(vCode)) {
    fail('verification.js 没有从 active 里筛出 confirmed 集合')
  }
  // ② 委派用的提示词与 schema 必须是**收窄后**的那份（用原 receipt 就等于没筛）
  if (!/buildDelegationPrompt\(delegationReceipt\)/.test(vCode)) {
    fail('委派提示词用的不是收窄后的凭证 —— 未确认项又会被交给验收 Agent')
  }
  if (!/buildVerifySchema\(delegationReceipt\.criteria\)/.test(vCode)) {
    fail('委派 schema 用的不是收窄后的凭证')
  }
  if (!/normalizeDelegatedResult\(delegationReceipt/.test(vCode)) {
    fail('规范化用的不是收窄后的凭证 —— 已确认项之外的东西会被当成「漏项」补成 unknown')
  }
  // ③ 一条 confirmed 都没有 ⇒ 拒（两条路径都要有）
  if (!/no-confirmed-criteria/.test(vCode)) fail('UI 路径缺「一条 confirmed 都没有 ⇒ 拒」这一支')
  if (!/confirmedActive\.length === 0/.test(tCode)) fail('Agent 路径没有按「confirmed 集合为空」判断')
  // ④ 被跳过的项必须**写下来**（不是静默）
  if (!/skippedUnconfirmed/.test(vCode)) fail('verification.js 没有记录被跳过的未确认项')
  if (!/skippedUnconfirmed/.test(tCode)) fail('tools.js 没有把被跳过的未确认项报出来')

  // ⑤ 反例测试必须在：光有实现在，规则下次照样能被改掉
  const hostTests = read(resolve(ROOT, 'test/host.test.mjs'))
  const needed = ['P0-3：一条 confirmed 都没有', 'P0-3：部分确认', 'P0-3：Agent 提交路径与 UI 路径同规则']
  const missing = needed.filter((label) => !hostTests.includes(label))
  if (missing.length > 0) fail(`缺 P0-3 反例测试：${missing.join(' / ')}`)

  return '两条路径都按 confirmedByUserAt 收窄；提示词/schema/规范化三处都用收窄凭证；跳过项被记录；3 条反例测试在 ✓'
})

// --- G24 组件里不许有「Hook 写在 early return 之后」 -------------------------
guard('G24', '客户端组件：Hook 调用不得出现在 early return 之后（React error 310 会让整页白屏）', () => {
  // 为什么必须有这条，以及为什么它不是「文本层洁癖」：
  // 2026-10-12 给 Workbench 加 `confirmAllUnconfirmed` 时，因为它依赖 early return 之后才有的
  // `criteria`，就顺手把它放在了两个 early return **之后**。后果不是「顺序难看」，而是**真机白屏**：
  // 首屏 `loading=true` 走提前返回（少调一个 hook），health 到位后重渲染多调一个
  // ⇒ React error 310 `Rendered more hooks than during the previous render` ⇒
  // 宿主容器只剩 `<div data-slot-error="conversation.view">`，用户什么都看不到。
  //
  // 而且**静态渲染单测抓不到它**：`renderToStaticMarkup` 每次都新建渲染，不比较同一 fiber 两次的
  // hook 数（实测：把坏版本喂给两条静态渲染，两次都不报错）。所以这条只能在源码层守。
  const source = read(resolve(ROOT, 'src/dsh/client/client.js'))
  const lines = source.split('\n')
  const HOOK = /React\.use[A-Z]/

  /**
   * 找一个组件体里**第一个** early return 之后出现的 Hook。
   *
   * 判据刻意做得很钝：只看第一次出现的 `^\s{2}return` 行号，之后到函数结束只要还有 Hook 就算违规。
   * 不跟踪花括号深度 —— 之前那版跟踪写错了，守卫把自己判成「检测逻辑失效」。
   * 钝判据会多报（嵌套回调里的 hook 理论上合法），但**宁可贵一点，也不许漏掉整页白屏**；
   * 真多报了，就该把那个 hook 挪到前面去。
   */
  function hooksAfterEarlyReturn(bodyLines, baseLine) {
    let early = -1
    const hits = []
    bodyLines.forEach((line, index) => {
      if (early < 0 && /^\s{2}return\b/.test(line)) early = index
      if (early >= 0 && index > early && HOOK.test(line)) {
        hits.push(`${baseLine + index + 1}  ${line.trim().slice(0, 70)}`)
      }
    })
    return hits
  }

  /** 取一个函数体（从 `function NAME(` 起，按花括号配平到 `^}`）。 */
  function bodyOf(name) {
    const at = lines.findIndex((line) => new RegExp(`^function ${name}\\(`).test(line))
    if (at < 0) fail(`源码里找不到 function ${name}(…) —— 那条 hook 纪律就没人守了`)
    let depth = 0
    for (let i = at; i < lines.length; i++) {
      for (const ch of lines[i]) {
        if (ch === '{') depth += 1
        else if (ch === '}') depth -= 1
      }
      if (i > at && depth === 0) return { start: at, end: i }
    }
    return fail(`function ${name} 的花括号没配平`)
  }

  const components = ['Workbench', 'DetailPane', 'ReverifyButton', 'CriterionActions', 'JudgementBlock', 'RoundList', 'FooterBar', 'MoreWays', 'NextStep']
  const offenders = []
  for (const component of components) {
    const { start: at, end } = bodyOf(component)
    for (const hit of hooksAfterEarlyReturn(lines.slice(at, end + 1), at)) offenders.push(`${component}:${hit}`)
  }
  if (offenders.length > 0) {
    fail(
      `Hook 出现在 early return 之后 ⇒ 首屏与二次渲染的 hook 数不一致 ⇒ React error 310、整页白屏：\n        ${offenders.join('\n        ')}\n` +
        '        修法：把该 hook 移到所有 early return 之前，并让它只依赖那时就已经可用的值（通常从 props/state 自己算）。',
    )
  }

  // 自测：确认这个判据真能看见那种写法（防止守卫空转 —— 「全绿」不等于「在跑」）
  // 缩进必须与真实源码一致（函数体顶层 2 空格）—— 探针缩进写错，就是在骗守卫。
  const probe = [
    'function X() {',
    '  const a = React.useState(0)',
    '  if (a) {',
    '    return null',
    '  }',
    '  return null',
    '  const b = React.useMemo(() => 1, [])',
    '}',
  ]
  if (hooksAfterEarlyReturn(probe, 0).length === 0) fail('G24 的检测逻辑自己失效了（自测探针没被判定为违规）')
  return `${components.length} 个组件：0 处「Hook 在 early return 之后」；自测探针能命中 ✓`
})

// --- G13 权力分离：工具层不许改需求、不许代替人类决定 ----------------------
guard('G13', '工具层不得写 requirementText、不得产生 decision（`requirementText` 只在建任务时写一次）', () => {
  const source = read(resolve(ROOT, 'src/dsh/host/tools.js'))
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  // 只允许 `createReceipt({ requirementText, … })` 这一处 —— 它是**新建**任务时逐字存入原文。
  // 按「赋值形态」（`requirementText,`）数，**不数 schema 里的对象键** `requirementText: {...}`。
  const writesRequirement = [...code.matchAll(/requirementText\s*,/g)].length
  if (writesRequirement !== 1) {
    fail(`tools.js 里出现 ${writesRequirement} 处 requirementText 赋值 —— 只允许建任务那一次`)
  }
  const createCalls = [...code.matchAll(/createReceipt\s*\(/g)].length
  if (createCalls !== 1) fail(`tools.js 里 createReceipt 被调了 ${createCalls} 次 —— 建任务只该有一处`)
  // 只拦「赋值给已有的 requirementText」；`const requirementText = …` 是**读**入参，不是改写凭证。
  if (/(?<!const\s)requirementText\s*=(?!=)/.test(code)) fail('tools.js 里对 requirementText 做了赋值 —— 工具不得改写原始需求')
  // 回读 `receipt.decision` 是允许的（工具要告诉模型「现在轮到人了」）；**写**才违规。
  // 用词边界，否则 `humanDecisionRequired` 会被误判成写 decision。
  if (/(?<![.\w])decision\s*=(?!=)/.test(code)) {
    fail('tools.js 里出现了 decision 赋值 —— 最终决定只能由人在界面产生（PRD §9.3）')
  }
  // 工具也不许自己「确认」验收项。
  if (/confirmedByUserAt\s*:\s*now/.test(code) || /confirmedByUserAt\s*:\s*new Date/.test(code)) {
    fail('工具层写了 confirmedByUserAt —— 确认权在用户，Agent 只能提议（SDD §2.2）')
  }
  return '工具层不写 requirementText（除建任务那一次）/ 不写 decision / 不替用户确认 ✓'
})

// --- G14 身份单一来源：参数里不许出现身份与工作区 --------------------------
guard('G14', '工具的 parameters 里不出现 sessionId / workspace / cwd（身份只能由宿主从 exec.agent 解析）', () => {
  const { tools } = fakeTools()
  const offenders = []
  for (const tool of tools) {
    // 只看 schema 的**键**，不看 description 正文 —— 正文里解释「为什么不要 sessionId」是应该的。
    const keys = []
    const collect = (node, path) => {
      if (Array.isArray(node) || !node || typeof node !== 'object') return
      for (const [key, value] of Object.entries(node)) {
        if (['properties', 'required'].includes(path.split('.').pop()) || path.includes('properties')) keys.push(key)
        if (key === 'properties') {
          for (const [prop, sub] of Object.entries(value ?? {})) {
            keys.push(prop)
            collect(sub, `${path}.properties.${prop}`)
          }
        } else if (key === 'items') {
          collect(value, `${path}.items`)
        }
      }
    }
    collect(tool.parameters, tool.name)
    for (const forbidden of ['sessionId', 'session_id', 'workspace', 'cwd', 'sessionID']) {
      if (keys.includes(forbidden)) offenders.push(`${tool.name}.${forbidden}`)
    }
  }
  if (offenders.length > 0) fail(`参数里出现身份字段：${offenders.join(' / ')}`)

  // 源码层面再钉一次：`execute` 里不许从 args 解构身份。
  const source = read(resolve(ROOT, 'src/dsh/host/tools.js'))
  if (/args\??\.(sessionId|workspace|cwd)\b/.test(source)) {
    fail('execute() 从 args 里取身份/工作区 —— 那等于让调用方自报身份（L0 §10 第 4 条同构）')
  }
  return `${tools.length} 个工具的参数里没有身份字段；身份只来自 exec.agent.session.id ✓`
})

// --- G15 返修项举证：fail 要证据，unknown/blocked 要说清缺什么 -------------
guard('G15', '返修项必须带 evidenceIds 或 unverifiedReason，二者皆缺一律拒（含正反例）', () => {
  const base = { criterionId: 'AC-01' }
  const cases = [
    // [说明, 项, 期望是否合法]
    ['fail + 证据', { ...base, status: 'fail', evidenceIds: ['EV-0001'] }, true],
    ['fail 无证据', { ...base, status: 'fail' }, false],
    ['fail 空证据数组', { ...base, status: 'fail', evidenceIds: [] }, false],
    ['unknown + 原因', { ...base, status: 'unknown', unverifiedReason: '没有可寻址的日志' }, true],
    ['unknown 无原因', { ...base, status: 'unknown' }, false],
    ['unknown 只给证据（没说缺什么）', { ...base, status: 'unknown', evidenceIds: ['EV-0001'] }, false],
    ['blocked + 原因', { ...base, status: 'blocked', unverifiedReason: '服务起不来' }, true],
    ['blocked 无原因', { ...base, status: 'blocked' }, false],
    ['pass 不该进返修清单', { ...base, status: 'pass', evidenceIds: ['EV-0001'] }, false],
    ['pending 不该进返修清单', { ...base, status: 'pending' }, false],
    ['status 不是五态', { ...base, status: 'ok' }, false],
    ['没有 criterionId', { status: 'fail', evidenceIds: ['EV-0001'] }, false],
  ]
  const wrong = []
  for (const [label, item, expected] of cases) {
    const errors = validateRepairItem(item)
    const ok = errors.length === 0
    if (ok !== expected) wrong.push(`${label}（期望${expected ? '通过' : '被拒'}，实为${ok ? '通过' : '被拒'}：${errors.join('；')}）`)
  }
  if (wrong.length > 0) fail(`返修项校验与规则不符：${wrong.join(' / ')}`)
  return `${cases.length} 条反例（含 7 条必须被拒）全部符合 ✓`
})

// --- G16 三句不同的话：blocked / unknown 不许被说成 fail ------------------
guard('G16', '五种状态的显示名各自不同、与评审定稿逐字一致，且客户端与导出用同一套词', () => {
  // 这条守卫 2026-10-12 首版是**空转**的：它只查五个词「都出现过」，于是把
  // `blocked: '未通过'`（把环境阻塞合并进未通过）判成通过 —— 因为「未通过」本来就在词表里，
  // 而「环境阻塞」还留在客户端的 EN 字典里。**「出现过」不等于「映射对」。**
  // 现在直接钉映射本身 + 钉「不许两态同名」。
  const EXPECTED = { pending: '待验收', pass: '通过', fail: '未通过', unknown: '无法判断', blocked: '环境阻塞' }
  const mismatched = []
  for (const [status, label] of Object.entries(EXPECTED)) {
    if (STATUS_LABELS[status] !== label) {
      mismatched.push(`${status} 应为「${label}」，实为「${STATUS_LABELS[status]}」`)
    }
  }
  if (mismatched.length > 0) fail(`显示名与评审定稿不一致：${mismatched.join(' / ')}`)

  // 两态同名 = 三句话被合并成两句，是最典型的退化。这条能抓住「blocked 改成未通过」。
  const labels = STATUSES.map((status) => STATUS_LABELS[status])
  const duplicated = labels.filter((label, index) => labels.indexOf(label) !== index)
  if (duplicated.length > 0) fail(`有两个状态用了同一个显示名：${[...new Set(duplicated)].join(' / ')}`)

  // 导出模板必须用同一套词 —— 导出比界面更可信就是退步。
  const domain = read(resolve(ROOT, 'src/dsh/host/domain.js'))
  const exportUses = Object.fromEntries(
    Object.entries(EXPECTED).map(([status, label]) => [status, domain.includes(label)]),
  )
  const missingInExport = Object.entries(exportUses).filter(([, used]) => !used).map(([status]) => status)
  if (missingInExport.length > 0) fail(`导出模板里找不到这些显示名：${missingInExport.join(' / ')}`)

  // 客户端产物必须用**同一套词**：把 dist 里的映射对抽出来逐个比。
  const client = read(resolve(ROOT, 'dist/client.js'))
  // 映射对在产物里可能出现不止一次（打包器会把同一张表内联到多处），所以按状态**归并**，
  // 并且要求同一状态的所有出现**互相一致** —— 两处各说一套词同样是退化。
  // 只取**显示名**那张表：客户端还有一张同形状的解释句表（`{pending:{zh:"还没有针对…"}}`），
  // 所以把匹配限制在短标签上 —— 否则解释句会被当成第二套词。
  const clientPairs = [...client.matchAll(/(pending|pass|fail|unknown|blocked):\{zh:"([^"]{2,6})"/g)]
  const byStatus = new Map()
  for (const [, status, label] of clientPairs) {
    if (!byStatus.has(status)) byStatus.set(status, new Set())
    byStatus.get(status).add(label)
  }
  const missingInClient = STATUSES.filter((status) => !byStatus.has(status))
  if (missingInClient.length > 0) {
    fail(`客户端产物里扫不到这些状态的显示名：${missingInClient.join(' / ')} —— 提取正则失效或客户端少了状态`)
  }
  const clientMismatch = []
  for (const [status, labels] of byStatus) {
    if (labels.size > 1) clientMismatch.push(`${status} 在客户端内部就有两套词：${[...labels].join(' / ')}`)
    for (const label of labels) {
      if (EXPECTED[status] !== label) clientMismatch.push(`${status} 在客户端是「${label}」，契约是「${EXPECTED[status]}」`)
    }
  }
  if (clientMismatch.length > 0) fail(`客户端与宿主用了两套词：${clientMismatch.join(' / ')}`)

  // 合并的最典型形状：显式把 blocked / unknown 映射成 fail。
  if (/blocked['"]?\s*:\s*['"]fail['"]/.test(client) || /'blocked'\s*=>\s*'fail'/.test(client)) {
    fail('客户端把 blocked 映射成了 fail')
  }
  if (/unknown['"]?\s*:\s*['"]fail['"]/.test(client) || /'unknown'\s*=>\s*'fail'/.test(client)) {
    fail('客户端把 unknown 映射成了 fail')
  }
  return `五态显示名各自不同、与定稿逐字一致；客户端与导出同一套词（0 处两态同名）✓`
})

// --- G17 三轴不合并：任务流程态 / 结论态 / 运行态 ---------------------------
guard('G17', '三轴不合并：顶层不出现承载任务流程态的 status；lifecycle 与 runStatus 是分开的字段', () => {
  const domain = read(resolve(ROOT, 'src/dsh/host/domain.js'))
  // `createReceipt` 的返回值里不许出现顶层 `status`（结论态长在 rounds[].evaluations[] 上）。
  const create = domain.slice(domain.indexOf('export function createReceipt'), domain.indexOf('export function validateReceipt'))
  if (/^\s*status\s*:/m.test(create)) fail('createReceipt 返回了顶层 status —— 三轴合并的第一种形状')
  // 结论态字段名必须仍挂在 evaluations 上（G4 已钉五态字面量，这里钉位置）。
  if (!domain.includes('evaluations')) fail('domain.js 里找不到 evaluations —— 结论态被搬走了？')
  // 运行态取值必须是独立的一套，不许复用五态字面量。
  const tools = read(resolve(ROOT, 'src/dsh/host/tools.js'))
  const runStatuses = [...new Set([...tools.matchAll(/runStatus:\s*'([a-z_]+)'/g)].map((m) => m[1]))]
  const clashing = runStatuses.filter((value) => STATUSES.includes(value))
  if (clashing.length > 0) fail(`运行态用了五态字面量：${clashing.join(' / ')} —— 两轴被合并了`)
  return `顶层无 status；结论态仍在 evaluations[]；运行态 ${runStatuses.join('/') || '（未出现）'} 与五态不重叠 ✓`
})

// --- G18 轮次上限：2 轮，到限必须停并交人 ---------------------------------
guard('G18', `自动返修上限恰为 ${DEFAULT_ROUND_LIMIT} 轮，且到限后要求人类决定`, () => {
  if (DEFAULT_ROUND_LIMIT !== 2) fail(`上限是 ${DEFAULT_ROUND_LIMIT} —— 与 SDD §16.2 写死的 2 轮不符`)
  const { tools, receipts } = fakeTools()
  const receipt = {
    schemaVersion: SCHEMA_VERSION,
    receiptId: 'AR-0001',
    taskId: 't-limit',
    requirementText: '需求',
    criteria: [
      { id: 'AC-01', origin: 'original', title: '一条', confirmedByUserAt: '2026-10-12T00:00:00.000Z', deletedAt: null },
    ],
    rounds: [],
    evidence: [],
    repairs: [],
    decision: null,
  }
  receipts['t-limit'] = receipt
  const getResult = toolNamed(tools, 'acceptance_get_result')
  return Promise.resolve(getResult.execute({ taskId: 't-limit' }, { agent: { session: { id: 'live' } } })).then((result) => {
    if (result.ok !== true) fail(`get_result 没取到：${JSON.stringify(result)}`)
    if (result.roundLimit !== 2) fail(`工具报的 roundLimit 是 ${result.roundLimit}，应为 2`)
    if (result.round >= result.roundLimit && result.humanDecisionRequired !== true) {
      fail(`轮次 ${result.round} 已达上限 ${result.roundLimit}，却没有要求人类决定`)
    }
    return `上限 = ${DEFAULT_ROUND_LIMIT}；工具在达到上限时置 humanDecisionRequired ✓`
  })
})

// --- G19 引导与工具可见性同生共死 ------------------------------------------
guard('G19', '工具引导文字只在工具对当前 agent 可见时渲染（不许维护两套开关）', () => {
  const host = read(resolve(ROOT, 'src/dsh/host/index.js'))
  if (!/systemPrompt/.test(host)) {
    // 还没装引导节：这是**未做**，不是违规。但要吵 —— 否则「没查」和「没问题」长得一样。
    return '尚未安装 systemPrompt 引导节（SDD §14.6 未实现）—— 一旦安装，text() 必须先查 ctx.tools.get(name, agent)'
  }
  if (!/tools\.get\(/.test(host)) {
    fail('装了 systemPrompt 引导节，但 text() 不查 ctx.tools.get(name, agent) —— 工具被 restrict 掉后提示还在叫模型调用它')
  }
  return '引导节存在，且只在工具对当前 agent 可见时渲染 ✓'
})

// --- G20 工具边界不抛：三条件都必须回信封 ---------------------------------
guard('G20', '工具边界不抛：无 Agent 上下文 / 非法参数 / 没有委派服务，三条都回信封', async () => {
  const { tools } = fakeTools()
  const cases = [
    ['无 Agent 上下文', 'acceptance_begin_task', { requirementText: 'x' }, {}],
    ['空 requirementText', 'acceptance_begin_task', { requirementText: '   ' }, { agent: { session: { id: 'live' } } }],
    ['缺 taskId', 'acceptance_get_result', {}, { agent: { session: { id: 'live' } } }],
    ['非法 taskId', 'acceptance_get_result', { taskId: '../etc/passwd' }, { agent: { session: { id: 'live' } } }],
    ['任务不存在', 'acceptance_get_result', { taskId: 'no-such-task' }, { agent: { session: { id: 'live' } } }],
    ['没有委派服务', 'acceptance_submit_delivery', { taskId: 'no-such-task' }, { agent: { session: { id: 'live' } } }],
  ]
  const bad = []
  for (const [label, name, args, exec] of cases) {
    const tool = toolNamed(tools, name)
    let result
    try {
      result = await tool.execute(args, exec)
    } catch (error) {
      bad.push(`${label} 抛了异常：${error?.message ?? error}`)
      continue
    }
    if (!result || typeof result !== 'object') bad.push(`${label} 没回对象`)
    else if (result.ok !== false) bad.push(`${label} 的 ok 不是 false（实为 ${JSON.stringify(result.ok)}）`)
    else if (typeof result.reason !== 'string' || result.reason === '') bad.push(`${label} 没给 reason 码`)
  }
  if (bad.length > 0) fail(bad.join(' / '))
  return `${cases.length} 条失败路径全部回信封、零异常 ✓`
})

// --- 报告 ------------------------------------------------------------------
await settleGuards()
const failed = results.filter((item) => !item.ok)
for (const item of results) {
  console.log(`${item.ok ? '  ok ' : ' FAIL'}  ${item.id}  ${item.title}`)
  if (item.detail) console.log(`        ${item.detail}`)
}
console.log('')
console.log(`${results.length - failed.length}/${results.length} 守卫通过`)
if (failed.length > 0) {
  console.error(`\n${failed.length} 个守卫未通过。`)
  process.exit(1)
}
