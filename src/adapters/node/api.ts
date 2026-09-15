/**
 * REST API。
 *
 * 不引入 Web 框架：路由规模很小，而每多一个依赖就多一份供应链风险，
 * 对一台存着全部银行验证码的服务来说不划算。
 *
 * 鉴权用 Authorization: Bearer，不用 Cookie —— 天然免疫 CSRF（计划 §11.6）。
 * M1 阶段是单一管理员 token；口令 + TOTP 登录在 M3 落地。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { timingSafeEqual } from '../../core/crypto.js'
import type { Cipher } from '../../core/crypto.js'
import { log } from '../../core/logging.js'
import { dispatch, PROVIDERS, type ChannelConfig } from '../../core/notifier.js'
import { createPairing, redeemPairing } from '../../core/pairing.js'
import { makeFrame, newCmdId } from '../../core/frames.js'
import type { DownstreamFrame } from '../../core/protocol.js'
import { RuleAction, RuleMatch } from '../../core/rules.js'
import type { Hub } from '../../core/hub.js'
import type { Store } from '../../core/store.js'

export interface ApiDeps {
  store: Store
  cipher: Cipher
  hub: Hub
  adminToken: string
}

type Handler = (ctx: Ctx) => Promise<void>
interface Ctx {
  req: IncomingMessage
  res: ServerResponse
  url: URL
  params: Record<string, string>
  body: unknown
  deps: ApiDeps
  ip: string
}

// ── 路由表 ──────────────────────────────────────────────────

interface Route { method: string; pattern: RegExp; keys: string[]; handler: Handler; auth: boolean }
const routes: Route[] = []

function route(method: string, path: string, handler: Handler, auth = true): void {
  const keys: string[] = []
  const pattern = new RegExp(
    '^' + path.replace(/:(\w+)/g, (_m, k: string) => { keys.push(k); return '([^/]+)' }) + '$',
  )
  routes.push({ method, pattern, keys, handler, auth })
}

// ── 工具 ────────────────────────────────────────────────────

const json = (res: ServerResponse, status: number, body: unknown): void => {
  const s = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(s)
}

const now = (): number => Date.now()
const newId = (prefix: string): string => `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`

/**
 * 配对接口是未认证可达的，必须限速——8 位配对码在无限尝试下是可枚举的。
 * 进程内计数即可：这是硬约束④允许之外的状态，但重启后重置的影响仅是
 * 放宽一次窗口，可以接受。
 */
const pairAttempts = new Map<string, { count: number; resetAt: number }>()
const PAIR_MAX = 10
const PAIR_WINDOW_MS = 15 * 60 * 1000

function rateLimited(ip: string): boolean {
  const rec = pairAttempts.get(ip)
  const t = now()
  if (!rec || t > rec.resetAt) {
    pairAttempts.set(ip, { count: 1, resetAt: t + PAIR_WINDOW_MS })
    return false
  }
  rec.count++
  return rec.count > PAIR_MAX
}

// ── 设备与配对 ──────────────────────────────────────────────

route('GET', '/api/devices', async ({ res, deps }) => {
  const devices = await deps.store.listDevices()
  const online = new Set(deps.hub.onlineDevices())
  json(res, 200, {
    devices: devices.map((d) => ({
      id: d.id, name: d.name,
      // 以实际连接状态为准：库里的 status 在服务端异常退出后可能是陈旧的
      status: d.status === 'revoked' ? 'revoked' : online.has(d.id) ? 'online' : 'offline',
      last_seen_at: d.last_seen_at, battery: d.battery, app_version: d.app_version,
      created_at: d.created_at,
    })),
  })
})

route('POST', '/api/devices/pairing-code', async ({ res, body, deps }) => {
  const name = (body as { name?: string })?.name?.trim()
  if (!name) return json(res, 400, { error: '缺少 name' })
  const r = await createPairing(deps.store, name)
  json(res, 200, { code: r.code, expires_at: r.expires_at, ttl_sec: Math.round((r.expires_at - now()) / 1000) })
})

