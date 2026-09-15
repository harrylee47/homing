/**
 * Node 入口。
 */
import { setDefaultResultOrder } from 'node:dns'
import { createServer } from 'node:http'
import { createCipher } from '../../core/crypto.js'
import { log } from '../../core/logging.js'
import { DEFAULT_AGENT_CONFIG } from '../../core/protocol.js'
import { loadConfig } from './config.js'
import { MemoryHub } from './hub.js'
import { SqliteStore } from './store.js'
import { dispatch } from '../../core/notifier.js'
import { tick as keepAliveTick } from '../../core/keepalive.js'
import { checkDevices } from '../../core/monitor.js'
import { makeFrame, newCmdId } from '../../core/frames.js'
import type { DownstreamFrame } from '../../core/protocol.js'
import { PROVIDERS } from '../../core/notifier.js'
import { TelegramConfig } from '../../core/providers/telegram.js'
import { barkAccess, getOrCreateBotToken, handleApi, isInitialized } from './api.js'
import { TelegramBot } from './bot.js'
import { isBarkAllowed, isBarkPath, proxyBark } from './barkproxy.js'
import { serveStatic } from './static.js'
import { createWsServer, isAllowedAgentOrigin } from './wsserver.js'

/**
 * 强制优先使用 IPv4。
 *
 * Docker 默认网络没有 IPv6 出口，而 api.telegram.org 之类的域名同时返回
 * A 与 AAAA 记录。Node 18+ 默认 verbatim（按 DNS 返回顺序尝试），
 * 挑中 IPv6 就会立即失败——表现为时快时慢的 "fetch failed"，
 * 推送偶尔重试才成功、读取更新大概率失败。
 *
 * 这是部署形态决定的，属于适配层的事，不放进 core。
 */
setDefaultResultOrder('ipv4first')

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
  barkUpstream: cfg.barkUpstream,
  trustedProxy: cfg.trustedProxy,
  barkPublicUrl: cfg.baseUrl ? `${cfg.baseUrl.replace(/\/$/, '')}/bark` : null,
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
    void (async () => {
      if (!(await isInitialized(store))) { res.writeHead(403).end(); return }
      const access = await barkAccess(store)
      if (!isBarkAllowed(access, req.url ?? '')) {
        // 被拒时返回 404 而非 403：不确认这里存在一个 Bark 服务
        log.debug('Bark 请求被拒', { access, path: (req.url ?? '').split('?')[0], ip: req.socket.remoteAddress })
        res.writeHead(404).end()
        return
      }
      proxyBark(cfg.barkUpstream!, req, res)
    })()
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

/**
 * Bot 监管：按启用的 Telegram 渠道拉起 Bot，渠道变动后自动跟随。
 *
 * 定期重扫而不是事件驱动：进程内只保留「当前跑着哪些 Bot」这一点状态，
 * 且它完全由存储里的渠道表决定，重启即可重建（硬约束④）。
 */
const bots = new Map<string, TelegramBot>()
let syncing = false

async function syncBots(): Promise<void> {
  // 两次同步重叠会导致同一渠道被拉起两个 Bot，它们用同一个 token 长轮询，
  // 互相撞出 409 —— 表现得就像「别的程序占用了 token」，极难排查。
  if (syncing) return
  syncing = true
  try {
    await syncBotsInner()
  } finally {
    syncing = false
  }
}

async function syncBotsInner(): Promise<void> {
  if (!(await isInitialized(store))) return

  const wanted = new Map<string, { token: string; chat: string }>()
  for (const c of await store.listChannels()) {
    if (!c.enabled || c.type !== 'telegram') continue
    try {
      const cfg = TelegramConfig.parse(JSON.parse(await cipher.decrypt(c.config_enc)))
      wanted.set(c.id, { token: cfg.bot_token, chat: cfg.chat_id })
    } catch (e) {
      log.error('Bot 渠道配置不可用，已跳过', { channel_id: c.id, error: String(e) })
    }
  }

  for (const [id, bot] of bots) {
    if (!wanted.has(id)) { bot.stop(); bots.delete(id); log.info('Bot 已停止', { channel_id: id }) }
  }

  const serviceToken = await getOrCreateBotToken(store)
  for (const [id, w] of wanted) {
    if (bots.has(id)) continue
    const bot = new TelegramBot(
      { store, apiBase: `http://127.0.0.1:${cfg.port}`, serviceToken },
      w.token, new Set([w.chat]), id,
    )
    bot.start()
    bots.set(id, bot)
  }
}

