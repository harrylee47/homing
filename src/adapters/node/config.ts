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
  /** 管理 API 的 Bearer token。M3 上线口令 + TOTP 后由会话取代。 */
  adminToken: string
  /** 控制台静态文件目录 */
  webRoot: string
  /**
   * 自建 bark-server 的上游地址。设置后网关在 /bark/* 反代它，
   * 省掉单独建站与申请证书。留空则不启用。
   */
  barkUpstream: string | null
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
    adminToken: loadOrCreateAdminToken(dataDir),
    webRoot: process.env.GW_WEB_ROOT ?? './web',
    barkUpstream: process.env.GW_BARK_UPSTREAM ?? null,
    baseUrl: process.env.GW_BASE_URL ?? null,
    trustedProxy: process.env.GW_TRUSTED_PROXY ?? null,
  }
}

/**
 * 管理 token。留空则生成一个写入 /data，并在日志里打印一次——
 * 这是唯一一次输出，之后任何日志都不会再包含它。
 */
function loadOrCreateAdminToken(dataDir: string): string {
  const fromEnv = process.env.GW_ADMIN_TOKEN
  if (fromEnv) return fromEnv

  const path = join(dataDir, 'admin.token')
  if (existsSync(path)) return readFileSync(path, 'utf8').trim()

  const b = crypto.getRandomValues(new Uint8Array(24))
  let bin = ''
  for (const x of b) bin += String.fromCharCode(x)
  const token = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  writeFileSync(path, token, { mode: 0o600 })
  chmodSync(path, 0o600)
  log.warn('已生成管理 token，仅此一次显示', { path, token })
  return token
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