route('DELETE', '/api/devices/:id/token', async ({ res, params, deps, ip }) => {
  const id = params.id!
  await deps.store.revokeDevice(id)
  deps.hub.get(id)?.close(4001, 'AUTH_DEVICE_REVOKED')
  await deps.store.audit({ actor: 'console', action: 'device.revoke', detail: id, ip, created_at: now() })
  json(res, 200, { ok: true })
})

/** Agent 调用，无需鉴权——配对码本身就是凭证。 */
route('POST', '/api/pair', async ({ res, body, deps, ip }) => {
  if (rateLimited(ip)) {
    log.warn('配对请求超出限速', { ip })
    return json(res, 429, { error: '尝试过于频繁' })
  }
  const code = (body as { code?: string })?.code
  if (!code) return json(res, 400, { error: '缺少 code' })

  const r = await redeemPairing(deps.store, code)
  // 不区分「不存在 / 已用 / 过期」，避免为枚举提供反馈
  if (!r) return json(res, 401, { error: '配对码无效' })
  json(res, 200, r)
}, false)

// ── 渠道 ────────────────────────────────────────────────────

route('GET', '/api/channels', async ({ res, deps }) => {
  const rows = await deps.store.listChannels()
  // 绝不返回配置明文：里面是 Bot token
  json(res, 200, {
    channels: rows.map((c) => ({ id: c.id, type: c.type, name: c.name, enabled: c.enabled, created_at: c.created_at })),
  })
})

route('POST', '/api/channels', async ({ res, body, deps }) => {
  const b = body as { type?: string; name?: string; config?: unknown; enabled?: boolean }
  const provider = b.type ? PROVIDERS[b.type] : undefined
  if (!provider) return json(res, 400, { error: `未知渠道类型 ${b.type}` })

  const parsed = provider.configSchema.safeParse(b.config)
  if (!parsed.success) {
    return json(res, 400, { error: '配置校验失败', detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) })
  }

  const id = newId('ch')
  await deps.store.upsertChannel({
    id, type: b.type!, name: b.name ?? b.type!,
    config_enc: await deps.cipher.encrypt(JSON.stringify(parsed.data)),
    enabled: b.enabled ?? true, created_at: now(),
  })
  json(res, 200, { id })
})

route('DELETE', '/api/channels/:id', async ({ res, params, deps }) => {
  await deps.store.deleteChannel(params.id!)
  json(res, 200, { ok: true })
})

/**
 * 渠道测试。不是可选功能：配错渠道是这类系统最常见的故障，
 * 而故障时你收不到任何通知——这是个静默失败（计划 §7.4）。
 */
route('POST', '/api/channels/:id/test', async ({ res, params, deps }) => {
  const c = await deps.store.getChannel(params.id!)
  if (!c) return json(res, 404, { error: '渠道不存在' })

  const provider = PROVIDERS[c.type]
  if (!provider) return json(res, 400, { error: `未知渠道类型 ${c.type}` })
  // 与 pipeline 一致：过一遍 schema，让默认值对老配置也生效
  const parsed = provider.configSchema.safeParse(JSON.parse(await deps.cipher.decrypt(c.config_enc)))
  if (!parsed.success) return json(res, 400, { error: '渠道配置已失效，请重新保存' })

  const cfg: ChannelConfig = {
    id: c.id, type: c.type, name: c.name, config: parsed.data, enabled: true,
  }
  const [r] = await dispatch([cfg], {
    title: '短信网关', body: '这是一条测试消息，收到即说明渠道配置正确。',
    priority: 'normal', code: null, eventId: '', occurredAt: now(),
  })
  json(res, r?.ok ? 200 : 502, { ok: r?.ok ?? false, attempts: r?.attempts ?? 0, error: r?.error ?? null })
})

// ── 规则 ────────────────────────────────────────────────────

route('GET', '/api/rules', async ({ res, deps }) => {
  const rows = await deps.store.listRules()
  json(res, 200, {
    rules: rows.map((r) => ({
      id: r.id, name: r.name, priority: r.priority, enabled: r.enabled,
      match: JSON.parse(r.match_json), action: JSON.parse(r.action_json), created_at: r.created_at,
    })),
  })
})