// 启动后先同步一次，之后每分钟跟随渠道变动
setTimeout(() => void syncBots(), 2000)
const botTimer = setInterval(() => void syncBots(), 60_000)

/** 已解密的启用渠道。监控与保号告警共用。 */
async function liveChannels() {
  const out = []
  for (const c of await store.listChannels()) {
    if (!c.enabled) continue
    const provider = PROVIDERS[c.type]
    if (!provider) continue
    try {
      const parsed = provider.configSchema.safeParse(JSON.parse(await cipher.decrypt(c.config_enc)))
      if (parsed.success) out.push({ id: c.id, type: c.type, name: c.name, config: parsed.data, enabled: true })
    } catch { /* 单个渠道不可用不应影响其余 */ }
  }
  return out
}

/**
 * 掉线检测。每分钟一次即可：判定阈值是 5 分钟，再密集只是徒增开销。
 * 告警由服务端直接发出，不经过手机——用掉线的设备通知自己掉线没有意义。
 */
const monitorTimer = setInterval(() => {
  void checkDevices({
    store,
    channels: liveChannels,
    online: () => hub.onlineDevices(),
    baseUrl: cfg.baseUrl,
  }).catch((e: unknown) => log.error('掉线检测异常', { error: String(e) }))
}, 60_000)

/** 保号任务。每小时检查一次「本月是否已执行」，服务端短暂停机不会漏月。 */
const keepAliveTimer = setInterval(() => {
  void keepAliveTick({
    store,
    onlineDevice: () => hub.onlineDevices()[0] ?? null,
    send: async (deviceId, to, text) => {
      const id = `cmd_${crypto.randomUUID()}`
      const t = Date.now()
      await store.createOutbound({
        id, device_id: deviceId, to_number: to,
        content_enc: await cipher.encrypt(text), sim_slot: null,
        status: 'pending', error: null, created_at: t, updated_at: t,
      })
      const frame = makeFrame('cmd', {
        cmd_id: id, action: 'send_sms', args: { to, text, sim_slot: null },
      }, t) as DownstreamFrame
      if (hub.send(deviceId, frame)) return true
      await store.advanceOutbound(id, 'failed', '设备离线', Date.now())
      return false
    },
    alert: async (title, body) => {
      const channels = await liveChannels()
      if (channels.length === 0) return
      const { dispatch } = await import('../../core/notifier.js')
      await dispatch(channels, {
        title, body, priority: 'high', code: null, eventId: '',
        occurredAt: Date.now(), consoleUrl: cfg.baseUrl,
      })
    },
  }).catch((e: unknown) => log.error('保号任务异常', { error: String(e) }))
}, 3600_000)

/** 回复映射保留 7 天：超过这个窗口的推送，用户基本不会再去引用回复。 */
const MESSAGE_REF_TTL_MS = 7 * 24 * 3600 * 1000
const cleanupTimer = setInterval(() => {
  void store.cleanupMessageRefs(Date.now() - MESSAGE_REF_TTL_MS)
  void store.cleanupSessions(Date.now())
}, 3600_000)

const shutdown = async (sig: string) => {
  log.info('收到信号，正在退出', { sig })
  clearInterval(botTimer)
  clearInterval(cleanupTimer)
  clearInterval(monitorTimer)
  clearInterval(keepAliveTimer)
  for (const b of bots.values()) b.stop()
  server.close()
  wss.close()
  await store.close()
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
