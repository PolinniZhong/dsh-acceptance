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

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { shippedBundleIsFresh } from './build-client.mjs'
import {
  ORIGINS,
  PRODUCERS,
  SCHEMA_VERSION,
  STATUSES,
  buildVerifySchema,
  nextCriterionId,
  validateEvidence,
} from '../src/dsh/host/domain.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const results = []
function guard(id, title, fn) {
  try {
    const detail = fn()
    results.push({ id, title, ok: true, detail: detail ?? '' })
  } catch (error) {
    results.push({ id, title, ok: false, detail: String(error?.message ?? error) })
  }
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
  const ALLOWED = new Set([
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

// --- 报告 ------------------------------------------------------------------
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
