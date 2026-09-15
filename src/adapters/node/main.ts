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
import { runTask as runOneTask, tick as tasksTick, type ParsedTask } from '../../core/tasks.js'
import { checkDevices } from '../../core/monitor.js'
import { makeFrame, newCmdId } from '../../core/frames.js'
import { LocationResult, type DownstreamFrame } from '../../core/protocol.js'
import { PROVIDERS } from '../../core/notifier.js'
import { TelegramConfig } from '../../core/providers/telegram.js'
import { barkAccess, getOrCreateBotToken, handleApi, isInitialized, timezone } from './api.js'
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
  onQueryResult,
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

/**
 * 等待中的查询指令。
 *
 * 进程内状态，但完全是瞬时的：超时 30 秒，丢失的后果只是这次请求超时，
 * 用户重试即可，不涉及任何数据。
 */
const pendingQueries = new Map<string, (r: { ok: boolean; detail: Record<string, unknown> | null; error: string | null }) => void>()

function onQueryResult(cmdId: string, ok: boolean, detail: Record<string, unknown> | null, error: string | null): void {
  const resolve = pendingQueries.get(cmdId)
  if (!resolve) return
  pendingQueries.delete(cmdId)
  resolve({ ok, detail, error })
}

/** 向设备请求一次定位，等待回执或超时。 */
async function locateDevice(deviceId: string): Promise<{ ok: boolean; location?: unknown; error?: string }> {
  const cmdId = `cmd_${crypto.randomUUID()}`
  const frame = makeFrame('cmd', { cmd_id: cmdId, action: 'get_location', args: {} }) as DownstreamFrame
  if (!hub.send(deviceId, frame)) return { ok: false, error: '设备离线' }

  const result = await new Promise<{ ok: boolean; detail: Record<string, unknown> | null; error: string | null }>((resolve) => {
    pendingQueries.set(cmdId, resolve)
    // GPS 冷启动可能要十几秒，Agent 侧自己也有 20 秒上限，这里留足余量
    setTimeout(() => {
      if (pendingQueries.delete(cmdId)) resolve({ ok: false, detail: null, error: '设备未在 40 秒内返回位置' })
    }, 40_000)
  })

  if (!result.ok) return { ok: false, error: result.error ?? '定位失败' }

  const parsed = LocationResult.safeParse(result.detail)
  if (!parsed.success) return { ok: false, error: '设备返回的位置格式不正确' }

  // 位置与短信正文同等敏感，加密落库
  await store.setDeviceLocation(deviceId, await cipher.encrypt(JSON.stringify(parsed.data)), Date.now())
  return { ok: true, location: parsed.data }
}

const apiDeps = {
  store, cipher, hub, adminToken: cfg.adminToken,
  barkUpstream: cfg.barkUpstream,
  trustedProxy: cfg.trustedProxy,
  // apiDeps 在 taskDeps 之前定义，用函数包一层避免 TDZ
  runTask: (task: ParsedTask) => runTaskNow(task),
  locateDevice,
  barkPublicUrl: cfg.baseUrl ? `${cfg.baseUrl.replace(/\/$/, '')}/bark` : null,
  onLoginLockout: (ip: string, n: number) => void alertLoginLockout(ip, n),
  onUnknownIpLogin: (ip: string) => void (async () => {
    const channels = await liveChannels()
    if (channels.length === 0) return
    const { dispatch } = await import('../../core/notifier.js')
    await dispatch(channels, {
      title: '🔑 控制台异地登录',
      body: `有人从 ${ip} 登录了控制台，这个网段此前没见过。若非本人操作，请立即修改口令并全端下线。`,
      priority: 'high', code: null, eventId: '', occurredAt: Date.now(), consoleUrl: cfg.baseUrl,
    }).catch(() => { /* 告警失败不应影响登录本身 */ })
  })(),
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

/** 设备名缓存，仅用于告警文案；取不到就退回 id，不值得为它阻塞。 */
const deviceNameCache = new Map<string, string>()
const refreshDeviceNames = async () => {
  for (const d of await store.listDevices()) deviceNameCache.set(d.id, d.name)
}
void refreshDeviceNames()

/**
 * 计划任务的依赖。抽出来是因为控制台的「立即测试」要复用同一条路径——
 * 测试走的和定时执行不是两套代码，否则测得通不代表定时能通。
 */
const taskDeps = async () => ({
  store,
  timezone: await timezone(store),
  onlineDevices: () => hub.onlineDevices(),
  deviceName: (id: string) => deviceNameCache.get(id) ?? id,
  send: async (deviceId: string, to: string, text: string) => {
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
  alert: async (title: string, body: string) => {
    const channels = await liveChannels()
    if (channels.length === 0) return
    const { dispatch } = await import('../../core/notifier.js')
    await dispatch(channels, {
      title, body, priority: 'high' as const, code: null, eventId: '',
      occurredAt: Date.now(), consoleUrl: cfg.baseUrl,
    })
  },
})

const runTaskNow = async (task: ParsedTask) => {
  await refreshDeviceNames()
  return runOneTask(await taskDeps(), task, true)
}

/**
 * 每分钟检查一次。不能用小时粒度：「每天 09:00」这类排期需要分钟精度，
 * 小时粒度会把它变成「每天 09:00 到 10:00 之间的某个时刻」。
 */
const taskTimer = setInterval(() => {
  void refreshDeviceNames()
    .then(async () => tasksTick(await taskDeps(), (enc) => cipher.decrypt(enc)))
    .catch((e: unknown) => log.error('计划任务异常', { error: String(e) }))
}, 60_000)

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
  clearInterval(taskTimer)
  for (const b of bots.values()) b.stop()
  server.close()
  wss.close()
  await store.close()
  process.exit(0)
}
/**
 * 兜底：未捕获的 Promise rejection 默认会终止 Node 进程。
 *
 * 这台服务在收验证码，因为一次数据库抖动或第三方接口异常就整个挂掉，
 * 代价远大于让它带病运行——记下来、发告警，但继续跑。
 */
process.on('unhandledRejection', (reason) => {
  log.error('未捕获的 Promise rejection（进程继续运行）', { error: String(reason) })
})
process.on('uncaughtException', (err) => {
  log.error('未捕获的异常（进程继续运行）', { error: String(err), stack: err.stack?.slice(0, 500) })
})

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
