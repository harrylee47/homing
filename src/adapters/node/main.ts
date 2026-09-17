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
import { AppListResult, FingerprintList, ImportResult, LocationResult, type DownstreamFrame } from '../../core/protocol.js'
import { PROVIDERS } from '../../core/notifier.js'
import { TelegramConfig } from '../../core/providers/telegram.js'
import { barkAccess, botTokenFor, handleApi, isInitialized, loadNotifyCapture, loadSmsCommand, PRIVACY_VERSION, timezone } from './api.js'
import { TelegramBot } from './bot.js'
import { isBarkAllowed, isBarkPath, proxyBark } from './barkproxy.js'
import { serveStatic } from './static.js'
import { createWsServer, isAllowedAgentOrigin } from './wsserver.js'
import { migratedTemplate, missingDirection, missingSeedRules, SEED_RULES_VERSION } from '../../core/seeds.js'
import { userActive } from '../../core/users.js'

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
await migrateSingleUser()
await backfillSeedRules()

/**
 * 从单用户升级到多用户。
 *
 * 老库里口令与 TOTP 存在 settings 表、数据没有归属列。这里把它们搬进 users 表，
 * 再把所有无主数据认领给这个人——不认领的话，他升级后打开控制台会看到
 * 空空如也：设备、规则、几千条历史消息都还在库里，只是谁都查不到。
 *
 * 只在「一个用户都没有」时执行一次。
 */
async function migrateSingleUser(): Promise<void> {
  if ((await store.listUsers()).length > 0) return

  const pw = await store.getSetting('admin_password_hash')
  const totp = await store.getSetting('totp_secret')
  // 还没走过向导：让向导去建第一个用户，这里没事可做
  if (!pw || !totp) return

  const { generateSessionToken } = await import('../../core/auth.js')
  const id = 'usr_first'
  await store.upsertUser({
    id, name: 'admin', password_hash: pw, totp_secret: totp,
    role: 'admin', bot_token: generateSessionToken(),
    // 老用户不设期限、视同已同意：这台机器本来就是他自己的
    disabled: false, expires_at: null,
    agreed_version: PRIVACY_VERSION, agreed_at: Date.now(), created_at: Date.now(),
  })
  const claimed = await store.claimOrphans(id)
  log.info('已升级为多用户：原有数据归入 admin', { claimed })
  await store.audit({
    user_id: id, actor: 'system', action: 'user.migrate_single',
    detail: Object.entries(claimed).map(([k, v]) => `${k} ${v}`).join('、'),
    ip: null, created_at: Date.now(),
  })
}

/**
 * 老部署补齐新增的预置规则。
 *
 * 不补的话，「已发送短信只归档不推送」这类新语义只对新装的人生效——
 * 老用户升级后会突然收到自己发出去的短信的推送。
 *
 * 只补不改，且只做一次：版本号记在 settings 里，用户之后删掉哪条就是哪条，
 * 下次启动不会再长回来。
 */
