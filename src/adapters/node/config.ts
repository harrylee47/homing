/**
 * Node 运行时配置。所有值可由环境变量注入，留空则取安全默认。
 * 文件系统访问只允许出现在适配层（硬约束③）。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fromHex, generateDek, toHex } from '../../core/crypto.js'
import { log } from '../../core/logging.js'

export interface NodeConfig {
  port: number
  host: string
  dataDir: string
  dbPath: string
  dek: Uint8Array
  /** 允许的 WS Origin。Agent 不发 Origin，浏览器必发——见 wsserver 的校验逻辑。 */
  baseUrl: string | null
  trustedProxy: string | null
}

export function loadConfig(): NodeConfig {
  const dataDir = process.env.GW_DATA_DIR ?? './data'
  mkdirSync(dataDir, { recursive: true })

  return {
    port: Number(process.env.GW_PORT ?? 8070),
    // 默认只绑本机：容器内由反代访问，不存在「启动即裸奔」的窗口
    host: process.env.GW_HOST ?? '127.0.0.1',
    dataDir,
    dbPath: process.env.GW_DB_PATH ?? join(dataDir, 'gateway.db'),
    dek: loadOrCreateDek(dataDir),
    baseUrl: process.env.GW_BASE_URL ?? null,
    trustedProxy: process.env.GW_TRUSTED_PROXY ?? null,
  }
}

/**
 * DEK 优先从环境变量读，否则用 /data 下的文件，都没有就生成一个。
 *
 * 注意计划 §12.5 的提醒：GW_DEK 与 data 目录不要备份到同一处，
 * 两者同时泄露等于未加密。
 */
function loadOrCreateDek(dataDir: string): Uint8Array {
  const fromEnv = process.env.GW_DEK
  if (fromEnv) {
    const k = fromHex(fromEnv)
    if (k.length !== 32) throw new Error('GW_DEK 必须是 64 位 hex（32 字节）')
    return k
  }

  const path = join(dataDir, 'dek.key')
  if (existsSync(path)) return fromHex(readFileSync(path, 'utf8'))

  const dek = generateDek()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, toHex(dek), { mode: 0o600 })
  chmodSync(path, 0o600)
  log.warn('已生成新的数据加密密钥（DEK）', { path, hint: '请单独备份，不要与 data 目录放在一起' })
  return dek
}
