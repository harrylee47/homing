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
  const path = join(dataDir, 'dek.key')
  const fromEnv = process.env.GW_DEK
  if (fromEnv) {
    const k = fromHex(fromEnv)
    if (k.length !== 32) throw new Error('GW_DEK 必须是 64 位 hex（32 字节）')
    /*
     * **两把不一样就拒绝启动。**
     *
     * 长期以来 docker-compose.yml 根本没把 GW_DEK 传进容器，于是真正在用的是
     * 这里自动生成的 data/dek.key，而文档一直教人在 .env 里生成一把、单独抄进
     * 密码管理器。补上传参之后就出现了一个新的坏路径：老部署里两把不一样，
     * 而环境变量优先——容器照常启动、零报错，**全部历史消息当场解不开**，
     * 界面上表现为消息列表里一片空白或乱码。
     * 这种错必须在启动时就拦住：起不来有人看，解不开没人看得出来。
     */
    if (existsSync(path)) {
      const onDisk = readFileSync(path, 'utf8').trim().toLowerCase()
      if (onDisk && onDisk !== fromEnv.trim().toLowerCase()) {
        throw new Error(
          `GW_DEK 与 ${path} 里的密钥不一致。这台机器的历史数据是用文件里那把加密的，`
          + '用环境变量这把启动会让全部历史解不开。要么把 .env 里的 GW_DEK 换成文件里那把，'
          + '要么确认这是一台全新机器后删掉那个文件。',
        )
      }
    }
    return k
  }

  if (existsSync(path)) return fromHex(readFileSync(path, 'utf8'))

  const dek = generateDek()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, toHex(dek), { mode: 0o600 })
  chmodSync(path, 0o600)
  log.warn('已生成新的数据加密密钥（DEK）', { path, hint: '请单独备份，不要与 data 目录放在一起' })
  return dek
}