// 函数声明而不是 const：backfillSeedRules 在声明之前就被调用，
// const 会落进 TDZ，启动直接崩
function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`
}

async function backfillSeedRules(): Promise<void> {
  const cur = Number(await store.getSetting('seed_rules_version') ?? 0)
  if (cur >= SEED_RULES_VERSION) return
  // 规则是按人存的，每个人各补各的
  for (const u of await store.listUsers()) await backfillSeedRulesFor(u.id)
  await store.setSetting('seed_rules_version', String(SEED_RULES_VERSION))
}

async function backfillSeedRulesFor(userId: string): Promise<void> {
  const existing = await store.listRules(userId)
  // 一条规则都没有说明还没走过向导，交给向导去种，这里只记版本
  if (existing.length > 0) {
    // 新规则跟着现有规则的渠道走：用户已经选好推给谁了，不该再问一遍
    const channels = [...new Set(existing.flatMap((r) => {
      try { return (JSON.parse(r.action_json) as { channels?: string[] }).channels ?? [] }
      catch { return [] }
    }))]
    const t = Date.now()
    const missing = missingSeedRules(existing.map((r) => r.name), channels, () => newId('rule'))
    for (const r of missing) {
      await store.upsertRule({
        id: r.id, user_id: userId, name: r.name, priority: r.priority, enabled: true,
        match_json: JSON.stringify(r.match), action_json: JSON.stringify(r.action), created_at: t,
      })
    }
    // 补齐后加字段的默认值（见 missingDirection 的注释）
    const fixed: string[] = []
    for (const row of existing) {
      let match: Record<string, unknown>
      try { match = JSON.parse(row.match_json) as Record<string, unknown> } catch { continue }
      const dir = missingDirection(row.name, match)
      if (!dir) continue
      await store.upsertRule({
        id: row.id, user_id: userId, name: row.name, priority: row.priority, enabled: row.enabled,
        match_json: JSON.stringify({ ...match, direction: dir }),
        action_json: row.action_json, created_at: row.created_at,
      })
      fixed.push(row.name)
    }

    // 老默认模板把发件人拼进了正文，而渠道本身就在显示发件人——
    // 同一个号码在一条通知里出现两三次。只改一模一样的，用户写过的不动
    const retemplated: string[] = []
    for (const row of existing) {
      let action: Record<string, unknown>
      try { action = JSON.parse(row.action_json) as Record<string, unknown> } catch { continue }
      if (typeof action.template !== 'string') continue
      const next = migratedTemplate(action.template)
      if (next === null) continue
      await store.upsertRule({
        id: row.id, user_id: userId, name: row.name, priority: row.priority, enabled: row.enabled,
        match_json: row.match_json,
        action_json: JSON.stringify({ ...action, template: next }),
        created_at: row.created_at,
      })
      retemplated.push(row.name)
    }
    if (retemplated.length > 0) {
      log.info('已把仍是老默认值的通知模板换成只含正文', { names: retemplated })
      await store.audit({
        actor: 'system', action: 'rules.template_migrate',
        detail: retemplated.join('、'), ip: null, created_at: t,
      })
    }
    if (fixed.length > 0) {
      log.info('已为预置规则补上方向限制', { names: fixed })
      await store.audit({
        actor: 'system', action: 'rules.direction_backfill',
        detail: fixed.join('、'), ip: null, created_at: t,
      })
    }

    if (missing.length > 0) {
      log.info('已补齐新增的预置规则', { names: missing.map((r) => r.name) })
      await store.audit({
        actor: 'system', action: 'rules.seed_backfill',
        detail: missing.map((r) => r.name).join('、'), ip: null, created_at: t,
      })
    }
  }
}

const cipher = await createCipher(cfg.dek)
const hub = new MemoryHub()
const wss = createWsServer({
  store, cipher, hub,
  heartbeatSec: DEFAULT_AGENT_CONFIG.heartbeat_sec,
  baseUrl: cfg.baseUrl,
  onQueryResult,
  // 每次握手都按当前设置生成配置，Agent 不持久化业务配置（计划 §2.3）
  // 配置按设备主人取：短信指令的口令是他自己的，通知捕获范围也是他自己设的
  agentConfig: async (userId: string) => {
    const [n, c] = await Promise.all([loadNotifyCapture(store, userId), loadSmsCommand(store, userId)])
    return {
      ...DEFAULT_AGENT_CONFIG,
      sms_command: c,
      capture_notification: n.enabled,
      notification_scope: n.scope,
      notification_packages: n.packages,
      // 短信指令的执行回执也走 notification 这条通道上报，所以它开着的时候
      // 同样要放行——否则 Agent 会在 drain 里按 enabled_kinds 把回执丢掉，
      // 表现为「指令执行了、短信也回了，但控制台上什么都没有」
      enabled_kinds: n.enabled || c.enabled
        ? ['sms', 'call', 'notification'] as const
        : ['sms', 'call'] as const,
    }
  },
})

/**
 * 登录连续失败时告警。计划 §6.3 要求「失败立即告警到 Telegram」——
 * 这类事件只在被攻击时发生，而那正是最需要知道的时刻。
 */
async function alertLoginLockout(ip: string, attempts: number): Promise<void> {
  try {
    const targets = await adminChannels()
    if (targets.length === 0) return
    await dispatch(targets, {
      title: '⚠️ 控制台登录告警',
      body: `来自 ${ip} 的登录连续失败 ${attempts} 次，该地址已被锁定。若非本人操作，请立即更换口令。`,
      alert: true, priority: 'high', code: null, eventId: '', occurredAt: Date.now(),
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

/** 通用的查询类指令：下发后等回执或超时。 */
async function queryDevice(
  deviceId: string,
  action: 'get_location' | 'list_apps' | 'import_history' | 'list_fingerprints',
  timeoutMs: number,
  args: Record<string, unknown> = {},
): Promise<{ ok: boolean; detail: Record<string, unknown> | null; error: string | null }> {
  const cmdId = `cmd_${crypto.randomUUID()}`
  const frame = makeFrame('cmd', { cmd_id: cmdId, action, args }) as DownstreamFrame
  if (!hub.send(deviceId, frame)) return { ok: false, detail: null, error: '设备离线' }

  return new Promise((resolve) => {
    pendingQueries.set(cmdId, resolve)
    setTimeout(() => {
      if (pendingQueries.delete(cmdId)) {
        resolve({ ok: false, detail: null, error: `设备未在 ${Math.round(timeoutMs / 1000)} 秒内响应` })
      }
    }, timeoutMs)
  })
}

/** 向设备请求一次定位，等待回执或超时。 */
async function locateDevice(deviceId: string): Promise<{ ok: boolean; location?: unknown; error?: string }> {
  // GPS 冷启动可能要十几秒，Agent 侧自己有 25 秒上限，这里留足余量
  const result = await queryDevice(deviceId, 'get_location', 40_000)
  if (!result.ok) return { ok: false, error: result.error ?? '定位失败' }

  const parsed = LocationResult.safeParse(result.detail)
  if (!parsed.success) return { ok: false, error: '设备返回的位置格式不正确' }

  // 位置与短信正文同等敏感，加密落库
  await store.setDeviceLocation(deviceId, await cipher.encrypt(JSON.stringify(parsed.data)), Date.now())
  return { ok: true, location: parsed.data }
}

/** 让设备列出已安装应用。 */
async function listApps(deviceId: string): Promise<{ ok: boolean; apps?: unknown; error?: string }> {
  const result = await queryDevice(deviceId, 'list_apps', 25_000)
  if (!result.ok) return { ok: false, error: result.error ?? '查询失败' }
  const parsed = AppListResult.safeParse(result.detail)
  if (!parsed.success) return { ok: false, error: '设备返回的应用列表格式不正确' }
  return { ok: true, apps: parsed.data.apps }
}

/**
 * 让设备把本机已有的历史短信与通话导进来。
 *
 * 超时给得很宽：几千条记录要逐行读游标再入队，慢是正常的。
 * 真正的导入是异步的——Agent 先落本地队列，再按既有的补传节奏发上来，
 * 所以这里的返回值只是「读了多少条」，不代表已经全部入库。
 */
async function importHistory(
  deviceId: string, since: number | null, limit: number,
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  const args: Record<string, unknown> = { limit }
  if (since !== null) args.since = since
  const r = await queryDevice(deviceId, 'import_history', 120_000, args)
  if (!r.ok) return { ok: false, error: r.error ?? '导入失败' }
  const parsed = ImportResult.safeParse(r.detail)
  if (!parsed.success) return { ok: false, error: '设备返回的导入结果格式不正确' }
  return { ok: true, result: parsed.data }
}

/** 取手机当前还有哪些记录的指纹，用于镜像同步。 */
async function listFingerprints(
  deviceId: string, since: number | null, limit: number,
): Promise<{ ok: boolean; items?: { fp: string; at: number }[]; truncated?: boolean; error?: string }> {
  const args: Record<string, unknown> = { limit }
  if (since !== null) args.since = since
  const r = await queryDevice(deviceId, 'list_fingerprints', 120_000, args)
  if (!r.ok) return { ok: false, error: r.error ?? '读取失败' }
  const parsed = FingerprintList.safeParse(r.detail)
  if (!parsed.success) return { ok: false, error: '设备返回的指纹格式不正确' }
  return { ok: true, items: parsed.data.items, truncated: parsed.data.truncated }
}

/**
 * 断开全部设备，迫使它们重连并拉取新配置。
 *
 * 配置只在握手时下发，改完不重连就要等到下次断线才生效——
 * 用户改了设置却看不到效果，会以为坏了。断开后 Agent 1 秒内就会重连。
 */
function reconnectDevices(): void {
  for (const id of hub.onlineDevices()) {
    hub.get(id)?.close(1000, 'config changed')
  }
  log.info('已断开全部设备以应用新配置')
}

const apiDeps = {
  store, cipher, hub, adminToken: cfg.adminToken,
  barkUpstream: cfg.barkUpstream,
  trustedProxy: cfg.trustedProxy,
  // apiDeps 在 taskDeps 之前定义，用函数包一层避免 TDZ
  runTask: (task: ParsedTask) => runTaskNow(task),
  locateDevice,
  listApps,
  importHistory,
  listFingerprints,
  reconnectDevices,
  barkPublicUrl: cfg.baseUrl ? `${cfg.baseUrl.replace(/\/$/, '')}/bark` : null,
  baseUrl: cfg.baseUrl,
  onLoginLockout: (ip: string, n: number) => void alertLoginLockout(ip, n),
  /** 口令被自助找回：通知本人自己的渠道。没有第二因素时这是唯一的事后检测手段 */
  onPasswordRecovered: (userId: string, ip: string) => void (async () => {
    const channels = await liveChannels(userId)
    if (channels.length === 0) return
    const { dispatch } = await import('../../core/notifier.js')
    await dispatch(channels, {
      title: '🔑 你的口令刚刚被重置',
      body: `有人用你的两步验证码从 ${ip} 重置了这个账号的口令，所有已登录的会话都已下线。`
        + `如果不是你本人操作，说明你的认证器已经泄露——请立刻用新口令登录、重新绑定两步验证。`,
      alert: true, priority: 'high', code: null, eventId: '', occurredAt: Date.now(), consoleUrl: cfg.baseUrl,
    }).catch(() => { /* 告警失败不影响找回本身 */ })
  })(),

  onUnknownIpLogin: (ip: string) => void (async () => {
    const channels = await adminChannels()
    if (channels.length === 0) return
    const { dispatch } = await import('../../core/notifier.js')
    await dispatch(channels, {
      title: '🔑 控制台异地登录',
      body: `有人从 ${ip} 登录了控制台，这个网段此前没见过。若非本人操作，请立即修改口令并全端下线。`,
      alert: true, priority: 'high', code: null, eventId: '', occurredAt: Date.now(), consoleUrl: cfg.baseUrl,
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

  // 跨用户：每个人可以有自己的 Bot，各自只能取到自己的数据（见下面的 service token）
  const wanted = new Map<string, { token: string; chat: string; owner: string }>()
  const active = new Map<string, boolean>()
  for (const c of await store.listAllChannels()) {
    if (!c.enabled || c.type !== 'telegram') continue
    // 停用/到期用户的 Bot 不再轮询：否则账号到期了他还能在 Telegram 里查自己的短信
    if (!active.has(c.user_id)) active.set(c.user_id, userActive(await store.getUser(c.user_id), Date.now()))
    if (!active.get(c.user_id)) continue
    try {
      const cfg = TelegramConfig.parse(JSON.parse(await cipher.decrypt(c.config_enc)))
      wanted.set(c.id, { token: cfg.bot_token, chat: cfg.chat_id, owner: c.user_id })
    } catch (e) {
      log.error('Bot 渠道配置不可用，已跳过', { channel_id: c.id, error: String(e) })
    }
  }

  for (const [id, bot] of bots) {
    if (!wanted.has(id)) { bot.stop(); bots.delete(id); log.info('Bot 已停止', { channel_id: id }) }
  }

  for (const [id, w] of wanted) {
    if (bots.has(id)) continue
    // 每个 Bot 用自己主人的 token：它只能取到那个人的数据
    const serviceToken = await botTokenFor(store, w.owner)
    if (!serviceToken) { log.warn('Bot 渠道找不到归属用户，已跳过', { channel_id: id }); continue }
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

/**
 * 把已经连着的、但主人已停用或到期的设备踢下线。
 *
 * 握手时的判断挡不住它们：**握手一辈子只发生一次**。一台连着的手机
 * 可以连着几个月不重连，只在握手处判等于对在线设备完全不生效——
 * 而「到期停服」最需要生效的恰恰是那台还在线的手机。
 */
async function sweepInactiveDevices(): Promise<void> {
  const online = new Set(hub.onlineDevices())
  if (online.size === 0) return
  const active = new Map<string, boolean>()
  for (const d of await store.listAllDevices()) {
    if (!online.has(d.id)) continue
    if (!active.has(d.user_id)) active.set(d.user_id, userActive(await store.getUser(d.user_id), Date.now()))
    if (active.get(d.user_id)) continue
    log.warn('账号已停用或到期，断开设备连接', { device_id: d.id, user_id: d.user_id })
    hub.get(d.id)?.close(4001, 'AUTH_DEVICE_REVOKED')
  }
}
const sweepTimer = setInterval(() => void sweepInactiveDevices().catch(() => { /* 下一轮再来 */ }), 60_000)

/**
 * 机器主人的渠道：登录失败、异地登录这类**与账号无关**的告警发给他。
 *
 * 这类告警发生在还不知道是谁登录的时候，只能发给第一个管理员——
 * 他是这台机器的主人，被人敲门理应由他知道。
 */
async function adminChannels() {
  const admin = (await store.listUsers()).find((u) => u.role === 'admin' && !u.disabled)
  return admin ? liveChannels(admin.id) : []
}

/** 某个用户已解密的启用渠道。监控与保号告警共用。 */
async function liveChannels(userId: string) {
  const out = []
  for (const c of await store.listChannels(userId)) {
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
  for (const d of await store.listAllDevices()) deviceNameCache.set(d.id, d.name)
}
void refreshDeviceNames()

/**
 * 计划任务的依赖。抽出来是因为控制台的「立即测试」要复用同一条路径——
 * 测试走的和定时执行不是两套代码，否则测得通不代表定时能通。
 */
const taskDeps = async () => ({
  store,
  // 时区按用户存，调度器逐条任务现取（见 TaskDeps.timezoneFor）
  timezoneFor: (userId: string) => timezone(store, userId),
  onlineDevices: () => hub.onlineDevices(),
  deviceName: (id: string) => deviceNameCache.get(id) ?? id,
  send: async (userId: string, deviceId: string, to: string, text: string, simSlot: number | null = null) => {
    const id = `cmd_${crypto.randomUUID()}`
    const t = Date.now()
    await store.createOutbound({
      id, user_id: userId, device_id: deviceId, to_number: to,
      content_enc: await cipher.encrypt(text), sim_slot: simSlot,
      status: 'pending', error: null, created_at: t, updated_at: t,
    })
    const frame = makeFrame('cmd', {
      cmd_id: id, action: 'send_sms', args: { to, text, sim_slot: simSlot },
    }, t) as DownstreamFrame
    if (hub.send(deviceId, frame)) return true
    await store.advanceOutbound(id, 'failed', '设备离线', Date.now())
    return false
  },
  alert: async (userId: string, title: string, body: string) => {
    const channels = await liveChannels(userId)
    if (channels.length === 0) return
    const { dispatch } = await import('../../core/notifier.js')
    await dispatch(channels, {
      title, body, alert: true, priority: 'high' as const, code: null, eventId: '',
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
  clearInterval(sweepTimer)
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
