/**
 * 凭证存储（SDD §8）。真源 = `<dataRoot>/acceptance/`，按 `taskId` 分文件。
 *
 * 每条写路径都是**原子写**：先写临时文件再 `rename`。半截的 JSON 比没有 JSON 更危险 ——
 * 它会被读成一个「结构合法但内容缺失」的凭证，然后被当成事实。
 *
 * @module src/dsh/host/store
 */

import { randomBytes } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const FILE_MODE = 0o600
const DIR_MODE = 0o700

/** taskId 同时用作文件名 ⇒ 必须白名单，否则 `../` 就能写出目录。 */
const SAFE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/** 默认根 = `~/.dsh/acceptance`。 */
export function defaultRoot() {
  return join(homedir(), '.dsh', 'acceptance')
}

/**
 * 解析某任务的凭证文件路径。非法 `taskId` **直接抛错**，不做任何清洗。
 */
export function taskFile(root, taskId) {
  if (!SAFE_TASK_ID.test(String(taskId ?? ''))) {
    throw new Error(`非法 taskId：${JSON.stringify(taskId)}`)
  }
  return join(root, 'acceptance', `${taskId}.json`)
}

export class ReceiptStore {
  /** @param {string} root 数据根目录 */
  constructor(root = defaultRoot()) {
    this.root = root
  }

  get dir() {
    return join(this.root, 'acceptance')
  }

  async #ensureDir() {
    await mkdir(this.dir, { recursive: true, mode: DIR_MODE })
  }

  /** 读一份凭证；不存在返回 `null`（**不**返回空壳）。 */
  async read(taskId) {
    const target = taskFile(this.root, taskId)
    try {
      return JSON.parse(await readFile(target, 'utf8'))
    } catch (error) {
      if (error?.code === 'ENOENT') return null
      throw error
    }
  }

  /** 原子写一份凭证。 */
  async write(receipt) {
    const target = taskFile(this.root, receipt?.taskId)
    await this.#ensureDir()
    const temporary = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
    try {
      await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: FILE_MODE })
      await rename(temporary, target)
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {})
      throw error
    }
    return receipt
  }

  /** 列出全部任务的摘要。坏文件**计入 `broken` 而不被跳过** —— 悄悄丢一份凭证是数据丢失。 */
  async list() {
    await this.#ensureDir()
    const entries = await readdir(this.dir, { withFileTypes: true })
    const tasks = []
    const broken = []
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const taskId = entry.name.slice(0, -'.json'.length)
      try {
        const receipt = JSON.parse(await readFile(join(this.dir, entry.name), 'utf8'))
        tasks.push({
          taskId,
          taskTitle: receipt?.taskTitle ?? '',
          updatedAt: receipt?.updatedAt ?? null,
          criteriaCount: Array.isArray(receipt?.criteria) ? receipt.criteria.filter((c) => !c?.deletedAt).length : 0,
          roundCount: Array.isArray(receipt?.rounds) ? receipt.rounds.length : 0,
        })
      } catch (error) {
        broken.push({ taskId, error: String(error?.message ?? error) })
      }
    }
    tasks.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
    return { tasks, broken }
  }
}
