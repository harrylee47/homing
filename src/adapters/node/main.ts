/**
 * Node 入口。
 */
import { createServer } from 'node:http'
import { createCipher } from '../../core/crypto.js'
import { log } from '../../core/logging.js'
import { DEFAULT_AGENT_CONFIG } from '../../core/protocol.js'
import { loadConfig } from './config.js'
import { MemoryHub } from './hub.js'
import { SqliteStore } from './store.js'
import { dispatch } from '../../core/notifier.js'
import { handleApi, isInitialized } from './api.js'
import { isBarkPath, proxyBark } from './barkproxy.js'
import { serveStatic } from './static.js'
import { createWsServer, isAllowedAgentOrigin } from './wsserver.js'

const cfg = loadConfig()
const store = new SqliteStore(cfg.dbPath)
await store.migrate()

const cipher = await createCipher(cfg.dek)
const hub = new MemoryHub()
const wss = createWsServer({
  store, cipher, hub,
  heartbeatSec: DEFAULT_AGENT_CONFIG.heartbeat_sec,
  baseUrl: cfg.baseUrl,
})

/**
 * 登录连续失败时告警。计划 §6.3 要求「失败立即告警到 Telegram」——
 * 这类事件只在被攻击时发生，而那正是最需要知道的时刻。
 */
async function alertLoginLockout(ip: string, attempts: number): Promise<void> {
  try {
    const channels = await store.listChannels()
    const targets = []
    for (const c of channels) {
      if (!c.enabled) continue
      targets.push({
        id: c.id, type: c.type, name: c.name,
        config: JSON.parse(await cipher.decrypt(c.config_enc)), enabled: true,
      })
    }
    if (targets.length === 0) return
    await dispatch(targets, {
      title: '⚠️ 控制台登录告警',
      body: `来自 ${ip} 的登录连续失败 ${attempts} 次，该地址已被锁定。若非本人操作，请立即更换口令。`,
      priority: 'high', code: null, eventId: '', occurredAt: Date.now(),
    })
  } catch (e) {
    log.error('登录告警发送失败', { error: String(e) })
  }
}

const apiDeps = {
  store, cipher, hub, adminToken: cfg.adminToken,
  onLoginLockout: (ip: string, n: number) => void alertLoginLockout(ip, n),
}

const server = createServer((req, res) => {
  // 移除指纹特征：Node 默认会带 Date 头，能少一个是一个（计划 §6.3）
  res.sendDate = false

  if (req.url === '/api/health') {
    // 健康检查是「所有路由一律 403」的唯一例外：Docker HEALTHCHECK 与外部监控
    // 需要它在初始化完成前也可用，否则容器会因健康检查失败无限重启。
    // 代价用「未初始化时不返回任何运行数据」抵消。
    void isInitialized(store).then((ready) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(ready
        ? { ok: true, online_devices: hub.onlineDevices().length, uptime_sec: Math.round(process.uptime()) }
        : { ok: true, initialized: false }))
    })
    return
  }
  // Bark 反代：不走网关鉴权（Bark App 不会带我们的 token），
  // 但同样受初始化门禁约束——未配置完成前整台服务都不对外服务。
  if (cfg.barkUpstream && isBarkPath(req.url)) {
    void isInitialized(store).then((ready) => {
      if (!ready) { res.writeHead(403).end(); return }
      proxyBark(cfg.barkUpstream!, req, res)
    })
    return
  }

  void handleApi(req, res, apiDeps).then((handled) => {
    if (handled || res.headersSent) return
    // 非 API 路径交给控制台；深链路由由前端处理（计划 §11.2）
    if (!serveStatic(cfg.webRoot, req, res)) res.writeHead(404).end()
  })
})

server.on('upgrade', (req, socket, head) => {
  if (req.url !== '/ws') {
    socket.destroy()
    return
  }
  // 未完成初始化时 WS 同样拒绝——「所有路由」包括这一条（计划 §12.1①）
  void isInitialized(store).then((ready) => {
    if (!ready) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
      socket.destroy()
      return
    }
    handleUpgrade(req, socket, head)
  })
})

function handleUpgrade(req: Parameters<typeof wss.handleUpgrade>[0], socket: Parameters<typeof wss.handleUpgrade>[1], head: Buffer): void {
  if (!isAllowedAgentOrigin(req)) {
    log.warn('拒绝带 Origin 的 WS 连接', { origin: req.headers.origin, ip: req.socket.remoteAddress })
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
    socket.destroy()
    return
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
}

server.listen(cfg.port, cfg.host, () => {
  log.info('网关已启动', { host: cfg.host, port: cfg.port, db: cfg.dbPath })
})

const shutdown = async (sig: string) => {
  log.info('收到信号，正在退出', { sig })
  server.close()
  wss.close()
  await store.close()
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
