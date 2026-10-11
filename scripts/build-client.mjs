#!/usr/bin/env node
/**
 * 打包 DSH web shell 加载的客户端 bundle。
 *
 * shell 读插件的 `./client` 导出时是**逐字读**、不做任何打包；运行期模块表只认得
 * **平台 seed 词**、别的插件注册过的 client、或已经落到表里的东西。其余一律在浏览器里
 * 抛 `externals drift`。所以本脚本做两件不可省的事：
 *
 *   1. 把非 seed 词的依赖**内联**进产物。
 *   2. 产物若仍要求 seed 表之外的模块，**直接让构建失败** —— 否则这个问题只会在
 *      用户重启后的浏览器里表现为「插件空白」。
 *
 * 另外给产物打一份源码哈希 stamp：没有它，「改了客户端忘了重建」会静默上线旧界面。
 *
 * @module scripts/build-client
 */

import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 客户端注册用的包标识。 */
export const CLIENT_ID = 'dsh-acceptance'

/** DSH web shell 会 seed 进客户端模块表的全部模块（照 `dsh-skill-trace` 实测同款）。 */
export const CLIENT_SEED_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

export const CLIENT_SOURCE_DIR = 'src/dsh/client'
export const CLIENT_OUTPUT = 'dist/client.js'
export const CLIENT_STAMP = 'dsh-acceptance:client-build'

/**
 * 找到 esbuild。
 *
 * 本地 `node_modules` 是首选；但插件常以 `link:` 方式挂在 profile 里，profile 的
 * `node_modules` **不含** esbuild（已实测）。所以这里允许显式指定，并在都找不到时
 * 给出一句能照做的错误，而不是一个 `ERR_MODULE_NOT_FOUND`。
 */
async function loadEsbuild() {
  const candidates = [process.env.DSH_ACCEPTANCE_ESBUILD, 'esbuild'].filter(Boolean)
  const failures = []
  for (const candidate of candidates) {
    try {
      return await import(candidate)
    } catch (error) {
      failures.push(`${candidate}: ${error?.message ?? error}`)
    }
  }
  throw new Error(
    `找不到 esbuild。请在 ${ROOT} 下跑 \`npm install\`，` +
      `或用 \`DSH_ACCEPTANCE_ESBUILD=/绝对路径/to/esbuild/lib/main.js\` 指定。\n` +
      failures.map((line) => `  - ${line}`).join('\n'),
  )
}

/** 每个客户端源文件的哈希，用来判定产物是否过期。 */
export function clientSourceHash() {
  const dir = resolve(ROOT, CLIENT_SOURCE_DIR)
  const hash = createHash('sha256')
  for (const name of readdirSync(dir).sort()) {
    hash.update(name)
    hash.update(readFileSync(join(dir, name)))
  }
  hash.update(CLIENT_SEED_MODULES.join(','))
  hash.update(CLIENT_ID)
  return hash.digest('hex').slice(0, 16)
}

/** shell 期望的插件客户端注册外壳。 */
function wrap(bundled) {
  return `window.__ModuleLoader__.load({
  id: ${JSON.stringify(CLIENT_ID)},
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    ;(() => {
${bundled}
    })()
    return module.exports
  },
})
`
}

/** 产物里剩下的每一个 `require("...")` 说明符。 */
export function externalRequiresOf(source) {
  const found = new Set()
  for (const match of source.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)) found.add(match[1])
  return [...found].sort()
}

/**
 * 打包客户端。
 *
 * @returns `{ code, map, hash, externals }`
 * @throws 产物要求 shell 解析不了的模块时
 */
export async function bundleClient({ minify = true, sourcemap = true } = {}) {
  const { build } = await loadEsbuild()
  const result = await build({
    entryPoints: [resolve(ROOT, CLIENT_SOURCE_DIR, 'client.js')],
    // external sourcemap 需要一个输出路径（即便不写盘）；basename 同时是 map 的 `file` 字段，
    // 必须与 shell 提供该 bundle 的名字一致。
    outfile: resolve(ROOT, CLIENT_OUTPUT),
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    target: ['es2022'],
    // shell 以 `text/javascript; charset=utf-8` 提供 bundle，转义非 ASCII 只会撑大产物并藏起文案。
    charset: 'utf8',
    loader: { '.css': 'text' },
    minify,
    sourcemap: sourcemap ? 'external' : false,
    external: CLIENT_SEED_MODULES,
    write: false,
    logLevel: 'warning',
  })

  const hash = clientSourceHash()
  const js = result.outputFiles.find((file) => file.path.endsWith('.js'))
  const map = result.outputFiles.find((file) => file.path.endsWith('.map'))
  if (!js) throw new Error('esbuild 没有产出 .js —— 这是构建配置出了问题，不是客户端代码')
  const body = `${js.text}\n// ${CLIENT_STAMP} ${hash}\n`
  const code = wrap(body)

  const externals = externalRequiresOf(js.text)
  const unresolved = externals.filter((spec) => !CLIENT_SEED_MODULES.includes(spec))
  if (unresolved.length > 0) {
    throw new Error(
      `客户端 bundle 要求了 web shell 解析不了的模块：${unresolved.join(', ')}\n` +
        '把它们作为依赖内联，否则浏览器里会抛 "externals drift"。',
    )
  }

  return { code, map: map?.text ?? null, hash, externals }
}

/** 打包并写出 `dist/client.js`（+ map）。 */
export async function writeClientBundle(options) {
  const { code, map, hash, externals } = await bundleClient(options)
  const out = resolve(ROOT, CLIENT_OUTPUT)
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, code)
  if (map) writeFileSync(`${out}.map`, map)
  return { out, bytes: Buffer.byteLength(code), hash, externals }
}

/** 已发布的 bundle 是否由当前客户端源码构建（守卫 G6）。 */
export function shippedBundleIsFresh() {
  try {
    const code = readFileSync(resolve(ROOT, CLIENT_OUTPUT), 'utf8')
    const match = new RegExp(`${CLIENT_STAMP} ([0-9a-f]+)`).exec(code)
    return match !== null && match[1] === clientSourceHash()
  } catch {
    return false
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { out, bytes, hash, externals } = await writeClientBundle()
  console.log(`built ${CLIENT_OUTPUT} (${(bytes / 1024).toFixed(1)} KB) → ${out}`)
  console.log(`  source hash : ${hash}`)
  console.log(`  externals   : ${externals.join(', ') || '(none)'}`)
}