route('POST', '/api/rules', async ({ res, body, deps }) => {
  const b = body as { id?: string; name?: string; priority?: number; enabled?: boolean; match?: unknown; action?: unknown }
  const m = RuleMatch.safeParse(b.match ?? {})
  const a = RuleAction.safeParse(b.action ?? {})
  if (!m.success || !a.success) {
    const issues = [...(m.success ? [] : m.error.issues), ...(a.success ? [] : a.error.issues)]
    return json(res, 400, { error: '规则校验失败', detail: issues.map((i) => `${i.path.join('.')}: ${i.message}`) })
  }
  const id = b.id ?? newId('rule')
  await deps.store.upsertRule({
    id, name: b.name ?? '未命名规则', priority: b.priority ?? 100,
    enabled: b.enabled ?? true,
    match_json: JSON.stringify(m.data), action_json: JSON.stringify(a.data),
    created_at: now(),
  })
  json(res, 200, { id })
})

route('DELETE', '/api/rules/:id', async ({ res, params, deps }) => {
  await deps.store.deleteRule(params.id!)
  json(res, 200, { ok: true })
})

// ── 下行发送 ────────────────────────────────────────────────

/**
 * 发短信限速。
 *
 * 这个接口能让设备真的发出短信，误用或凭证泄露的代价是实打实的话费与骚扰，
 * 所以即便已经过了鉴权也要限速（计划 §11.4 安全约束③）。
 */
const outboundWindow: number[] = []
const OUTBOUND_MAX_PER_HOUR = 20

function outboundRateLimited(): boolean {
  const cutoff = now() - 3600_000
  while (outboundWindow.length > 0 && outboundWindow[0]! < cutoff) outboundWindow.shift()
  if (outboundWindow.length >= OUTBOUND_MAX_PER_HOUR) return true
  outboundWindow.push(now())
  return false
}

route('POST', '/api/outbound', async ({ res, body, deps, ip }) => {
  const b = body as { device_id?: string; to?: string; text?: string; sim_slot?: number | null }
  if (!b.device_id || !b.to || !b.text) return json(res, 400, { error: '缺少 device_id / to / text' })
  if (b.text.length > 4096) return json(res, 400, { error: '内容过长' })

  if (outboundRateLimited()) {
    log.warn('发送请求超出限速', { ip })
    return json(res, 429, { error: `超出限速（每小时 ${OUTBOUND_MAX_PER_HOUR} 条）` })
  }

  const device = await deps.store.getDevice(b.device_id)
  if (!device) return json(res, 404, { error: '设备不存在' })
  if (device.status === 'revoked') return json(res, 403, { error: '设备凭证已吊销' })

  // cmd_id 即 outbound id：一一对应，服务端不需要额外的映射表
  const id = `cmd_${crypto.randomUUID()}`
  const t = now()
  await deps.store.createOutbound({
    id, device_id: b.device_id, to_number: b.to,
    content_enc: await deps.cipher.encrypt(b.text),
    sim_slot: b.sim_slot ?? null,
    status: 'pending', error: null, created_at: t, updated_at: t,
  })

  const frame = makeFrame('cmd', {
    cmd_id: id, action: 'send_sms',
    args: { to: b.to, text: b.text, sim_slot: b.sim_slot ?? null },
  }, t) as DownstreamFrame

  // 设备离线就直接失败：短信有时效性，排队几小时后再发出去
  // 往往比不发更糟（验证码早已过期，对方收到莫名其妙的回复）
  if (!deps.hub.send(b.device_id, frame)) {
    await deps.store.advanceOutbound(id, 'failed', '设备离线', now())
    return json(res, 503, { id, status: 'failed', error: '设备离线' })
  }

  await deps.store.audit({ actor: 'console', action: 'outbound.create', detail: `${id} → ${maskNumber(b.to)}`, ip, created_at: t })
  json(res, 202, { id, status: 'pending' })
})

route('GET', '/api/outbound/:id', async ({ res, params, deps }) => {
  const o = await deps.store.getOutbound(params.id!)
  if (!o) return json(res, 404, { error: '任务不存在' })
  json(res, 200, {
    id: o.id, device_id: o.device_id, to: o.to_number,
    text: await deps.cipher.decrypt(o.content_enc),
    sim_slot: o.sim_slot, status: o.status, error: o.error,
    created_at: o.created_at, updated_at: o.updated_at,
  })
})

