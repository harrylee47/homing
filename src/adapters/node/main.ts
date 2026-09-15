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
import { createWsServer, isAllowedAgentOrigin } from './wsserver.js'

const cfg = loadConfig()
const store = new SqliteStore(cfg.dbPath)
await store.migrate()

const cipher = await createCipher(cfg.dek)
const hub = new MemoryHub()
const wss = createWsServer({ store, cipher, hub, heartbeatSec: DEFAULT_AGENT_CONFIG.heartbeat_sec })

const server = createServer((req, res) => {
  // 移除指纹特征：Node 默认会带 Date 头，能少一个是一个（计划 §6.3）
  res.sendDate = false

  if (req.url === '/api/health') {
    const body = JSON.stringify({
      ok: true,
      online_devices: hub.onlineDevices().length,
      uptime_sec: Math.round(process.uptime()),
    })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(body)
    return
  }
  // 未认证请求一律 404，不返回 401——不确认服务存在（计划 §6.3）
  res.writeHead(404).end()
})

server.on('upgrade', (req, socket, head) => {
  if (req.url !== '/ws') {
    socket.destroy()
    return
  }
  if (!isAllowedAgentOrigin(req)) {
    log.warn('拒绝带 Origin 的 WS 连接', { origin: req.headers.origin, ip: req.socket.remoteAddress })
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
    socket.destroy()
    return
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
})

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
