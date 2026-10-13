#!/usr/bin/env node
/**
 * 核对 `design/dsh-tool-schema-rules.json` 是否仍与**已安装的真机运行时**一致。
 *
 * 为什么要有这个脚本：
 *  工具 schema 写错的后果不是构建失败，而是**重启 DSH 之后工具装不上**（而且是把整批一起带崩）。
 *  把它落成守卫（G12）是第一步；但守卫用的是**快照**，快照会随 DSH 升级**悄悄过期** ——
 *  过期之后守卫仍然全绿，只是它守的是一份过时规则。所以快照必须能被重新核对。
 *
 * 为什么不在守卫里直接读运行时：
 *  真机运行时打在 `app.asar` **文件**里，只有 Electron 的 Node 读得进去（`existsSync` 对 asar 内部路径恒 false）。
 *  让 `npm run verify` 每次都去 spawn 一次 Electron，既慢又脆（Electron 不在、超时、被沙箱挡住都会挂）。
 *  ⇒ 拆成两件：**守卫读快照（快、无依赖）**，**这个脚本负责证明快照没过期（慢、要运行时）**。
 *
 * 用法：
 *   node scripts/verify-schema-rules.mjs                       # 自动找已安装的运行时
 *   DSH_ACCEPTANCE_DSH_ROOT=… node scripts/verify-schema-rules.mjs
 *
 * 退出码 0 = 快照与运行时逐条一致；1 = 分叉（快照该更新了）或找不到运行时。
 *
 * @module scripts/verify-schema-rules
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SNAPSHOT = join(ROOT, 'design/dsh-tool-schema-rules.json')
const ELECTRON_BIN = '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness'
const DESKTOP_ASAR = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh'

const snapshot = JSON.parse(readFileSync(SNAPSHOT, 'utf8'))

/**
 * 候选运行时根。
 *
 * ⚠️ **不许用 `existsSync` 预筛**：`existsSync` 在**任何含 `.asar` 的路径上都返回 false** ——
 * 连 `…/Resources/app.asar` 这个**真实存在的文件**也不例外（实测：含 asar 段的路径一律 false）。
 * 早先按「外层目录在不在」筛，结果把唯一可用的候选筛掉了，报告却只说「找不到运行时」。
 * ⇒ 判据只能是**跑得起来**：谁都不筛，逐个 spawn 探针。
 */
function candidates() {
  const out = []
  if (process.env.DSH_ACCEPTANCE_DSH_ROOT) out.push(process.env.DSH_ACCEPTANCE_DSH_ROOT)
  out.push(DESKTOP_ASAR)
  out.push(join(homedir(), '.dsh/profiles/node_modules/@deepseek-ai/dsh'))
  return out
}

/** 在运行时里读 `dsh-tools` 的关键字/类型/同级关键字常量。可用性由「跑得起来」判定。 */
function readRealRules(root) {
  const source = `
const fs = require('node:fs')
const dir = ${JSON.stringify(root)} + '/node_modules/@deepseek-ai/dsh-tools'
const pkg = JSON.parse(fs.readFileSync(dir + '/package.json', 'utf8'))
const src = fs.readFileSync(dir + '/lib/index.js', 'utf8')
const grab = (name) => {
  const i = src.indexOf('const ' + name)
  if (i < 0) return null
  const semi = src.indexOf(';', i)
  const body = src.slice(i, semi < 0 ? i + 400 : semi)
  return [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1])
}
console.log(JSON.stringify({
  version: pkg.version,
  types: grab('SCHEMA_TYPES'),
  siblings: grab('ONE_OF_SIBLING_KEYWORDS'),
  annotations: grab('ANNOTATION_KEYS'),
  // 关键字白名单在内联 Set 里，没有具名常量 ⇒ 从违规信息里抄（那句话本身就是权威叙述）。
  keywordsFromMessage: (src.match(/subset: ([^)]*)\\/\s*\\)/) || [])[1] || null,
  registerRequiresOutput: /must declare output \\{ schema, render/.test(src),
}))
`
  const stdout = execFileSync(ELECTRON_BIN, ['-e', source], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60000,
  })
  const line = stdout.trim().split('\n').filter(Boolean).pop()
  return JSON.parse(line)
}

const list = candidates()
if (list.length === 0) {
  console.error('✗ 找不到 DSH 运行时。用 DSH_ACCEPTANCE_DSH_ROOT 指一个（解包形态的 dsh 根目录）。')
  process.exit(1)
}

let real = null
const failures = []
for (const root of list) {
  try {
    real = readRealRules(root)
    real.root = root
    break
  } catch (error) {
    const stderr = String(error?.stderr ?? '').trim().split('\n').slice(0, 2).join(' / ')
    failures.push(`${root}：${error?.message ?? error}${stderr ? ` :: ${stderr}` : ''}`)
  }
}
if (!real) {
  console.error(`✗ 找到了候选目录但都跑不起来：\n  ${failures.join('\n  ')}`)
  console.error(`  （Electron 可执行文件：${existsSync(ELECTRON_BIN) ? '在' : '**不在**'} ${ELECTRON_BIN}）`)
  process.exit(1)
}

const same = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i])
const diffs = []
if (!same(real.types, snapshot.types)) diffs.push(`types：真机 ${JSON.stringify(real.types)} ≠ 快照 ${JSON.stringify(snapshot.types)}`)
if (!same(real.siblings, snapshot.oneOfSiblingKeywords)) {
  diffs.push(`oneOfSiblingKeywords：真机 ${JSON.stringify(real.siblings)} ≠ 快照 ${JSON.stringify(snapshot.oneOfSiblingKeywords)}`)
}
if (!same(real.annotations, snapshot.annotations)) {
  diffs.push(`annotations：真机 ${JSON.stringify(real.annotations)} ≠ 快照 ${JSON.stringify(snapshot.annotations)}`)
}
if (real.registerRequiresOutput !== true) diffs.push('真机 register() 似乎不再要求 output —— 快照里那条规则要重写')
if (real.version !== snapshot.source.version) {
  diffs.push(`运行时版本变了：真机 ${real.version} ≠ 快照 ${snapshot.source.version}（快照要重新抄一遍并复核）`)
}

if (diffs.length > 0) {
  console.error(`✗ 快照已与真机分叉（${real.root}，@deepseek-ai/dsh-tools ${real.version}）：`)
  for (const diff of diffs) console.error(`  - ${diff}`)
  console.error('\n  更新 design/dsh-tool-schema-rules.json 后重跑；G12 读的是这份快照。')
  process.exit(1)
}

console.log(`✓ 快照与真机一致（@deepseek-ai/dsh-tools ${real.version}，${real.root.includes('app.asar') ? 'app.asar 内' : real.root}）`)
console.log(`  关键字白名单（真机违规信息原文）：${real.keywordsFromMessage ?? '（未读到，快照为准）'}`)
