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
import {
  generateSessionToken, generateTotpSecret, hashPassword,
  LOGIN_LOCKOUT_MS, LOGIN_MAX_ATTEMPTS, SESSION_TTL_MS,
  totpUri, verifyPassword, verifyTotp,
} from '../../core/auth.js'
import { hashToken, timingSafeEqual } from '../../core/crypto.js'
import type { Cipher } from '../../core/crypto.js'
import { log } from '../../core/logging.js'
import { dispatch, PROVIDERS, type ChannelConfig } from '../../core/notifier.js'
import { createPairing, redeemPairing } from '../../core/pairing.js'
import { makeFrame, newCmdId } from '../../core/frames.js'
import type { DownstreamFrame } from '../../core/protocol.js'
import { extractCode, matchRule, render, RuleAction, RuleMatch, type Rule } from '../../core/rules.js'
import { buildSeedRules } from '../../core/seeds.js'
import type { Hub } from '../../core/hub.js'
import type { Store } from '../../core/store.js'

export interface ApiDeps {
  store: Store
  cipher: Cipher
  hub: Hub
  /** 自建 bark-server 的内部地址；未部署则为 null */
  barkUpstream?: string | null
  /** 对外可访问的 Bark 地址，供 Bark App 填写 */
  barkPublicUrl?: string | null
  /** 自动化用的长期 token。人使用控制台时走会话，不用它。 */
  adminToken: string
  /** 登录失败达到阈值时的告警回调。计划 §6.3 要求「失败立即告警到 Telegram」。 */
  onLoginLockout?: ((ip: string, attempts: number) => void) | undefined
}

/** 设置表的键。initialized 未置位前，除向导外一切请求都拒绝。 */
const S_PASSWORD = 'admin_password_hash'
const S_TOTP = 'totp_secret'
const S_INITIALIZED = 'initialized'
/** Bark 反代是否对外开放。默认关闭——开放等于把推送服务白送给全网。 */
const S_BARK_PUBLIC = 'bark_public'

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

/** setup=true 表示这是向导路由，在未初始化时**仅**这些可访问。 */
interface Route { method: string; pattern: RegExp; keys: string[]; handler: Handler; auth: boolean; setup?: boolean }
const routes: Route[] = []