route('GET', '/api/outbound', async ({ res, url, deps }) => {
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 50), 200)
  const offset = Math.max(Number(url.searchParams.get('offset') ?? 0), 0)
  const rows = await deps.store.listOutbound(limit, offset)
  json(res, 200, {
    outbound: await Promise.all(rows.map(async (o) => ({
      id: o.id, device_id: o.device_id, to: o.to_number,
      text: await deps.cipher.decrypt(o.content_enc),
      status: o.status, error: o.error, created_at: o.created_at, updated_at: o.updated_at,
    }))),
  })
})

/** 审计日志里不写完整号码。 */
const maskNumber = (n: string): string =>
  n.length <= 5 ? '*'.repeat(n.length) : n.slice(0, 3) + '*'.repeat(n.length - 5) + n.slice(-2)

// ── 事件 ────────────────────────────────────────────────────

route('GET', '/api/events', async ({ res, url, deps }) => {
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 50), 200)
  const offset = Math.max(Number(url.searchParams.get('offset') ?? 0), 0)
  const kindParam = url.searchParams.get('kind')
  const rows = await deps.store.listEvents({
    limit, offset,
    ...(kindParam === 'sms' || kindParam === 'call' || kindParam === 'notification' ? { kind: kindParam } : {}),
  })
  const items = await Promise.all(rows.map(async (e) => ({
    id: e.id, device_id: e.device_id, kind: e.kind,
    from: await deps.cipher.decrypt(e.sender_enc),
    content: await deps.cipher.decrypt(e.content_enc),
    occurred_at: e.occurred_at, received_at: e.received_at,
    matched_rules: e.matched_rules ? JSON.parse(e.matched_rules) : [],
  })))
  json(res, 200, { events: items, limit, offset })
})

// ── 分发 ────────────────────────────────────────────────────

export async function handleApi(req: IncomingMessage, res: ServerResponse, deps: ApiDeps): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (!url.pathname.startsWith('/api/')) return false

  const match = routes.find((r) => r.method === (req.method ?? 'GET') && r.pattern.test(url.pathname))
  // 未匹配的 /api/* 返回 404 而不是 405，不泄漏有哪些路由存在
  if (!match) { json(res, 404, { error: 'not found' }); return true }

  const ip = clientIp(req)

  if (match.auth && !checkAuth(req, deps.adminToken)) {
    // 未认证一律 404，不返回 401——不确认接口存在（计划 §6.3）
    json(res, 404, { error: 'not found' })
    return true
  }

  const m = match.pattern.exec(url.pathname)!
  const params: Record<string, string> = {}
  match.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]!) })

  let body: unknown = null
  if (req.method === 'POST' || req.method === 'PUT') {
    try {
      body = await readJson(req)
    } catch {
      json(res, 400, { error: '请求体不是合法 JSON' })
      return true
    }
  }

  try {
    await match.handler({ req, res, url, params, body, deps, ip })
  } catch (e) {
    log.error('API 处理异常', { path: url.pathname, error: String(e) })
    if (!res.headersSent) json(res, 500, { error: 'internal error' })
  }
  return true
}

function checkAuth(req: IncomingMessage, adminToken: string): boolean {
  const h = req.headers.authorization
  if (!h?.startsWith('Bearer ')) return false
  return timingSafeEqual(h.slice(7), adminToken)
}

/**
 * 客户端 IP。
 *
 * X-Forwarded-For 只有在确知请求来自可信反代时才可采信；
 * GW_TRUSTED_PROXY 的校验尚未实现，因此这里暂时只用连接地址——
 * 宁可限速粒度粗一点，也不能让 IP 可被伪造（计划 §11.6）。
 */
function clientIp(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? 'unknown'
}

const MAX_BODY = 256 * 1024

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw.trim()) return resolve(null)
      try { resolve(JSON.parse(raw)) } catch (e) { reject(e as Error) }
    })
    req.on('error', reject)
  })
}