function route(method: string, path: string, handler: Handler, auth = true, setup = false): void {
  const keys: string[] = []
  const pattern = new RegExp(
    '^' + path.replace(/:(\w+)/g, (_m, k: string) => { keys.push(k); return '([^/]+)' }) + '$',
  )
  routes.push({ method, pattern, keys, handler, auth, setup })
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

// ── 首次配置向导（计划 §12.1①）──────────────────────────────

/**
 * 未完成初始化前，除向导外**所有路由一律 403**，包括 API 与 WS。
 * 不存在「启动即裸奔」的窗口期 —— OpenClaw 那 40 万个暴露实例，
 * 根子就是默认无认证。
 */
export async function isInitialized(store: Store): Promise<boolean> {
  return (await store.getSetting(S_INITIALIZED)) === '1'
}

route('GET', '/api/setup/status', async ({ res, deps }) => {
  json(res, 200, { initialized: await isInitialized(deps.store) })
}, false, true)

/** 第一步：设管理员口令，返回 TOTP 密钥供扫码绑定。 */
route('POST', '/api/setup/password', async ({ res, body, deps, ip }) => {
  if (await isInitialized(deps.store)) return json(res, 409, { error: '已初始化' })

  const pw = (body as { password?: string })?.password ?? ''
  if (pw.length < 12) return json(res, 400, { error: '口令至少 12 位' })

  await deps.store.setSetting(S_PASSWORD, await hashPassword(pw))
  const secret = generateTotpSecret()
  await deps.store.setSetting(S_TOTP, secret)
  await deps.store.audit({ actor: 'setup', action: 'setup.password', detail: null, ip, created_at: now() })

  json(res, 200, { secret, uri: totpUri(secret, 'admin') })
}, false, true)

/** 第二步：验证一次 TOTP，确认认证器已正确绑定，然后才置初始化标记。 */
route('POST', '/api/setup/verify', async ({ res, body, deps, ip }) => {
  if (await isInitialized(deps.store)) return json(res, 409, { error: '已初始化' })

  const secret = await deps.store.getSetting(S_TOTP)
  if (!secret) return json(res, 400, { error: '请先设置口令' })

  const code = (body as { code?: string })?.code ?? ''
  if (!(await verifyTotp(secret, code))) return json(res, 401, { error: '验证码不正确' })

  await deps.store.setSetting(S_INITIALIZED, '1')
  await deps.store.audit({ actor: 'setup', action: 'setup.complete', detail: null, ip, created_at: now() })
  json(res, 200, { ok: true })
}, false, true)

// ── 登录 ────────────────────────────────────────────────────

/** 登录失败计数。锁定状态可从审计日志重建，这里只是快路径。 */
const loginFails = new Map<string, { count: number; until: number }>()

route('POST', '/api/auth/login', async ({ req, res, body, deps, ip }) => {
  const rec = loginFails.get(ip)
  if (rec && now() < rec.until) {
    return json(res, 429, { error: '尝试过于频繁，请稍后再试' })
  }

  const b = body as { password?: string; code?: string }
  const stored = await deps.store.getSetting(S_PASSWORD)
  const secret = await deps.store.getSetting(S_TOTP)
  if (!stored || !secret) return json(res, 500, { error: '服务端未正确初始化' })

  const okPw = verifyPassword(b.password ?? '', stored)
  const okTotp = okPw && (await verifyTotp(secret, b.code ?? ''))

  if (!okPw || !okTotp) {
    const c = (rec?.count ?? 0) + 1
    loginFails.set(ip, {
      count: c,
      until: c >= LOGIN_MAX_ATTEMPTS ? now() + LOGIN_LOCKOUT_MS : 0,
    })
    await deps.store.audit({
      actor: null, action: 'auth.fail',
      detail: `第 ${c} 次，${okPw ? 'TOTP' : '口令'}不正确`, ip, created_at: now(),
    })
    log.warn('登录失败', { ip, attempt: c })
    if (c >= LOGIN_MAX_ATTEMPTS) void deps.onLoginLockout?.(ip, c)
    // 不区分口令错还是 TOTP 错，避免为逐项爆破提供反馈
    return json(res, 401, { error: '口令或验证码不正确' })
  }

  loginFails.delete(ip)
  const token = generateSessionToken()
  const t = now()
  await deps.store.createSession({
    token_hash: await hashToken(token),
    ua_hash: await hashToken(req.headers['user-agent'] ?? ''),
    ip_prefix: ipPrefix(ip),
    created_at: t,
    expires_at: t + SESSION_TTL_MS,
    revoked: false,
  })
  await deps.store.audit({ actor: 'admin', action: 'auth.login', detail: null, ip, created_at: t })
  json(res, 200, { token, expires_in: Math.floor(SESSION_TTL_MS / 1000) })
}, false)

route('POST', '/api/auth/logout', async ({ req, res, deps }) => {
  const h = req.headers.authorization
  if (h?.startsWith('Bearer ')) await deps.store.revokeSession(await hashToken(h.slice(7)))
  json(res, 200, { ok: true })
})

route('GET', '/api/auth/me', async ({ res }) => {
  json(res, 200, { ok: true })
})

/** 改口令：成功后使全部会话失效，包括当前这个（计划 §11.6「全端下线」）。 */
route('POST', '/api/auth/password', async ({ res, body, deps, ip }) => {
  const b = body as { old?: string; new?: string }
  const stored = await deps.store.getSetting(S_PASSWORD)
  if (!stored || !verifyPassword(b.old ?? '', stored)) return json(res, 401, { error: '原口令不正确' })
  if ((b.new ?? '').length < 12) return json(res, 400, { error: '新口令至少 12 位' })

  await deps.store.setSetting(S_PASSWORD, await hashPassword(b.new!))
  await deps.store.revokeAllSessions()
  await deps.store.audit({ actor: 'admin', action: 'auth.password_change', detail: null, ip, created_at: now() })
  json(res, 200, { ok: true })
})

/** IP 前缀：IPv4 取前三段，IPv6 取前四组。会话绑定到网段而非具体地址，
 *  因为移动网络的出口 IP 会在同网段内漂移，绑死会导致频繁掉线。 */
export function ipPrefix(ip: string): string {
  const v4 = ip.replace(/^::ffff:/, '')
  if (/^\d+\.\d+\.\d+\.\d+$/.test(v4)) return v4.split('.').slice(0, 3).join('.')
  return v4.split(':').slice(0, 4).join(':')
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

/**
 * 用历史消息试跑规则（计划 §7.4）。
 *
 * 没有这个功能，规则写错的反馈周期是「等下一条真实短信」——
 * 调试成本高到会让人放弃使用规则引擎。
 */
route('POST', '/api/rules/test', async ({ res, body, deps }) => {
  const b = body as { match?: unknown; action?: unknown; limit?: number }
  const m = RuleMatch.safeParse(b.match ?? {})
  const a = RuleAction.safeParse(b.action ?? {})
  if (!m.success || !a.success) return json(res, 400, { error: '规则格式不正确' })

  const rule: Rule = {
    id: '__test__', name: '试跑', priority: 0, enabled: true,
    match: m.data, action: a.data,
  }

  const rows = await deps.store.listEvents({ limit: Math.min(b.limit ?? 50, 200), offset: 0 })
  const results = await Promise.all(rows.map(async (e) => {
    const ev = {
      device_id: e.device_id, kind: e.kind,
      from: await deps.cipher.decrypt(e.sender_enc),
      content: await deps.cipher.decrypt(e.content_enc),
      occurred_at: e.occurred_at,
    }
    const hit = matchRule(rule, ev, tzOffsetMin())
    const code = hit && rule.action.extract_code ? extractCode(ev.content) : null
    return {
      id: e.id, from: ev.from, content: ev.content, kind: e.kind,
      occurred_at: e.occurred_at, matched: hit,
      code,
      preview: hit
        ? render(rule.action.template, {
            sender: ev.from, content: ev.content, code: code ?? '',
            time: new Date(e.occurred_at).toISOString(), device: e.device_id,
          })
        : null,
    }
  }))

  json(res, 200, {
    total: results.length,
    matched: results.filter((r) => r.matched).length,
    results,
  })
})

/** 一键写入建议的初始规则集。规则定义在 core/seeds.ts，两端共用同一份语义。 */
route('POST', '/api/rules/seed', async ({ res, body, deps }) => {
  const chIds = ((body as { channels?: string[] })?.channels ?? []).filter(Boolean)
  if (chIds.length === 0) return json(res, 400, { error: '请先选择至少一个渠道' })

  const t = now()
  const seeds = buildSeedRules(chIds, () => newId('rule'))
  for (const r of seeds) {
    await deps.store.upsertRule({
      id: r.id, name: r.name, priority: r.priority, enabled: true,
      match_json: JSON.stringify(r.match), action_json: JSON.stringify(r.action), created_at: t,
    })
  }
  json(res, 200, { created: seeds.length })
})

/** 服务端本地时区偏移，供规则的 time_window 使用。 */
const tzOffsetMin = (): number => -new Date().getTimezoneOffset()

// ── Bark 设置 ───────────────────────────────────────────────

export async function isBarkPublic(store: Store): Promise<boolean> {
  return (await store.getSetting(S_BARK_PUBLIC)) === '1'
}

route('GET', '/api/bark/info', async ({ res, deps }) => {
  json(res, 200, {
    // 网关推送走内部地址，不绕公网；渠道配置里就该填这个
    upstream: deps.barkUpstream ?? null,
    // Bark App 里填这个，用于注册与令牌刷新
    public_url: deps.barkPublicUrl ?? null,
    public_enabled: await isBarkPublic(deps.store),
  })
})

/**
 * 开关对外开放。
 *
 * 典型用法是临时开启：在 Bark App 里完成注册拿到 device key，然后关掉。
 * 关闭后网关自己的推送不受影响——它走内部地址。
 */
route('POST', '/api/bark/public', async ({ res, body, deps, ip }) => {
  const on = (body as { enabled?: boolean })?.enabled === true
  await deps.store.setSetting(S_BARK_PUBLIC, on ? '1' : '0')
  await deps.store.audit({
    actor: 'admin', action: on ? 'bark.public_on' : 'bark.public_off',
    detail: null, ip, created_at: now(),
  })
  json(res, 200, { public_enabled: on })
})

// ── 总览统计 ────────────────────────────────────────────────

route('GET', '/api/stats', async ({ res, deps }) => {
  const devices = await deps.store.listDevices()
  const online = new Set(deps.hub.onlineDevices())
  const dayAgo = now() - 86_400_000

  const todayEvents = (await deps.store.listEvents({ limit: 500, offset: 0, since: dayAgo })).length
  const outbound = await deps.store.listOutbound(200, 0)
  const todayOutbound = outbound.filter((o) => o.created_at >= dayAgo)

  json(res, 200, {
    devices: devices.map((d) => ({
      id: d.id, name: d.name,
      status: d.status === 'revoked' ? 'revoked' : online.has(d.id) ? 'online' : 'offline',
      last_seen_at: d.last_seen_at, battery: d.battery, app_version: d.app_version,
    })),
    today: {
      events: todayEvents,
      outbound: todayOutbound.length,
      outbound_failed: todayOutbound.filter((o) => o.status === 'failed').length,
    },
    channels: (await deps.store.listChannels()).filter((c) => c.enabled).length,
    rules: (await deps.store.listRules()).filter((r) => r.enabled).length,
  })
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
  const q = url.searchParams.get('q')?.trim().toLowerCase()
  const rows = await deps.store.listEvents({
    // 有搜索词时多取一些再在内存里过滤：正文是密文，数据库无法直接检索
    limit: q ? Math.min(limit * 10, 500) : limit, offset,
    ...(kindParam === 'sms' || kindParam === 'call' || kindParam === 'notification' ? { kind: kindParam } : {}),
  })
  let items = await Promise.all(rows.map(async (e) => ({
    id: e.id, device_id: e.device_id, kind: e.kind,
    from: await deps.cipher.decrypt(e.sender_enc),
    content: await deps.cipher.decrypt(e.content_enc),
    occurred_at: e.occurred_at, received_at: e.received_at,
    matched_rules: e.matched_rules ? JSON.parse(e.matched_rules) : [],
  })))
  // 全文检索在内存里做：落库是密文，SQL 的 LIKE 搜不了。
  // 数据量到不了瓶颈之前这样最简单，也不会堵死 D1 路径（硬约束②）。
  if (q) {
    items = items
      .filter((e) => e.from.toLowerCase().includes(q) || e.content.toLowerCase().includes(q))
      .slice(0, limit)
  }
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

  // 未完成初始化时，除向导外一切拒绝（计划 §12.1①）
  if (!match.setup && !(await isInitialized(deps.store))) {
    json(res, 403, { error: '服务端尚未完成初始化，请先访问控制台完成配置向导' })
    return true
  }

  if (match.auth && !(await checkAuth(req, deps, ip))) {
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

/**
 * 鉴权：先试会话，再试长期管理 token。
 *
 * 会话额外校验 UA 与 IP 段——凭证被盗后换台设备或换个网段就用不了。
 * 每次通过都顺延有效期：30 分钟是「无操作超时」，不是「登录后强制下线」。
 */
async function checkAuth(req: IncomingMessage, deps: ApiDeps, ip: string): Promise<boolean> {
  const h = req.headers.authorization
  if (!h?.startsWith('Bearer ')) return false
  const presented = h.slice(7)

  const sess = await deps.store.getSession(await hashToken(presented))
  if (sess) {
    const t = now()
    if (sess.revoked || sess.expires_at < t) return false
    if (!timingSafeEqual(sess.ua_hash, await hashToken(req.headers['user-agent'] ?? ''))) {
      log.warn('会话 UA 不匹配，已拒绝', { ip })
      return false
    }
    if (sess.ip_prefix !== ipPrefix(ip)) {
      log.warn('会话 IP 段不匹配，已拒绝', { ip })
      return false
    }
    await deps.store.touchSession(sess.token_hash, t + SESSION_TTL_MS)
    return true
  }

  return timingSafeEqual(presented, deps.adminToken)
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
