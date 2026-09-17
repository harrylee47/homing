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
  generatePassword, generateSessionToken, generateTotpSecret, hashPassword,
  LOGIN_LOCKOUT_MS, LOGIN_MAX_ATTEMPTS, SESSION_TTL_MS, TRUSTED_SESSION_TTL_MS,
  totpUri, validatePassword, verifyPassword, verifyTotp,
} from '../../core/auth.js'
import { fromHex, hashToken, timingSafeEqual, toHex } from '../../core/crypto.js'
import { generateVapidKeys, type VapidKeys } from '../../core/webpush.js'
import {
  BACKUP_NOTICE, BACKUP_VERSION, EXPORTABLE_USER_SETTINGS,
  redactChannelConfig, redactUserSetting, validateBackup, type BackupFile,
} from '../../core/backup.js'
import { once } from 'node:events'
import { WebPushConfig } from '../../core/providers/webpush.js'
import type { Cipher } from '../../core/crypto.js'
import { log } from '../../core/logging.js'
import { dispatch, PROVIDERS, type ChannelConfig } from '../../core/notifier.js'
import { createPairing, redeemPairing } from '../../core/pairing.js'
import {
  RETAINABLE_KINDS, RETENTION_CHOICES, RETENTION_KEYS, RETENTION_SETTING, newAccountRetention,
  parseRetention, sanitizeRetention, serializeRetention, trimUserNow,
  type RetainableKind,
} from '../../core/retention.js'
import { describeFetchError } from '../../core/neterror.js'
import {
  ANNOUNCE_LIMIT, PUBLIC_INVITE_LIMIT, SELF_INVITE_PER_DAY, SELF_INVITE_TTL_MS,
  dayStart, inviteState, normalizeAnnouncement,
} from '../../core/notice.js'
import { makeFrame, newCmdId } from '../../core/frames.js'
import { SmsCommandConfig, type DownstreamFrame } from '../../core/protocol.js'
import { extractCode, matchRule, render, RuleAction, RuleMatch, type Rule } from '../../core/rules.js'
import { DEFAULT_TIMEZONE, Schedule, describe as describeSchedule, formatWallTime, offsetMs } from '../../core/schedule.js'
import { BATTERY_SETTING_KEY, loadBatteryConfig } from '../../core/monitor.js'
import { parseTask, taskNextRun, type ParsedTask } from '../../core/tasks.js'
import { toSvg } from '../../core/qr.js'
import { eventFingerprint, planReconcile } from '../../core/fingerprint.js'
import { scanMatches } from '../../core/search.js'
import { simLabel, simsOf } from '../../core/sim.js'
import { checkWebhookTarget } from '../../core/ssrf.js'
import { daysLeft, inactiveReason, userActive } from '../../core/users.js'
import { groupThreads, mergeThread, threadKey, type ThreadItem } from '../../core/thread.js'
import { buildSeedRules } from '../../core/seeds.js'
import type { Hub } from '../../core/hub.js'
import type { BarkAccess } from './barkproxy.js'
import { clientIp as resolveClientIp } from './clientip.js'
import type { EventFilter, InviteRecord, OutboundRecord, Store, UserRecord } from '../../core/store.js'

export interface ApiDeps {
  store: Store
  cipher: Cipher
  hub: Hub
  /** 自建 bark-server 的内部地址；未部署则为 null */
  barkUpstream?: string | null
  /** 对外可访问的 Bark 地址，供 Bark App 填写 */
  barkPublicUrl?: string | null
  /** 控制台自己的对外地址，用于生成配对二维码里的 WS 地址 */
  baseUrl?: string | null
  /** 自动化用的长期 token。人使用控制台时走会话，不用它。 */
  adminToken: string
  /** 登录失败达到阈值时的告警回调。计划 §6.3 要求「失败立即告警到 Telegram」。 */
  onLoginLockout?: ((ip: string, attempts: number) => void) | undefined
  /** 陌生网段登录成功时的告警回调 */
  onUnknownIpLogin?: ((ip: string) => void) | undefined
  /** 口令被自助找回时通知本人的渠道。没有第二因素时这是唯一的事后检测手段 */
  onPasswordRecovered?: ((userId: string, ip: string) => void) | undefined
  /** 把找回码发到本人自己的渠道。没配渠道时什么都不做——调用方不该知道结果 */
  sendRecoveryCode?: ((userId: string, code: string) => void) | undefined
  /** 管理员重置了某人的口令时通知本人——这是他真能收到的东西，审计日志他看不到 */
  onPasswordReset?: ((userId: string, byName: string) => void) | undefined
  /** 立即执行一个计划任务（忽略排期），用于控制台的「立即测试」。 */
  runTask?: ((task: ParsedTask) => Promise<{ sent: boolean; reason?: string }>) | undefined
  /**
   * 给设备发一帧 ping，让它立刻回一个带全量状态的 pong。
   * 返回 false 表示设备不在线。不新增 cmd action——pong 里本来就什么都有。
   */
  pingDevice?: ((deviceId: string) => boolean) | undefined
  /** 向设备请求一次定位 */
  locateDevice?: ((deviceId: string) => Promise<{ ok: boolean; location?: unknown; error?: string }>) | undefined
  /** 向设备要一份它自己的日志。只在设备在线时可用 */
  agentLogs?: ((deviceId: string, limit: number, minLevel: string) => Promise<{ ok: boolean; result?: unknown; error?: string }>) | undefined
  /** 让设备列出已安装应用 */
  listApps?: ((deviceId: string) => Promise<{ ok: boolean; apps?: unknown; error?: string }>) | undefined
  /** 让设备导入本机已有的历史短信与通话 */
  importHistory?: ((deviceId: string, since: number | null, limit: number) =>
    Promise<{ ok: boolean; result?: unknown; error?: string }>) | undefined
  /** 取设备本地当前还有哪些记录的指纹，用于镜像同步 */
  listFingerprints?: ((deviceId: string, since: number | null, limit: number) =>
    Promise<{ ok: boolean; items?: { fp: string; at: number }[]; truncated?: boolean; error?: string }>) | undefined
  /** 断开全部设备连接，迫使它们重连并拉取新配置 */
  reconnectDevices?: (() => void) | undefined
  /** 可信反代网段。未配置时一律采用连接地址，不采信 X-Forwarded-For。 */
  trustedProxy?: string | null
}

/** 设置表的键。initialized 未置位前，除向导外一切请求都拒绝。 */
const S_PASSWORD = 'admin_password_hash'
const S_TOTP = 'totp_secret'
const S_INITIALIZED = 'initialized'
/** Bark 反代的对外开放档位：off / push / full。默认 push。 */
const S_BARK_ACCESS = 'bark_access'
/** Bot 专用的 service token。权限比 Web 会话低一档，可单独吊销（计划 §11.4）。 */
/** 见过的登录来源网段，用于识别异地登录。 */
const S_KNOWN_IPS = 'known_login_ips'

type Handler = (ctx: Ctx) => Promise<void>
interface Ctx {
  req: IncomingMessage
  res: ServerResponse
  url: URL
  params: Record<string, string>
  body: unknown
  deps: ApiDeps
  ip: string
  /**
   * 这次请求是谁。
   *
   * 鉴权通过后必定有值；免鉴权的路由（向导、登录、Bark 反代）拿到的是
   * 一个占位用户，它的 id 是空串——空串匹配不到任何数据，
   * 万一被误用只会查到空结果，而不是别人的短信。
   */
  user: UserRecord
}

/**
 * 第一个管理员的固定 id。
 *
 * 固定而不是随机：向导可能被重复提交（TOTP 那步没过又回来改口令），
 * 固定 id 才能覆盖而不是攒出一堆半成品账号。老库升级时，
 * 原来那套单用户数据也是认领给它。
 */
const FIRST_USER_ID = 'usr_first'

/**
 * 隐私声明的版本。
 *
 * 改了声明内容就 +1：已经同意过旧版的人下次登录要重新看一遍。
 * 不做版本管理的话，「他同意的是哪一版」这个问题永远答不上来。
 */
export const PRIVACY_VERSION = '2026-09-18'

/** 账号有效期的可选档位（天）。null = 永久。 */
const VALIDITY_DAYS = [7, 30, 90, 180, 365] as const

/**
 * 把「几天」换成到期时刻。
 *
 * 不接受任意数字：这是个有限集合，按 CLAUDE.md 那条「不要让人手写枚举值」，
 * 界面上给下拉，后端也只认这几个值——省得有人传个 99999 天当永久用。
 */
function expiresAtFrom(days: unknown, opts: { from?: number | null } = {}): number | null {
  const n = Number(days)
  if (!(VALIDITY_DAYS as readonly number[]).includes(n)) return null
  // 续期从「原到期时刻」往后接，还没到期的部分不该被抹掉；
  // 已经过期的则从现在起算
  const base = Math.max(opts.from ?? 0, now())
  return base + n * 86_400_000
}

/** 给前端的用户信息。口令哈希、TOTP 密钥、bot token 一概不出门 */
const publicUser = (u: UserRecord): Record<string, unknown> => ({
  id: u.id, name: u.name, role: u.role, disabled: u.disabled,
  expires_at: u.expires_at, days_left: daysLeft(u, now()),
  totp: u.totp_secret !== '',
  agreed_version: u.agreed_version,
  created_at: u.created_at,
})

/**
 * 登录名的规矩。
 *
 * 限制成字母数字加中划线下划线，不是洁癖：这个名字会出现在 TOTP 的标签、
 * 审计日志、URL 里，留空格和特殊字符只会在某个意想不到的地方咬人。
 */
function validateUserName(name: string): { ok: true } | { ok: false; error: string } {
  if (name.length < 2 || name.length > 24) return { ok: false, error: '用户名需要 2–24 个字符' }
  if (!/^[A-Za-z0-9_-]+$/.test(name)) return { ok: false, error: '用户名只能用字母、数字、- 和 _' }
  return { ok: true }
}

/** 免鉴权路由用的占位用户。id 为空串，查什么都是空 */
const ANON: UserRecord = {
  id: '', name: '', password_hash: '', totp_secret: '',
  role: 'member', bot_token: '', disabled: false,
  expires_at: null, agreed_version: null, agreed_at: null, created_at: 0,
}

// ── 路由表 ──────────────────────────────────────────────────

/**
 * scope 决定谁能访问：
 * - 'admin'（默认）只有 Web 会话与管理 token
 * - 'bot' 额外允许 Bot 的 service token
 *
 * 权限分级用路由白名单而不是运行时判断：Telegram 账号被盗的概率高于
 * 控制台口令 + TOTP 被攻破，所以 Bot 不应拥有配置类权限（计划 §11.1）。
 */
type Scope = 'admin' | 'bot'
interface Route {
  method: string; pattern: RegExp; keys: string[]
  handler: Handler; auth: boolean; setup?: boolean; scope: Scope
}
const routes: Route[] = []

function route(method: string, path: string, handler: Handler, auth = true, setup = false, scope: Scope = 'admin'): void {
  const keys: string[] = []
  const pattern = new RegExp(
    '^' + path.replace(/:(\w+)/g, (_m, k: string) => { keys.push(k); return '([^/]+)' }) + '$',
  )
  routes.push({ method, pattern, keys, handler, auth, setup, scope })
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
 * 卡槽序号。非法值一律当「不指定」，不要 400——
 * 单卡设备上界面根本不显示这个选项，传上来什么都不该让保存失败。
 */
function simSlotOf(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v !== '' ? Number(v) : NaN
  return Number.isInteger(n) && n >= 0 && n <= 3 ? n : null
}

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

route('GET', '/api/setup/status', async ({ user, res, deps }) => {
  json(res, 200, { initialized: await isInitialized(deps.store) })
}, false, true)

/** 第一步：建第一个管理员，返回 TOTP 密钥供扫码绑定。 */
route('POST', '/api/setup/password', async ({ res, body, deps, ip }) => {
  if (await isInitialized(deps.store)) return json(res, 409, { error: '已初始化' })

  const b = body as { password?: string; name?: string }
  const pw = b?.password ?? ''
  const check = validatePassword(pw)
  if (!check.ok) return json(res, 400, { error: check.error })
  const name = (b?.name ?? '').trim() || 'admin'
  const nameCheck = validateUserName(name)
  if (!nameCheck.ok) return json(res, 400, { error: nameCheck.error })

  const secret = generateTotpSecret()
  // 向导可能被重复提交（TOTP 那步没过就回来改口令），按固定 id 覆盖而不是新建
  await deps.store.upsertUser({
    id: FIRST_USER_ID, name,
    password_hash: await hashPassword(pw),
    totp_secret: secret,
    role: 'admin', bot_token: generateSessionToken(),
    // 第一个管理员不设期限，也视同已同意——这台机器是他自己的
    disabled: false, expires_at: null,
    agreed_version: PRIVACY_VERSION, agreed_at: now(), created_at: now(),
  })
  await seedRetention(deps.store, FIRST_USER_ID)
  await deps.store.audit({ user_id: FIRST_USER_ID, actor: 'setup', action: 'setup.password', detail: name, ip, created_at: now() })

  const uri = totpUri(secret, name)
  json(res, 200, { secret, uri, qr: toSvg(uri, { label: '两步验证绑定二维码' }), name })
}, false, true)

/** 第二步：验证一次 TOTP，确认认证器已正确绑定，然后才置初始化标记。 */
/**
 * 第二步：绑定两步验证，或者明确跳过。
 *
 * 两步验证是可选的，所以这一步必须能跳——否则「第一个管理员从哪来」
 * 就没有不绑的路径了。跳过之后口令就是这个账号唯一的钥匙，
 * 界面上要把这件事连同「没有自助找回」一起讲清楚。
 */
route('POST', '/api/setup/verify', async ({ res, body, deps, ip }) => {
  if (await isInitialized(deps.store)) return json(res, 409, { error: '已初始化' })

  const first = await deps.store.getUser(FIRST_USER_ID)
  if (!first) return json(res, 400, { error: '请先设置口令' })

  const skip = (body as { skip?: boolean })?.skip === true
  if (skip) {
    // 跳过 = 不绑：把向导生成的那个密钥丢掉，别让它悬在账号上
    await deps.store.upsertUser({ ...first, totp_secret: '' })
  } else {
    const code = (body as { code?: string })?.code ?? ''
    if (!(await verifyTotp(first.totp_secret, code))) return json(res, 401, { error: '验证码不正确' })
  }

  await deps.store.setSetting(S_INITIALIZED, '1')
  await deps.store.audit({
    actor: 'setup', action: 'setup.complete',
    detail: skip ? '未绑定两步验证' : null, ip, created_at: now(),
  })
  json(res, 200, { ok: true, totp: !skip })
}, false, true)


// ── 登录 ────────────────────────────────────────────────────

/** 登录失败计数。锁定状态可从审计日志重建，这里只是快路径。 */
const loginFails = new Map<string, { count: number; until: number }>()

/**
 * 同时最多几次口令运算。
 *
 * argon2id 每次要 19MiB 内存、约 100ms CPU，而登录与注册都是免鉴权可达的。
 * 不设闸的话，几十个并发请求就能把内存和事件循环一起吃干净——
 * 而这个进程同时还扛着设备的 WebSocket 心跳与事件入库，卡住就是漏报。
 *
 * 限速器只在连错 5 次之后才拦，前 5 次是白送的；换个 IP 又是 5 次。
 * 所以真正兜底的是这里：排队而不是拒绝，慢下来但不倒。
 */
const PASSWORD_CONCURRENCY = 4
let pwRunning = 0
const pwQueue: (() => void)[] = []

async function withPasswordSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (pwRunning >= PASSWORD_CONCURRENCY) {
    await new Promise<void>((resolve) => pwQueue.push(resolve))
  }
  pwRunning++
  try {
    return await fn()
  } finally {
    pwRunning--
    pwQueue.shift()?.()
  }
}

route('POST', '/api/auth/login', async ({ user, req, res, body, deps, ip }) => {
  const rec = loginFails.get(ip)
  if (rec && now() < rec.until) {
    return json(res, 429, { error: '尝试过于频繁，请稍后再试' })
  }

  const b = body as { password?: string; code?: string; name?: string }
  /**
   * 不填用户名时按第一个管理员算——**但只在单用户部署下**。
   *
   * 这个便利在多用户下会变成「不用知道任何用户名就能定向打管理员」，
   * 而管理员是唯一能建号、删号、续期的身份。多一个人之后就必须报上名来。
   */
  const all = await deps.store.listUsers()
  const acct = b.name?.trim()
    ? await deps.store.getUserByName(b.name.trim())
    : (all.length === 1 ? all[0] ?? null : null)

  // 先只验凭证，不看账号状态：状态要等凭证对了才能说，
  // 否则「账号已到期」这句话本身就成了一个不需要口令的账号存在性探测器
  const okPw = !!acct
    && (await withPasswordSlot(async () => verifyPassword(b.password ?? '', acct.password_hash)))
  /**
   * 两步验证是可选的，所以这里要分支——但**不能**用 try/catch 兜。
   *
   * verifyTotp('', code) 会抛 DataError（零长度密钥），而这个异常发生在
   * 失败计数与审计之前：handleApi 会把它兜成 500「服务器出错」，
   * 这次失败既不计数也不留痕，等于给爆破者一条免计数的通道。
   */
  const hasTotp = !!acct && acct.totp_secret !== ''
  const okTotp = okPw && (!hasTotp || (await verifyTotp(acct!.totp_secret, b.code ?? '')))

  /**
   * 凭证对了，再看账号能不能用。
   *
   * 到期的人看到「口令或验证码不正确」，第一反应是自己被盗号了——
   * 而正确的下一步是找管理员续期。凭证已经验过，说清楚不泄漏任何东西。
   */
  if (acct && okPw && okTotp) {
    const why = inactiveReason(acct, now())
    if (why) {
      loginFails.delete(ip)
      const contact = await deps.store.getSetting(S_ADMIN_CONTACT)
      await deps.store.audit({
        user_id: acct.id, actor: acct.name, action: 'auth.inactive',
        detail: why, ip, created_at: now(),
      })
      return json(res, 403, {
        error: why === 'expired'
          ? `账号已于 ${new Date(acct.expires_at!).toLocaleDateString('zh-CN')} 到期，服务已暂停。`
            + `你的数据还在，续期后自动恢复。`
            + `有新的邀请码可以在登录页自助续期；${contact ? `没有就联系：${contact}` : '没有就联系这台服务器的管理员。'}`
          : `账号已被停用。${contact ? `请联系：${contact}` : '请联系这台服务器的管理员。'}`,
        reason: why,
      })
    }
  }

  if (!acct || !okPw || !okTotp) {
    const c = (rec?.count ?? 0) + 1
    loginFails.set(ip, {
      count: c,
      until: c >= LOGIN_MAX_ATTEMPTS ? now() + LOGIN_LOCKOUT_MS : 0,
    })
    await deps.store.audit({
      user_id: acct?.id ?? null, actor: null, action: 'auth.fail',
      // 不写「用户不存在」：那等于告诉爆破者哪些用户名是真的
      detail: `第 ${c} 次，${okPw ? 'TOTP' : '口令'}不正确`, ip, created_at: now(),
    })
    log.warn('登录失败', { ip, attempt: c })
    if (c >= LOGIN_MAX_ATTEMPTS) void deps.onLoginLockout?.(ip, c)
    // 不区分口令错还是 TOTP 错，避免为逐项爆破提供反馈
    return json(res, 401, { error: '口令或验证码不正确' })
  }

  loginFails.delete(ip)

  // 异地登录告警（计划 §11.6「异常访问模式告警」）。
  // 按网段而非具体地址判断：移动网络出口 IP 会在同网段内漂移，
  // 按地址判断会天天误报，误报多了就没人看了。
  const prefix = ipPrefix(ip)
  const knownRaw = (await deps.store.getSetting(S_KNOWN_IPS)) ?? ''
  const known = knownRaw.split(',').filter(Boolean)
  if (known.length > 0 && !known.includes(prefix)) {
    log.warn('来自陌生网段的登录', { ip })
    void deps.onUnknownIpLogin?.(ip)
  }
  if (!known.includes(prefix)) {
    // 只保留最近 10 个，避免无限增长
    await deps.store.setSetting(S_KNOWN_IPS, [...known, prefix].slice(-10).join(','))
  }

  // 「保持登录」是用户自己做的取舍：会话从 30 分钟变 30 天，且不再绑定 IP 段。
  // 不给这个选项的话，摩擦会大到让人想把凭证塞进通知链接里——那才是真正危险的。
  /**
   * 「保持登录 30 天」：勾了就给，不看有没有绑两步验证。
   *
   * 这是用户自己做的取舍，而且他随时能在设置里退出当前设备、或者全端下线。
   * 代价要知道：信任会话**不校验 IP 段**（换 WiFi、换基站都不掉线），
   * 所以它是一个躺在浏览器里的长期令牌——公用设备上别勾。
   */
  const trusted = (body as { trust?: boolean })?.trust === true
  const ttl = trusted ? TRUSTED_SESSION_TTL_MS : SESSION_TTL_MS

  const token = generateSessionToken()
  const t = now()
  await deps.store.createSession({
    user_id: acct.id,
    token_hash: await hashToken(token),
    ua_hash: await hashToken(req.headers['user-agent'] ?? ''),
    ip_prefix: ipPrefix(ip),
    created_at: t,
    expires_at: t + ttl,
    revoked: false,
    trusted,
  })
  await deps.store.audit({
    user_id: acct.id, actor: acct.name, action: 'auth.login',
    detail: trusted ? '并信任这台设备 30 天' : null, ip, created_at: t,
  })
  json(res, 200, { token, expires_in: Math.floor(ttl / 1000), user: publicUser(acct) })
}, false)

route('POST', '/api/auth/logout', async ({ user, req, res, deps }) => {
  const h = req.headers.authorization
  if (h?.startsWith('Bearer ')) await deps.store.revokeSession(await hashToken(h.slice(7)))
  json(res, 200, { ok: true })
})

route('GET', '/api/auth/me', async ({ user, res }) => {
  json(res, 200, { ok: true, user: publicUser(user) })
})

/** 全端下线：怀疑凭证泄露时立刻断开所有会话，不必改口令（计划 §11.6）。 */
route('POST', '/api/auth/revoke-all', async ({ user, res, deps, ip }) => {
  await deps.store.revokeAllSessions(user.id)
  await deps.store.audit({ actor: 'admin', action: 'auth.revoke_all', detail: null, ip, created_at: now() })
  json(res, 200, { ok: true })
})

/** 改口令：成功后使全部会话失效，包括当前这个（计划 §11.6「全端下线」）。 */
route('POST', '/api/auth/password', async ({ user, res, body, deps, ip }) => {
  const b = body as { old?: string; new?: string }
  if (!verifyPassword(b.old ?? '', user.password_hash)) return json(res, 401, { error: '原口令不正确' })
  const check = validatePassword(b.new ?? '')
  if (!check.ok) return json(res, 400, { error: check.error })

  await deps.store.upsertUser({ ...user, password_hash: await hashPassword(b.new!) })
  await deps.store.revokeAllSessions(user.id)
  await deps.store.audit({ user_id: user.id, actor: user.name, action: 'auth.password_change', detail: null, ip, created_at: now() })
  json(res, 200, { ok: true })
})

/** IP 前缀：IPv4 取前三段，IPv6 取前四组。会话绑定到网段而非具体地址，
 *  因为移动网络的出口 IP 会在同网段内漂移，绑死会导致频繁掉线。 */
export function ipPrefix(ip: string): string {
  const v4 = ip.replace(/^::ffff:/, '')
  if (/^\d+\.\d+\.\d+\.\d+$/.test(v4)) return v4.split('.').slice(0, 3).join('.')
  return v4.split(':').slice(0, 4).join(':')
}

// ── 用户 ────────────────────────────────────────────────────

/**
 * 多用户的分界线画在哪。
 *
 * 一家人合用一台网关，一个人的卡收银行验证码、另一个人的卡收工作短信，
 * 互相能读对方的短信是荒谬的。所以没有「管理员查看全部」这种功能。
 *
 * 但要说实话：管理员能重置任何人的口令，从而以那个人的身份登录。
 * 所以隔离的准确表述是**「管理员不会顺手看到，但一步就能主动拿到」**，
 * 而且这是软件层面的隔离，不是密码学层面的——持有服务器与密钥的人
 * 技术上能读到库里的一切。面向用户的文案必须按这个写。
 *
 * 能做的是让这一步留下痕迹：重置写审计，并通知被重置的本人。
 */
route('GET', '/api/users', async ({ user, res, deps }) => {
  if (user.role !== 'admin') return json(res, 403, { error: '只有管理员能管理用户' })
  const users = await deps.store.listUsers()
  // 顺带给出每个人有多少台设备，删号前好知道自己在删什么
  const devices = await deps.store.listAllDevices()
  json(res, 200, {
    users: users.map((u) => ({
      ...publicUser(u),
      devices: devices.filter((d) => d.user_id === u.id && d.status !== 'revoked').length,
      is_me: u.id === user.id,
    })),
  })
})

/**
 * 建号。
 *
 * 口令与 TOTP 密钥都由服务端生成并**只显示这一次**：让管理员替别人想一个口令，
 * 想出来的多半是「123456」，而这个账号能看到对方所有的银行验证码。
 * 对方登录后自己改口令即可。
 */
route('POST', '/api/users', async ({ user, res, body, deps, ip }) => {
  if (user.role !== 'admin') return json(res, 403, { error: '只有管理员能管理用户' })

  const b = body as { name?: string; role?: string; days?: number }
  const name = (b?.name ?? '').trim()
  const check = validateUserName(name)
  if (!check.ok) return json(res, 400, { error: check.error })
  if (await deps.store.getUserByName(name)) return json(res, 409, { error: '这个用户名已经有人用了' })

  const password = generatePassword()
  const secret = generateTotpSecret()
  const id = newId('usr')
  await deps.store.upsertUser({
    id, name,
    password_hash: await hashPassword(password),
    totp_secret: secret,
    role: b?.role === 'admin' ? 'admin' : 'member',
    bot_token: generateSessionToken(),
    disabled: false, expires_at: expiresAtFrom(b?.days),
    // 管理员代建的账号，同意书由本人首次登录时补签
    agreed_version: null, agreed_at: null, created_at: now(),
  })
  await seedRetention(deps.store, id)
  await deps.store.audit({ user_id: user.id, actor: user.name, action: 'user.create', detail: name, ip, created_at: now() })

  const uri = totpUri(secret, name)
  // 口令与二维码只在这里出现一次，此后服务端只留哈希
  json(res, 200, { id, name, password, secret, uri, qr: toSvg(uri, { label: '两步验证绑定二维码' }) })
})

/** 停用 / 启用。停用后手里的会话立刻失效，但数据还在，可以随时恢复。 */
route('PUT', '/api/users/:id', async ({ user, res, params, body, deps, ip }) => {
  if (user.role !== 'admin') return json(res, 403, { error: '只有管理员能管理用户' })
  const target = await deps.store.getUser(params.id!)
  if (!target) return json(res, 404, { error: '用户不存在' })
  if (target.id === user.id) return json(res, 400, { error: '不能停用自己' })

  const disabled = (body as { disabled?: boolean })?.disabled === true
  await deps.store.upsertUser({ ...target, disabled })
  if (disabled) await deps.store.revokeAllSessions(target.id)
  await deps.store.audit({
    user_id: user.id, actor: user.name, action: disabled ? 'user.disable' : 'user.enable',
    detail: target.name, ip, created_at: now(),
  })
  json(res, 200, { ok: true })
})

/**
 * 删号。**连同这个人的全部数据一起删**。
 *
 * 不留数据：留着的话，下一个同名用户会继承上一个人的短信，
 * 而「账号删了消息还在库里」本身就违背了多用户的初衷。
 * 所以要求显式确认，且不能删自己——把自己删了就没人能建号了。
 */
route('DELETE', '/api/users/:id', async ({ user, res, params, url, deps, ip }) => {
  if (user.role !== 'admin') return json(res, 403, { error: '只有管理员能管理用户' })
  const target = await deps.store.getUser(params.id!)
  if (!target) return json(res, 404, { error: '用户不存在' })
  if (target.id === user.id) return json(res, 400, { error: '不能删除自己' })
  if (url.searchParams.get('confirm') !== '1') {
    return json(res, 400, { error: '删除用户会连同他的设备、消息、规则一起删掉，需要显式确认' })
  }

  const n = await deps.store.deleteUser(target.id)
  await deps.store.audit({
    user_id: user.id, actor: user.name, action: 'user.delete',
    detail: `${target.name}：${Object.entries(n).map(([k, v]) => `${k} ${v}`).join('、')}`,
    ip, created_at: now(),
  })
  log.warn('用户已删除', { name: target.name, removed: n })
  json(res, 200, { ok: true, removed: n })
})

/**
 * 续期 / 改有效期。
 *
 * 没有这条路的话，账号一到期就只能删号重建——而删号会连着他的全部短信一起删。
 * 到期是个可逆状态，必须有对应的可逆操作。
 */
route('POST', '/api/users/:id/renew', async ({ user, res, params, body, deps, ip }) => {
  if (user.role !== 'admin') return json(res, 403, { error: '只有管理员能管理用户' })
  const target = await deps.store.getUser(params.id!)
  if (!target) return json(res, 404, { error: '用户不存在' })

  const b = body as { days?: number; permanent?: boolean }
  const expires = b?.permanent === true ? null : expiresAtFrom(b?.days, { from: target.expires_at })
  await deps.store.upsertUser({ ...target, expires_at: expires })
  await deps.store.audit({
    user_id: user.id, actor: user.name, action: 'user.renew',
    detail: `${target.name} → ${expires === null ? '永久' : new Date(expires).toISOString().slice(0, 10)}`,
    ip, created_at: now(),
  })
  json(res, 200, { ok: true, expires_at: expires })
})

/** 重置某人的口令与 TOTP。对方把手机丢了、或者忘了口令时用。 */
route('POST', '/api/users/:id/reset', async ({ user, res, params, deps, ip }) => {
  if (user.role !== 'admin') return json(res, 403, { error: '只有管理员能管理用户' })
  const target = await deps.store.getUser(params.id!)
  if (!target) return json(res, 404, { error: '用户不存在' })

  const password = generatePassword()
  /**
   * 只在对方**本来就有**两步验证时才换一个新密钥。
   *
   * 本来没开的人凭空被塞一个 TOTP，等于把他锁在门外——他手上没有认证器。
   * 而本来有的人必须换：他丢手机才来找你重置，旧密钥已经不可信。
   */
  const secret = target.totp_secret ? generateTotpSecret() : ''
  await deps.store.upsertUser({
    ...target,
    password_hash: await withPasswordSlot(() => hashPassword(password)),
    totp_secret: secret,
  })
  await deps.store.revokeAllSessions(target.id)
  await deps.store.audit({ user_id: user.id, actor: user.name, action: 'user.reset', detail: target.name, ip, created_at: now() })
  /**
   * 通知本人。
   *
   * 重置口令等于管理员能以他的身份登录、看他全部的短信。
   * 「会写审计」不是给他的保证——他看不到审计日志；推送才是他真能收到的。
   */
  void deps.onPasswordReset?.(target.id, user.name)

  const uri = secret ? totpUri(secret, target.name) : null
  json(res, 200, { name: target.name, password, secret, uri, qr: uri ? toSvg(uri, { label: '两步验证绑定二维码' }) : null })
})

// ── 两步验证：自助绑定、解绑、找回 ──────────────────────────

/**
 * 两步验证现在是**可选**的。
 *
 * 这一条推翻了 CLAUDE.md 里原来的红线「TOTP 强制，不提供关闭选项」。
 * 那条红线不是「多一层总是好的」——控制台公网可达，门后是全部短信明文
 * 含银行验证码，拿到验证码就能过别人的银行二次验证。放宽是有代价的。
 *
 * 放宽是**知情的选择**，不是默认关掉：注册与向导都引导绑定，跳过要点一下，
 * 并且看得到后果。管理员也可以不绑——这台机器是他的，风险自负。
 *
 * 绑不绑两步验证，差别只在登录时多不多一道动态码。其余一视同仁：
 * 口令规则一样（8 位两类）、一样能勾「保持登录 30 天」、一样能自助找回口令
 * （找回默认走推送渠道，绑了的也可以用动态码，两条都行）。
 *
 * 这是运营者的判断：这台机器上的信息没有重要到值得为「没有第二因素」
 * 再加几层摩擦，而每个跳过的地方都会把后果讲清楚。
 */

/**
 * 待验证的 TOTP 密钥，存在这个用户自己的配置里。
 *
 * 不直接写进 totp_secret：写了再验的话，用户扫码失败就把自己锁在门外了——
 * 账号立刻进入「必须交验证码」状态，而他手上还没有可用的认证器。
 *
 * 也不放进程内 Map：硬约束④不允许进程内状态，而且那样一重启就得重扫。
 */
const S_TOTP_PENDING = 'totp_pending'
const TOTP_SETUP_TTL_MS = 10 * 60 * 1000

/** 绑定前先拿密钥与二维码。此刻还没写进账号，验证通过才算数 */
route('POST', '/api/auth/totp/setup', async ({ user, res, deps }) => {
  const secret = generateTotpSecret()
  await deps.store.setUserSetting(user.id, S_TOTP_PENDING,
    JSON.stringify({ secret, until: now() + TOTP_SETUP_TTL_MS }))
  const uri = totpUri(secret, user.name)
  json(res, 200, { secret, uri, qr: toSvg(uri, { label: '两步验证绑定二维码' }) })
})

route('POST', '/api/auth/totp/enable', async ({ user, res, body, deps, ip }) => {
  type PendingTotp = { secret: string; until: number }
  const raw = await deps.store.getUserSetting(user.id, S_TOTP_PENDING)
  let p: PendingTotp | null = null
  if (raw) {
    try {
      p = JSON.parse(raw) as PendingTotp
    } catch { /* 存坏了当没有 */ }
  }
  if (!p?.secret || p.until < now()) return json(res, 400, { error: '绑定已超时，请重新开始' })
  const code = (body as { code?: string })?.code ?? ''
  if (!(await verifyTotp(p.secret, code))) return json(res, 401, { error: '验证码不正确' })

  await deps.store.setUserSetting(user.id, S_TOTP_PENDING, '')
  await deps.store.upsertUser({ ...user, totp_secret: p.secret })
  await deps.store.audit({ user_id: user.id, actor: user.name, action: 'totp.enable', detail: null, ip, created_at: now() })
  json(res, 200, { ok: true })
})

/** 解绑。要同时验口令与当前动态码——这一步的后果是失去自助找回的能力 */
route('POST', '/api/auth/totp/disable', async ({ user, res, body, deps, ip }) => {
  if (!user.totp_secret) return json(res, 400, { error: '本来就没开' })

  const b = body as { password?: string; code?: string }
  /**
   * 关掉之后口令就是这个账号唯一的钥匙，所以它必须先够强。
   *
   * 不检查的话会出现一条很难看的路径：用 8 位口令注册 → 绑两步验证 →
   * 再把两步验证关掉，于是绕开了「没两步验证要 12 位」这条规则，
   * 而且绕得毫无察觉。
   */
  const strong = validatePassword(b?.password ?? '')
  if (!strong.ok) return json(res, 400, { error: strong.error })
  const okPw = await withPasswordSlot(async () => verifyPassword(b?.password ?? '', user.password_hash))
  if (!okPw || !(await verifyTotp(user.totp_secret, b?.code ?? ''))) {
    return json(res, 401, { error: '口令或验证码不正确' })
  }
  await deps.store.upsertUser({ ...user, totp_secret: '' })
  await deps.store.audit({ user_id: user.id, actor: user.name, action: 'totp.disable', detail: null, ip, created_at: now() })
  json(res, 200, { ok: true })
})

/**
 * 自助找回口令：用动态码换新口令，不需要旧口令。
 *
 * 这确实把 TOTP 从「第二因素」变成了「能单独接管账号的凭据」——
 * 看过一次你认证器屏幕的人就能改你的口令。所以配了三道补偿：
 *  1. 限速与登录同一套，且口令运算走并发闸
 *  2. 成功后**全端下线**，旧会话立刻作废
 *  3. 给这个账号自己的渠道发一条告警——这是没有第二因素时唯一的事后检测手段
 *
 * 不做这个功能的替代方案是「只能找管理员重置」，而管理员重置意味着
 * 他拿到你的新口令、能进你的账号。两害相权，这条更可控，且它是用户
 * 自己按「我要能自己找回」做出的选择。
 */
/**
 * 找回口令有两条明确的路，由用户自己选，**不做「填进来我猜是哪种」**：
 *
 *  1. 推送渠道 → 往他自己配好的渠道发一个一次性找回码
 *  2. 两步验证器 → 直接填认证器上的动态码
 *
 * 为什么要让他选而不是一个框通吃：这两条路失败时的**下一步动作完全不同**。
 * 渠道那条收不到就重发一次、或者去查渠道配错没有；验证器那条填错多半是
 * 手机时间不准，或者在认证器里找错了条目。合成一个框就只能给一句
 * 模棱两可的「验证码不正确」，而这恰恰是人最需要指引的时刻。
 *
 * 渠道为什么算得上一个验证因素：它**本来就在接收他的银行验证码**。
 * 能打开那个 Telegram 或那台装着 Bark 的手机的人，早就看得到他全部的短信了——
 * 往那里发一个找回码没有新增任何暴露面，而它同时是一个真实的
 * 「你持有某个东西」的证明，因为渠道是他自己配的、还按过测试按钮。
 *
 * 两条路都**不告诉界面这个账号有没有绑验证器**：那会连带确认账号存在。
 * 界面一律把两个选项都摆出来，选错了就在这一步告诉他。
 */
const RECOVERY_TTL_MS = 10 * 60 * 1000
const RECOVERY_MAX_TRIES = 5
const S_RECOVERY = 'recovery_pending'

/** 找回码：8 位无歧义字符，约 10^12 种。要靠人从通知里抄过来，所以不用更长 */
const generateRecoveryCode = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(8)))
    .map((b) => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32])
    .join('')

/**
 * 第一步：往本人自己的渠道发一个找回码。
 *
 * **无论账号存不存在、有没有渠道，回的都是同一句话**——否则这个免鉴权接口
 * 就成了「哪些用户名是真的」「谁配了渠道」的查询器。
 */
route('POST', '/api/auth/recover/start', async ({ res, body, deps, ip }) => {
  if (regLimited(ip)) return json(res, 429, { error: '尝试过于频繁，请稍后再试' })

  const uniform = {
    ok: true,
    message: '如果这个账号存在并且配好了推送渠道，找回码已经发过去了（10 分钟内有效）。'
      + '开了两步验证的话，也可以直接填认证器上的 6 位动态码。'
      + '两样都没有的只能请管理员重置。',
  }

  const acct = await deps.store.getUserByName(String((body as { name?: string })?.name ?? '').trim())
  if (!acct || !userActive(acct, now())) return json(res, 200, uniform)

  const code = generateRecoveryCode()
  await deps.store.setUserSetting(acct.id, S_RECOVERY, JSON.stringify({
    hash: await hashToken(code),
    expires_at: now() + RECOVERY_TTL_MS,
    tries: 0,
  }))
  // 发不出去（没配渠道、渠道坏了）也回同一句话：成没成由渠道那边告诉他
  void deps.sendRecoveryCode?.(acct.id, code)
  await deps.store.audit({ user_id: acct.id, actor: acct.name, action: 'auth.recover_start', detail: null, ip, created_at: now() })
  json(res, 200, uniform)
}, false)

/**
 * 第二步：用验证码换新口令。
 *
 * **同一个框认两种码**：渠道发来的一次性找回码，或者认证器上的 6 位动态码。
 * 用户不需要知道自己填的是哪一种，界面上也就不用解释两条路。
 */
route('POST', '/api/auth/recover/finish', async ({ res, body, deps, ip }) => {
  if (regLimited(ip)) return json(res, 429, { error: '尝试过于频繁，请稍后再试' })

  const b = body as { name?: string; code?: string; password?: string; method?: string }
  const pwCheck = validatePassword(b?.password ?? '')
  if (!pwCheck.ok) return json(res, 400, { error: pwCheck.error })

  const fail = { error: '验证码不正确或已失效' }
  const acct = await deps.store.getUserByName((b?.name ?? '').trim())
  if (!acct || !userActive(acct, now())) return json(res, 401, fail)

  const input = (b?.code ?? '').trim()
  const method = b?.method === 'totp' ? 'totp' : 'channel'
  if (!input) return json(res, 401, fail)

  let ok = false
  if (method === 'totp') {
    // 认证器这条无状态，错了也不消耗渠道码的次数
    ok = acct.totp_secret !== '' && (await verifyTotp(acct.totp_secret, input))
    if (!ok) {
      return json(res, 401, {
        error: '动态码不正确。请确认认证器里选的是这个账号那一条，'
          + '并检查手机时间是否准确——动态码对时间很敏感，差一分钟就会一直失败。',
        method: 'totp',
      })
    }
  } else {
    const raw = await deps.store.getUserSetting(acct.id, S_RECOVERY)
    type Pending = { hash: string; expires_at: number; tries: number }
    let pending: Pending | null = null
    if (raw) {
      try {
        pending = JSON.parse(raw) as Pending
      } catch { /* 存坏了就当没有 */ }
    }
    if (!pending || pending.expires_at < now() || pending.tries >= RECOVERY_MAX_TRIES) {
      if (pending) await deps.store.setUserSetting(acct.id, S_RECOVERY, '')
      return json(res, 401, { error: '找回码已失效，请重新发送一个', method: 'channel', resend: true })
    }
    if (!timingSafeEqual(await hashToken(input.toUpperCase()), pending.hash)) {
      // 记次数：不记的话 10 分钟内可以无限猜
      const tries = pending.tries + 1
      await deps.store.setUserSetting(acct.id, S_RECOVERY, JSON.stringify({ ...pending, tries }))
      return json(res, 401, {
        error: `找回码不正确，还可以试 ${Math.max(0, RECOVERY_MAX_TRIES - tries)} 次`,
        method: 'channel',
      })
    }
    ok = true
  }
  if (!ok) return json(res, 401, fail)

  await deps.store.setUserSetting(acct.id, S_RECOVERY, '')
  await deps.store.upsertUser({
    ...acct,
    password_hash: await withPasswordSlot(() => hashPassword(b!.password!)),
  })
  await deps.store.revokeAllSessions(acct.id)
  await deps.store.audit({ user_id: acct.id, actor: acct.name, action: 'auth.recover', detail: null, ip, created_at: now() })
  log.warn('口令已通过找回码重置', { name: acct.name, ip })
  void deps.onPasswordRecovered?.(acct.id, ip)
  json(res, 200, { ok: true })
}, false)

// ── 邀请与自助注册 ──────────────────────────────────────────

/** 注册开关。off=只有管理员能建号；invite=凭邀请码自助注册。没有「完全开放」这一档 */
const S_REGISTRATION = 'registration_mode'
/**
 * 管理员的联系方式（自由文本，如 Telegram @xxx 或邮箱）。
 *
 * 界面上到处写着「请联系管理员续期」「找邀请你的人重置」，
 * 而系统里原本没有任何地方存得下这个人是谁——凭一个链接进来的陌生人，
 * 到期那一刻手上只有一个打不开的控制台。
 */
const S_ADMIN_CONTACT = 'admin_contact'
/** 这个账号有没有成功测试过任意一个渠道。上手清单的第二步靠它判断 */
const S_CHANNEL_TESTED = 'channel_tested_at'

/**
 * 为什么没有「完全开放」。
 *
 * 这台服务器持有所有注册者短信正文的解密能力，且无法通过技术手段放弃——
 * 服务端必须解密才能跑规则和转发。也就是说，来注册的每一个陌生人的
 * 银行验证码、快递地址、实名信息，都落在运营者名下的机器上。
 *
 * 邀请制本身就是最有效的一道风控，因为你知道码发给了谁。
 * 完全开放在这个架构下不该做，所以干脆不提供这个选项。
 */
export async function registrationMode(store: Store): Promise<'off' | 'invite'> {
  return (await store.getSetting(S_REGISTRATION)) === 'invite' ? 'invite' : 'off'
}


/**
 * 给**新建**的账号写上默认保留上限。
 *
 * 只在建号时写，而且只在这三条路径上写：向导建第一个管理员、自助注册、
 * 管理员代建。**绝不能在 `migrateSingleUser()` 里写**——那条路上的账号是
 * 从单用户老库升级来的，它名下挂着几年的历史，写一个 999 上去就是一次
 * 静默的批量删除，而且是在他完全不知情的情况下。
 *
 * 同理，「设置里读不到」永远意味着不限制（见 core/retention.ts 的 parseRetention），
 * 而不是「取默认值」。默认值只在这里出现一次。
 */
async function seedRetention(store: Store, userId: string): Promise<void> {
  await store.setUserSetting(userId, RETENTION_SETTING, serializeRetention(newAccountRetention()))
    .catch(() => { /* 写不上就是不限制，属于安全方向，不必让建号失败 */ })
}

/** 管理员的联系方式。免鉴权那份在 /api/register/status 里，这里是给管理员改的 */
route('GET', '/api/admin-contact', async ({ user, res, deps }) => {
  if (user.role !== 'admin') return json(res, 403, { error: '只有管理员能改' })
  json(res, 200, { contact: (await deps.store.getSetting(S_ADMIN_CONTACT)) ?? '' })
})

route('POST', '/api/admin-contact', async ({ user, res, body, deps, ip }) => {
  if (user.role !== 'admin') return json(res, 403, { error: '只有管理员能改' })
  const v = String((body as { contact?: string })?.contact ?? '').trim().slice(0, 120)
  await deps.store.setSetting(S_ADMIN_CONTACT, v)
  await deps.store.audit({ user_id: user.id, actor: user.name, action: 'admin_contact.set', detail: null, ip, created_at: now() })
  json(res, 200, { contact: v })
})

route('GET', '/api/registration', async ({ user, res, deps }) => {
  if (user.role !== 'admin') return json(res, 403, { error: '只有管理员能改注册设置' })
  json(res, 200, {
    mode: await registrationMode(deps.store),
    validity_days: VALIDITY_DAYS,
    invite_ttl_hours: INVITE_TTL_HOURS,
  })
})

route('POST', '/api/registration', async ({ user, res, body, deps, ip }) => {
  if (user.role !== 'admin') return json(res, 403, { error: '只有管理员能改注册设置' })
  const mode = (body as { mode?: string })?.mode === 'invite' ? 'invite' : 'off'
  await deps.store.setSetting(S_REGISTRATION, mode)
  await deps.store.audit({
    user_id: user.id, actor: user.name, action: 'registration.mode',
    detail: mode, ip, created_at: now(),
  })
  json(res, 200, { mode })
})

/** 邀请码的字母表与配对码一致：去掉 O/0/I/1，人要抄写它 */
const INVITE_LEN = 10
const generateInviteCode = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(INVITE_LEN)))
    .map((b) => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32])
    .join('')

/**
 * 邀请码自己能放多久（小时）。没人用的码不该永远躺在那儿。
 *
 * 和账号有效期一样是有限集合，给下拉不给文本框（CLAUDE.md：
 * 控制台里不要让人手写枚举值）。
 */
const INVITE_TTL_HOURS = [1, 24, 72, 168, 720] as const
const DEFAULT_INVITE_TTL_HOURS = 168

route('GET', '/api/invites', async ({ user, res, deps }) => {
  if (user.role !== 'admin') return json(res, 403, { error: '只有管理员能管理邀请码' })
  const users = new Map((await deps.store.listUsers()).map((u) => [u.id, u.name]))
  const t = now()
  const rows = await deps.store.listInvites()
  const codes = await Promise.all(rows.map((i) => inviteCode(deps, i)))
  json(res, 200, {
    invites: rows.map((i, n) => ({
      code_hash: i.code_hash,
      // 码能再拿回来：只存哈希会让「没当场注册、也没存下来」的码变成垃圾
      code: codes[n] ?? null,
      url: registerUrl(deps, codes[n] ?? null),
      note: i.note,
      valid_days: i.valid_days,
      expires_at: i.expires_at,
      used_at: i.used_at,
      used_by: i.used_by ? users.get(i.used_by) ?? i.used_by : null,
      expired: i.used_at === null && i.expires_at <= t,
      created_at: i.created_at,
      public: i.public,
      self_made: i.self_made,
    })),
  })
})

route('POST', '/api/invites', async ({ user, res, body, deps, ip }) => {
  if (user.role !== 'admin') return json(res, 403, { error: '只有管理员能管理邀请码' })
  const b = body as { note?: string; days?: number; ttl_hours?: number; public?: boolean }
  const code = generateInviteCode()
  const t = now()
  const ttlHours = (INVITE_TTL_HOURS as readonly number[]).includes(Number(b?.ttl_hours))
    ? Number(b.ttl_hours)
    : DEFAULT_INVITE_TTL_HOURS
  const expiresAt = t + ttlHours * 3_600_000
  const isPublic = b?.public === true
  await deps.store.createInvite({
    code_hash: await hashToken(code),
    created_by: user.id,
    note: (b?.note ?? '').trim().slice(0, 64) || null,
    valid_days: (VALIDITY_DAYS as readonly number[]).includes(Number(b?.days)) ? Number(b.days) : null,
    expires_at: expiresAt,
    used_at: null, used_by: null, created_at: t,
    public: isPublic,
    // 明文那一列只留给升级前发出的公开码，新建的一律走密文
    code_plain: null,
    // 加密存一份，好让它之后还能再显示。见 core/store.ts 上 code_enc 的说明
    code_enc: await deps.cipher.encrypt(code),
    self_made: false,
  })
  await deps.store.audit({
    user_id: user.id, actor: user.name, action: 'invite.create',
    // 码本身不进审计：审计日志会被看、会被导出，而这个码等于一个账号。
    // 公开与否要记：它决定了这个码会不会被贴到公网页面上
    detail: [isPublic ? '公开' : null, b?.note ? `备注 ${b.note}` : null].filter(Boolean).join(' · ') || null,
    ip, created_at: t,
  })

  /**
   * 注册链接把码放在 **fragment** 里而不是查询串。
   *
   * fragment 不会发给服务器，因此不会进反代日志、不会进访问日志、
   * 也不会出现在 Referer 里。而这个码等于一个能看银行验证码的账号。
   */
  const url = registerUrl(deps, code)
  json(res, 200, { code, url, expires_at: expiresAt })
})

/**
 * 把一个邀请码还原成明文。
 *
 * 三种来源按顺序试：新建的走密文；升级前发出的公开码还留着明文那一列；
 * 再老的（两者都没有）只存过哈希，永远拿不回来——如实返回 null，
 * 界面上会写「这个码是加密落库之前发的，显示不出来」，而不是装作没有这条。
 */
async function inviteCode(deps: ApiDeps, i: InviteRecord): Promise<string | null> {
  if (i.code_enc) {
    try { return await deps.cipher.decrypt(i.code_enc) } catch { return null }
  }
  return i.code_plain
}

/** 注册链接。码放在 fragment 里——它不发给服务器，不进反代日志、不进 Referer */
function registerUrl(deps: ApiDeps, code: string | null): string | null {
  if (!code || !deps.baseUrl) return null
  return `${deps.baseUrl.replace(/\/$/, '')}/register#${code}`
}

route('DELETE', '/api/invites/:hash', async ({ user, res, params, deps, ip }) => {
  if (user.role !== 'admin') return json(res, 403, { error: '只有管理员能管理邀请码' })
  const ok = await deps.store.deleteInvite(params.hash!)
  if (!ok) return json(res, 404, { error: '邀请码不存在或已被使用' })
  await deps.store.audit({ user_id: user.id, actor: user.name, action: 'invite.revoke', detail: null, ip, created_at: now() })
  json(res, 200, { ok: true })
})

/**
 * 「通知」页的数据。**未认证可达**——这是整套系统里唯一一个这样的业务接口。
 *
 * 它给出去的东西要一条条数清楚：公告的标题正文时间、公开邀请码的明文与状态。
 * 除此之外一个字都不给——谁生成的、备注写了什么、被谁用掉的，都留在管理员
 * 那一侧。这些字段在 InviteRecord 上就摆着，漏一个 `...i` 就全出去了，
 * 所以这里是**逐字段挑出来**的，不是挑掉不要的。
 */
route('GET', '/api/notice', async ({ res, deps }) => {
  const t = now()
  const [ann, invites] = await Promise.all([
    deps.store.listAnnouncements(ANNOUNCE_LIMIT),
    deps.store.listPublicInvites(PUBLIC_INVITE_LIMIT),
  ])
  json(res, 200, {
    announcements: ann.map((a) => ({
      id: a.id, title: a.title, body: a.body, pinned: a.pinned, updated_at: a.updated_at,
    })),
    invites: invites.map((i) => ({
      code: i.code_plain,
      expires_at: i.expires_at,
      state: inviteState(i, t),
    })),
    /** 注册关着的时候，页面要说清楚「码在这儿但现在注册不开」 */
    open: (await registrationMode(deps.store)) === 'invite',
  })
}, false)

// ── 公告（管理员增删改） ────────────────────────────────

route('GET', '/api/announcements', async ({ user, res, deps }) => {
  if (user.role !== 'admin') return json(res, 403, { error: '只有管理员能管理公告' })
  json(res, 200, { announcements: await deps.store.listAnnouncements(ANNOUNCE_LIMIT) })
})

route('POST', '/api/announcements', async ({ user, res, body, deps, ip }) => {
  if (user.role !== 'admin') return json(res, 403, { error: '只有管理员能管理公告' })
  const b = body as { id?: string; title?: string; body?: string; pinned?: boolean }
  const norm = normalizeAnnouncement(b ?? {})
  if ('error' in norm) return json(res, 400, { error: norm.error })

  const t = now()
  // 带 id 就是改，不带就是新建。改的时候保留原来的 created_at——
  // 「发布于」这一行是给读的人看的，编一次错别字不该让它跳到今天
  const old = b?.id ? await deps.store.getAnnouncement(b.id) : null
  if (b?.id && !old) return json(res, 404, { error: '公告不存在' })
  const rec = {
    id: old?.id ?? newId('ann'),
    title: norm.title,
    body: norm.body,
    pinned: b?.pinned === true,
    created_at: old?.created_at ?? t,
    updated_at: t,
  }
  await deps.store.upsertAnnouncement(rec)
  await deps.store.audit({
    user_id: user.id, actor: user.name, action: old ? 'announce.update' : 'announce.create',
    detail: norm.title, ip, created_at: t,
  })
  json(res, 200, { announcement: rec })
})

route('DELETE', '/api/announcements/:id', async ({ user, res, params, deps, ip }) => {
  if (user.role !== 'admin') return json(res, 403, { error: '只有管理员能管理公告' })
  if (!(await deps.store.deleteAnnouncement(params.id!))) {
    return json(res, 404, { error: '公告不存在' })
  }
  await deps.store.audit({
    user_id: user.id, actor: user.name, action: 'announce.delete',
    detail: params.id!, ip, created_at: now(),
  })
  json(res, 200, { ok: true })
})

// ── 用户自助生成公开邀请码 ──────────────────────────────

/**
 * 能不能生成，以及为什么不能。
 *
 * 两道门都要**把原因说出来**：只回一个 403 的话，「今天还没有消息进来」
 * 和「今天已经生成过了」在界面上长得一模一样，而这两件事的下一步完全不同
 * （一个是等一条短信，一个是明天再来）。
 */
async function selfInviteGate(
  deps: ApiDeps, user: UserRecord, t: number,
): Promise<{ ok: true; since: number } | { ok: false; why: string }> {
  if ((await registrationMode(deps.store)) !== 'invite') {
    return { ok: false, why: '这台网关现在不开放自助注册' }
  }
  const since = dayStart(t, offsetMs(t, await timezone(deps.store, user.id)))
  if ((await deps.store.countEventsReceivedSince(user.id, since)) === 0) {
    return { ok: false, why: '今天还没有消息进来。这道门槛确认的是「这台网关真的在用」，收到一条短信、来电或应用通知之后再来' }
  }
  if ((await deps.store.countSelfInvitesBy(user.id, since)) >= SELF_INVITE_PER_DAY) {
    return { ok: false, why: `每天一个，明天再来（已生成 ${SELF_INVITE_PER_DAY} 个）` }
  }
  return { ok: true, since }
}

route('GET', '/api/invites/self', async ({ user, res, deps }) => {
  const t = now()
  const gate = await selfInviteGate(deps, user, t)
  /**
   * 顺带把**他自己发过的码**带回去。
   *
   * 「每天一个」加上「只显示一次」的组合最伤人：今天生成了、随手关掉了，
   * 明天之前既拿不回来也再生成不了。列出来之后这个格子就一直找得到。
   * 只列自己的（created_by = 自己），管理员发的码不在这里。
   */
  const mine = (await deps.store.listInvites()).filter((i) => i.created_by === user.id && i.self_made)
  const codes = await Promise.all(mine.map((i) => inviteCode(deps, i)))
  json(res, 200, {
    can: gate.ok,
    why: gate.ok ? null : gate.why,
    ttl_hours: SELF_INVITE_TTL_MS / 3_600_000,
    per_day: SELF_INVITE_PER_DAY,
    mine: mine.slice(0, 10).map((i, n) => ({
      code: codes[n] ?? null,
      url: registerUrl(deps, codes[n] ?? null),
      expires_at: i.expires_at,
      state: inviteState(i, t),
    })),
  })
})

route('POST', '/api/invites/self', async ({ user, res, deps, ip }) => {
  const t = now()
  const gate = await selfInviteGate(deps, user, t)
  if (!gate.ok) return json(res, 403, { error: gate.why })

  const code = generateInviteCode()
  const expiresAt = t + SELF_INVITE_TTL_MS
  await deps.store.createInvite({
    code_hash: await hashToken(code),
    created_by: user.id,
    note: `${user.name} 自助生成`,
    // 自助码开出来的账号跟着管理员设的默认走。这里不给选：
    // 普通用户不该有能力决定别人的账号能用多久
    valid_days: null,
    expires_at: expiresAt,
    used_at: null, used_by: null, created_at: t,
    /**
     * **自助码是私有的**：只存哈希、只在生成那一次给出明文，不上「通知」页。
     *
     * 「公开」是运营者的一个决定——把一个注册名额挂到谁都能打开的页面上，
     * 由他承担后果。用户点一下按钮拿到的码，是给他想邀请的那个人的，
     * 不该替他公开。两件事只是碰巧都产出一个邀请码而已。
     */
    public: false, code_plain: null, self_made: true,
    code_enc: await deps.cipher.encrypt(code),
  })
  await deps.store.audit({
    user_id: user.id, actor: user.name, action: 'invite.self',
    detail: '自助生成邀请码（24 小时）', ip, created_at: t,
  })
  const url = registerUrl(deps, code)
  json(res, 200, { code, url, expires_at: expiresAt })
})

/** 注册限速。与配对码那套分开——配对失败不该把注册一起锁死，反之亦然 */
const regAttempts = new Map<string, { n: number; until: number }>()
/**
 * 20 次而不是几次：这个闸拦的是自动化滥用，不该把打错几次字的人挡在外面。
 * 真正扛住 argon2 资源消耗的是 withPasswordSlot 的并发闸，不是这里的次数。
 * 注册、自助续期、找回共用同一个计数——它们都是「免鉴权 + 要跑口令运算」。
 */
const REG_MAX = 20
const REG_WINDOW_MS = 15 * 60 * 1000

function regLimited(ip: string): boolean {
  const r = regAttempts.get(ip)
  const t = now()
  if (r && t < r.until) {
    if (r.n >= REG_MAX) return true
    r.n++
    return false
  }
  regAttempts.set(ip, { n: 1, until: t + REG_WINDOW_MS })
  return false
}

/**
 * 注册页要先知道这台机器开不开放注册。
 *
 * 免鉴权可达，但只回一个布尔值——不回用户数、不回版本、不回实例名。
 */
route('GET', '/api/register/status', async ({ res, deps }) => {
  json(res, 200, {
    open: (await registrationMode(deps.store)) === 'invite',
    privacy_version: PRIVACY_VERSION,
    // 注册页、到期提示、找回失败都要写「联系管理员」，得有个地方说清是谁
    admin_contact: (await deps.store.getSetting(S_ADMIN_CONTACT)) ?? '',
  })
}, false)

/**
 * 自助注册。
 *
 * 免鉴权可达，所以每一处细节都要按「对面是攻击者」来写：
 *
 * - **先消费邀请码，再看用户名**。反过来的话，带一个乱填的码提交，
 *   「用户名被占」与「邀请码无效」两种回答就把注册接口变成了一个
 *   不需要邀请码的用户名枚举器。
 * - 失败一律同一句话、同一个状态码，不区分「码不存在 / 已用 / 过期 / 名字被占」。
 *   这和 redeemPairing 的做法一致。
 * - 限速发生在口令运算之前，且口令运算本身有并发闸（withPasswordSlot）。
 * - 必须显式同意隐私声明，且记下同意的是哪一版。
 */
route('POST', '/api/register', async ({ res, body, deps, ip }) => {
  if (regLimited(ip)) {
    log.warn('注册请求超出限速', { ip })
    return json(res, 429, { error: '尝试过于频繁，请稍后再试' })
  }
  if ((await registrationMode(deps.store)) !== 'invite') {
    return json(res, 403, { error: '这台服务器没有开放注册' })
  }

  const b = body as { code?: string; name?: string; password?: string; agree?: boolean }
  if (b?.agree !== true) return json(res, 400, { error: '需要先同意隐私与风险声明' })

  const name = (b?.name ?? '').trim()
  const nameCheck = validateUserName(name)
  if (!nameCheck.ok) return json(res, 400, { error: nameCheck.error })

  const pwCheck = validatePassword(b?.password ?? '')
  if (!pwCheck.ok) return json(res, 400, { error: pwCheck.error })

  const code = (b?.code ?? '').trim().toUpperCase()
  if (!code) return json(res, 401, { error: REGISTER_FAIL })
  const codeHash = await hashToken(code)

  /**
   * 三步走：先看、再查名、最后原子地取。
   *
   * 两个约束同时要满足，所以不能只做两步：
   *  - **注册没成功就不能烧掉码**。名字撞车是用户的正常失误，
   *    代价不该是再去要一个码。
   *  - **不能变成用户名枚举器**。如果先查名再验码，带一个乱填的码提交时，
   *    「用户名被占」与「邀请码无效」两种回答就把这个免鉴权接口变成了
   *    一个不需要邀请码的枚举通道。
   *
   * 先 peek 一次就把两者都满足了：没有有效码的人永远走不到查名那一步，
   * 而查名失败时码还在。最后的 take 仍然是原子的——peek 与 take 之间
   * 有一个极窄的窗口，两个人同时用同一个码时由 take 决出唯一的赢家。
   */
  if (!(await deps.store.peekInvite(codeHash, now()))) {
    return json(res, 401, { error: REGISTER_FAIL })
  }

  if (await deps.store.getUserByName(name)) {
    // 走到这里说明对方确实拿着一个有效的码，不再是匿名攻击者，
    // 告诉他真实原因是应该的——而且他的码还没被消费
    return json(res, 409, { error: '这个用户名已经有人用了，换一个再试。你的邀请码还在' })
  }

  const id = newId('usr')
  const invite = await deps.store.takeInvite(codeHash, id, now())
  // peek 过了但 take 失败：只可能是有人在这几毫秒里抢先用掉了同一个码
  if (!invite) return json(res, 401, { error: REGISTER_FAIL })

  const t = now()
  await deps.store.upsertUser({
    id, name,
    password_hash: await withPasswordSlot(() => hashPassword(b!.password!)),
    // 两步验证是可选的：注册完引导绑定，跳过也能用
    totp_secret: '',
    role: 'member', bot_token: generateSessionToken(),
    disabled: false,
    expires_at: invite.valid_days === null ? null : t + invite.valid_days * 86_400_000,
    agreed_version: PRIVACY_VERSION, agreed_at: t,
    created_at: t,
  })
  await seedRetention(deps.store, id)
  await deps.store.audit({
    user_id: id, actor: name, action: 'user.register',
    detail: invite.note ? `邀请备注：${invite.note}` : null, ip, created_at: t,
  })
  log.info('新用户注册', { name, expires_at: invite.valid_days })

  json(res, 200, { ok: true, name })
}, false)

/**
 * 用一个新的邀请码给自己续期。
 *
 * 到期的人登不进控制台，所以这条路必须是免鉴权可达的——但它**照样要验全套凭证**
 * （口令，绑了两步验证的还要动态码）。不验的话，任何拿到邀请码的人都能给别人的
 * 账号续期；更糟的是它会变成一个「这个用户名存不存在」的探测器。
 *
 * 两个刻意的边界：
 *  - **停用的账号不能靠邀请码复活**。到期是「时间到了」，停用是「管理员说不行」，
 *    后者不该被一个码推翻。
 *  - 续期从**原到期时刻**往后接，没到期的部分不会被抹掉。
 */
route('POST', '/api/account/renew', async ({ res, body, deps, ip }) => {
  if (regLimited(ip)) return json(res, 429, { error: '尝试过于频繁，请稍后再试' })

  const b = body as { name?: string; password?: string; code?: string; invite?: string }
  const acct = await deps.store.getUserByName((b?.name ?? '').trim())

  const okPw = !!acct
    && (await withPasswordSlot(async () => verifyPassword(b?.password ?? '', acct.password_hash)))
  const okTotp = okPw && (!acct!.totp_secret || (await verifyTotp(acct!.totp_secret, b?.code ?? '')))
  if (!acct || !okPw || !okTotp) return json(res, 401, { error: '口令或验证码不正确' })

  if (acct.disabled) {
    // 停用是人做的决定，不该被一个邀请码推翻
    return json(res, 403, { error: '这个账号已被管理员停用，邀请码无法恢复它' })
  }

  const invite = (b?.invite ?? '').trim().toUpperCase()
  const codeHash = await hashToken(invite)
  if (!invite || !(await deps.store.peekInvite(codeHash, now()))) {
    return json(res, 401, { error: REGISTER_FAIL })
  }
  const taken = await deps.store.takeInvite(codeHash, acct.id, now())
  if (!taken) return json(res, 401, { error: REGISTER_FAIL })

  // 码上写着能用多少天；没写有效期的码等于续成永久
  const expires = taken.valid_days === null
    ? null
    : Math.max(acct.expires_at ?? 0, now()) + taken.valid_days * 86_400_000
  await deps.store.upsertUser({ ...acct, expires_at: expires })
  await deps.store.audit({
    user_id: acct.id, actor: acct.name, action: 'account.renew',
    detail: expires === null ? '永久' : new Date(expires).toISOString().slice(0, 10),
    ip, created_at: now(),
  })
  log.info('账号已用邀请码自助续期', { name: acct.name, expires_at: expires })
  json(res, 200, { ok: true, expires_at: expires })
}, false)

/** 注册失败一律这一句：不区分码不存在 / 已用 / 过期，避免给枚举提供反馈 */
const REGISTER_FAIL = '邀请码无效或已被使用'

// ── 设备与配对 ──────────────────────────────────────────────

/**
 * 取一台**属于这个人**的设备。
 *
 * `getDevice` 故意不带作用域（WS 握手时只有 device_id），所以每一个
 * 面向界面的设备接口都必须走这里。不属于自己的一律当「不存在」——
 * 返回 409 之类的具体错误等于告诉对方「这台设备真的存在，只是不归你」。
 */
async function ownedDevice(deps: ApiDeps, userId: string, id: string) {
  const d = await deps.store.getDevice(id)
  return d && d.user_id === userId ? d : null
}

/** 网络状态只用于展示：解析失败就当没有，不要让一条脏数据把整个设备列表打挂。 */
function parseNet(raw: string | null): unknown {
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

route('GET', '/api/devices', async ({ user, res, deps }) => {
  const devices = await deps.store.listDevices(user.id)
  const online = new Set(deps.hub.onlineDevices())
  json(res, 200, {
    devices: devices.map((d) => ({
      id: d.id, name: d.name,
      // 以实际连接状态为准：库里的 status 在服务端异常退出后可能是陈旧的
      status: d.status === 'revoked' ? 'revoked' : online.has(d.id) ? 'online' : 'offline',
      last_seen_at: d.last_seen_at, battery: d.battery, charging: d.charging,
      net: parseNet(d.net_json),
      // 只给出「有没有、什么时候」，坐标要单独请求并留审计
      has_location: d.location_enc !== null, location_at: d.location_at,
      app_version: d.app_version, created_at: d.created_at,
    })),
  })
}, true, false, 'bot')

/**
 * 配对二维码里的内容。
 *
 * 自定义 scheme 而不是裸 URL：Agent 扫到它能一次拿到「连哪台服务器」和
 * 「配对码是什么」两件事，用户一个字都不用打——手打 wss 地址和一串
 * 区分大小写的配对码，是整个接入流程里最容易出错的一步。
 */
export const pairPayload = (wsUrl: string, code: string): string =>
  `smsgw://pair?url=${encodeURIComponent(wsUrl)}&code=${encodeURIComponent(code)}`

/** 控制台地址推导 Agent 的 WS 地址：https://host → wss://host/ws */
function wsUrlFrom(baseUrl: string | null | undefined): string | null {
  if (!baseUrl) return null
  const u = baseUrl.trim().replace(/\/+$/, '')
  if (u.startsWith('https://')) return `wss://${u.slice(8)}/ws`
  if (u.startsWith('http://')) return `ws://${u.slice(7)}/ws`
  return null
}

route('POST', '/api/devices/pairing-code', async ({ user, res, body, deps }) => {
  const name = (body as { name?: string })?.name?.trim()
  if (!name) return json(res, 400, { error: '缺少 name' })
  const r = await createPairing(deps.store, user.id, name)
  const ws = wsUrlFrom(deps.baseUrl)
  json(res, 200, {
    code: r.code,
    expires_at: r.expires_at,
    ttl_sec: Math.round((r.expires_at - now()) / 1000),
    ws_url: ws,
    // 没配 GW_BASE_URL 时不给二维码：与其给一个指向 localhost 的错地址，
    // 不如让用户手输——错的二维码比没有二维码更难排查
    qr: ws ? toSvg(pairPayload(ws, r.code), { cell: 4, label: '设备配对二维码' }) : null,
  })
})

/**
 * 一台设备的连接日志。
 *
 * 「设备不在线」只有一个比特的信息量。这里给的是**在那之前发生了什么**——
 * 上线、掉线、凭证被拒、账号到期。都是服务端这一侧看得见的事，
 * 不需要设备配合，所以**设备离线时照样能看**（而那正是最需要看的时候）。
 */
route('GET', '/api/devices/:id/logs', async ({ user, res, params, url, deps }) => {
  const d = await ownedDevice(deps, user.id, params.id!)
  if (!d) return json(res, 404, { error: '设备不存在' })
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 100), 1), 500)
  json(res, 200, { logs: await deps.store.listDeviceLogs(d.id, user.id, limit) })
}, true, false, 'bot')

/**
 * 向设备本身要它的日志。
 *
 * 与上面那条的分工：上面那条是**服务端看到的**（上下线、被拒原因），
 * 离线照样能看；这一条是**手机内部的**（哪条采集链路没起来、为什么反复重连），
 * 但要设备在线。两者互补，缺一不可。
 */
route('POST', '/api/devices/:id/agent-logs', async ({ user, res, params, body, deps, ip }) => {
  if (!deps.agentLogs) return json(res, 500, { error: '未接入' })
  const d = await ownedDevice(deps, user.id, params.id!)
  if (!d) return json(res, 404, { error: '设备不存在' })
  if (d.status !== 'online') return json(res, 409, { error: '设备当前不在线。离线时用短信指令问它，那条路不经过服务器' })

  const b = body as { limit?: number; min_level?: string }
  const r = await deps.agentLogs(
    d.id,
    Math.min(Math.max(Number(b?.limit) || 200, 1), 500),
    ['debug', 'info', 'warn', 'error'].includes(b?.min_level ?? '') ? b!.min_level! : 'info',
  )
  await deps.store.audit({
    user_id: user.id, actor: user.name, action: 'device.agent_logs', detail: d.id, ip, created_at: now(),
  })
  if (!r.ok) return json(res, 502, { error: r.error })
  json(res, 200, r.result)
})

/**
 * 立刻刷新一台设备的状态。
 *
 * 心跳每 30 秒带回一次全量状态（电量、充电、逐卡信号、网络），平时够用；
 * 但排查「它到底怎么了」的时候，盯着一个 29 秒前的读数干等很难受。
 *
 * 实现上**不新增指令**：主动发一帧 ping，Agent 的 pong 里本来就带全部状态。
 * 这样 Agent 侧零改动、不用发新 APK——而为这件事新造一个 cmd action，
 * 正是当年 query_status 那三个死值的由来。
 */
route('POST', '/api/devices/:id/refresh', async ({ user, res, params, deps }) => {
  // 注意参数顺序是 (deps, userId, id)，两个都是 string，写反了类型检查抓不到，
  // 表现是「设备永远不存在」
  const d = await ownedDevice(deps, user.id, params.id!)
  if (!d) return json(res, 404, { error: '设备不存在' })
  if (!deps.pingDevice) return json(res, 500, { error: '未接入' })
  if (!deps.pingDevice(d.id)) return json(res, 409, { error: '设备当前不在线' })
  // pong 是异步回来的，等一小会儿再让前端去读
  json(res, 202, { ok: true })
})

/**
 * 按需定位，用于设备找回。
 *
 * 位置与短信正文同等敏感：加密落库、日志不记坐标、**每次查询都写审计**。
 * 审计尤其重要——能定位这台设备的人，也能看到你全部的验证码，
 * 所以至少要留下谁在什么时候查过的痕迹。
 */
route('POST', '/api/devices/:id/locate', async ({ user, res, params, deps, ip }) => {
  if (!deps.locateDevice) return json(res, 500, { error: '未接入定位' })
  const id = params.id!
  const device = await ownedDevice(deps, user.id, id)
  if (!device) return json(res, 404, { error: '设备不存在' })

  await deps.store.audit({ actor: 'admin', action: 'device.locate', detail: id, ip, created_at: now() })

  const r = await deps.locateDevice(id)
  if (!r.ok) return json(res, 502, { error: r.error ?? '定位失败' })
  json(res, 200, r.location)
})

/** 读取上次定位结果。同样写审计。 */
route('GET', '/api/devices/:id/location', async ({ user, res, params, deps, ip }) => {
  const d = await ownedDevice(deps, user.id, params.id!)
  if (!d?.location_enc) return json(res, 404, { error: '还没有定位记录' })
  await deps.store.audit({ actor: 'admin', action: 'device.location_read', detail: params.id!, ip, created_at: now() })
  json(res, 200, {
    ...JSON.parse(await deps.cipher.decrypt(d.location_enc)),
    recorded_at: d.location_at,
  })
})

route('DELETE', '/api/devices/:id/token', async ({ user, res, params, deps, ip }) => {
  const id = params.id!
  if (!(await ownedDevice(deps, user.id, id))) return json(res, 404, { error: '设备不存在' })
  await deps.store.revokeDevice(id, user.id)
  deps.hub.get(id)?.close(4001, 'AUTH_DEVICE_REVOKED')
  await deps.store.audit({ actor: 'console', action: 'device.revoke', detail: id, ip, created_at: now() })
  json(res, 200, { ok: true })
})

/**
 * 彻底删除设备记录。
 *
 * **必须先吊销**。删一台还在线的设备，它的 Agent 下次握手会收到
 * AUTH_UNKNOWN_DEVICE 而彻底停下来（那是不可重试的错误码），得跑到手机跟前
 * 重新配对。吊销是「我确认这台不要了」那一下，删除只是事后打扫。
 *
 * 被计划任务或规则引用时拒绝删除并说清楚是谁在引用——静默删掉会让保号任务
 * 永远跳过、让限定设备的规则永远不命中，两种都是不报错的失效。
 */
route('DELETE', '/api/devices/:id', async ({ user, res, params, url, deps, ip }) => {
  const id = params.id!
  // 归属先判：不是自己的一律「不存在」，不能先报 409 暴露它真的在
  const device = await ownedDevice(deps, user.id, id)
  if (!device) return json(res, 404, { error: '设备不存在' })
  if (device.status !== 'revoked') {
    return json(res, 409, { error: '请先吊销这台设备，再删除记录' })
  }

  const tasks = (await deps.store.listTasks(user.id)).filter((t) => t.device_id === id)
  if (tasks.length > 0) {
    return json(res, 409, {
      error: `还有计划任务绑定着这台设备：${tasks.map((t) => t.name).join('、')}。请先改掉或删掉这些任务。`,
    })
  }

  const rules = (await deps.store.listRules(user.id)).filter((r) => {
    try { return ((JSON.parse(r.match_json) as { device_ids?: string[] }).device_ids ?? []).includes(id) }
    catch { return false }
  })
  if (rules.length > 0) {
    return json(res, 409, {
      error: `还有规则限定了这台设备：${rules.map((r) => r.name).join('、')}。请先在规则里去掉它。`,
    })
  }

  // 历史消息默认保留：设备没了不代表那些验证码就不该存在。
  //
  // 用查询串而不是请求体：handleApi 只对 POST/PUT 解析 body，
  // DELETE 带的 body 会被直接丢掉——写成 body 就是个永远为 false 的死参数。
  const purge = url.searchParams.get('purge') === '1'
  let events = 0
  let outbound = 0
  if (purge) {
    events = await deps.store.deleteEvents({ user_id: user.id, device_id: id })
    outbound = await deps.store.deleteOutboundByDevice(id, user.id)
  }

  await deps.store.deleteDevice(id, user.id)
  log.warn('设备记录已删除', { device_id: id, name: device.name, purge, events, outbound })
  await deps.store.audit({
    actor: 'admin', action: 'device.delete',
    detail: `${device.name}(${id})${purge ? ` 并清理 ${events} 条消息、${outbound} 条发送记录` : '，历史保留'}`,
    ip, created_at: now(),
  })
  json(res, 200, { ok: true, events, outbound })
})

/** Agent 调用，无需鉴权——配对码本身就是凭证。 */
route('POST', '/api/pair', async ({ user, res, body, deps, ip }) => {
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

route('GET', '/api/channels', async ({ user, res, deps }) => {
  const rows = await deps.store.listChannels(user.id)
  // 绝不返回配置明文：里面是 Bot token
  json(res, 200, {
    channels: rows.map((c) => ({ id: c.id, type: c.type, name: c.name, enabled: c.enabled, created_at: c.created_at })),
  })
})

/**
 * 渠道配置里可能藏着 SSRF。
 *
 * webhook 会让服务端按用户给的地址发请求。allow_private 这一项只有管理员
 * 能开——普通成员开了它，就等于拿到一个「让服务器替我访问内网」的原语。
 * 静默忽略而不是报错：用户没这个权限，就当他没填。
 */
function sanitizeChannelConfig(
  type: string, cfg: Record<string, unknown>, isAdmin: boolean,
): { ok: true; config: Record<string, unknown> } | { ok: false; error: string } {
  if (type !== 'webhook') return { ok: true, config: cfg }
  const allowPrivate = isAdmin && cfg.allow_private === true
  const bad = checkWebhookTarget(String(cfg.url ?? ''), allowPrivate)
  if (bad) return { ok: false, error: bad }
  return { ok: true, config: { ...cfg, allow_private: allowPrivate } }
}

/**
 * 同一个 Telegram Bot token 不能被两条渠道用。
 *
 * Telegram 只允许**一个**程序对一个 token 做长轮询。两条渠道就是两个实例，
 * 互撞 409：谁抢到是随机的，而抢到的那个会把另一个人 chat 的更新一并拉下来，
 * 白名单不匹配就静默丢弃，同时 offset 往前走——那条命令对另一个实例
 * 永远消失了。表现是「Bot 命令时灵时不灵」，而且只有服务端日志里有线索。
 *
 * 推送方向其实不受影响（各发各的 chat_id），所以这不是安全漏洞而是可用性陷阱；
 * 但它排查成本极高，值得在保存那一刻就拦住。
 *
 * 跨用户检查，因此要读 listAllChannels。这会泄漏「这个 token 在这台网关上
 * 已被使用」——但对面本来就握着这个 token，而不说的代价是两个人一起懵。
 * 不说是谁在用。
 */
async function telegramTokenTaken(
  deps: ApiDeps, token: string, exceptChannelId: string | null,
): Promise<boolean> {
  for (const row of await deps.store.listAllChannels()) {
    if (row.type !== 'telegram' || row.id === exceptChannelId) continue
    try {
      const cfg = JSON.parse(await deps.cipher.decrypt(row.config_enc)) as { bot_token?: string }
      if (cfg.bot_token && timingSafeEqual(cfg.bot_token, token)) return true
    } catch { /* 解不开的老配置跳过，不能因为一条坏数据挡住所有人保存 */ }
  }
  return false
}

const TOKEN_TAKEN = '这个 Bot 已经被这台网关上的另一个账号用了。'
  + 'Telegram 只允许一个程序拉取一个 Bot 的消息，共用会让双方的 Bot 命令互相丢失。'
  + '请去 @BotFather 发 /newbot 建一个自己的。'

route('POST', '/api/channels', async ({ user, res, body, deps, ip }) => {
  const b = body as { type?: string; name?: string; config?: unknown; enabled?: boolean }
  const provider = b.type ? PROVIDERS[b.type] : undefined
  if (!provider) return json(res, 400, { error: `未知渠道类型 ${b.type}` })

  const parsed = provider.configSchema.safeParse(b.config)
  if (!parsed.success) {
    return json(res, 400, { error: '配置校验失败', detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) })
  }
  const safe = sanitizeChannelConfig(b.type!, parsed.data as Record<string, unknown>, user.role === 'admin')
  if (!safe.ok) return json(res, 400, { error: safe.error })

  if (b.type === 'telegram') {
    const token = (safe.config as { bot_token?: string }).bot_token ?? ''
    if (await telegramTokenTaken(deps, token, null)) return json(res, 409, { error: TOKEN_TAKEN })
  }

  const id = newId('ch')
  await deps.store.audit({ actor: 'admin', action: 'channel.create', detail: `${b.type}:${b.name ?? b.type}`, ip, created_at: now() })
  await deps.store.upsertChannel({
    id, user_id: user.id, type: b.type!, name: b.name ?? b.type!,
    config_enc: await deps.cipher.encrypt(JSON.stringify(safe.config)),
    enabled: b.enabled ?? true, created_at: now(),
  })
  json(res, 200, { id })
})

/**
 * 编辑渠道。
 *
 * 配置里的密钥（Bot token 等）从不返回给前端，所以编辑时留空表示「沿用旧值」：
 * 解密旧配置 → 用请求里的非空字段覆盖 → 校验 → 重新加密。
 * 否则用户每次改个名字都得重新输一遍 token。
 */
route('PUT', '/api/channels/:id', async ({ user, res, params, body, deps, ip }) => {
  const c = await deps.store.getChannel(params.id!, user.id)
  if (!c) return json(res, 404, { error: '渠道不存在' })

  const b = body as { name?: string; enabled?: boolean; config?: Record<string, unknown> }
  const provider = PROVIDERS[c.type]
  if (!provider) return json(res, 400, { error: `未知渠道类型 ${c.type}` })

  let configEnc = c.config_enc
  if (b.config) {
    const old = JSON.parse(await deps.cipher.decrypt(c.config_enc)) as Record<string, unknown>
    const merged = { ...old }
    for (const [k, v] of Object.entries(b.config)) {
      // 空字符串 / undefined = 这一项没填，沿用旧值（密钥不回显，所以「没填」是常态）
      if (v === '' || v === undefined) continue
      // 显式 null = 清空这一项。两者必须分开：可选字段（Bark 的 icon）
      // 一旦填上就再也删不掉的话，那不是「没做」，是个改不回去的坑。
      // 必填字段上传 null 会在下面的 schema 校验里 400，不会静默改坏。
      if (v === null) { delete merged[k]; continue }
      merged[k] = v
    }
    const parsed = provider.configSchema.safeParse(merged)
    if (!parsed.success) {
      return json(res, 400, { error: '配置校验失败', detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) })
    }
    const safe = sanitizeChannelConfig(c.type, parsed.data as Record<string, unknown>, user.role === 'admin')
    if (!safe.ok) return json(res, 400, { error: safe.error })
    if (c.type === 'telegram') {
      const token = (safe.config as { bot_token?: string }).bot_token ?? ''
      if (await telegramTokenTaken(deps, token, c.id)) return json(res, 409, { error: TOKEN_TAKEN })
    }
    configEnc = await deps.cipher.encrypt(JSON.stringify(safe.config))
  }

  await deps.store.upsertChannel({
    id: c.id, user_id: user.id, type: c.type,
    name: b.name?.trim() || c.name,
    config_enc: configEnc,
    enabled: b.enabled ?? c.enabled,
    created_at: c.created_at,
  })
  await deps.store.audit({ actor: 'admin', action: 'channel.update', detail: c.id, ip, created_at: now() })
  json(res, 200, { ok: true })
})

/**
 * 从 Bot token 反查 chat_id。
 *
 * chat_id 是「人」的标识，与用哪个 Bot 无关；但换新 Bot 后用户必须先给它
 * 发一条消息，Telegram 才允许 Bot 主动发消息过去。这个接口顺带验证了这一点：
 * 取不到更新就说明还没发过。
 */
route('POST', '/api/channels/telegram/discover-chat', async ({ user, res, body }) => {
  const token = (body as { bot_token?: string })?.bot_token?.trim()
  if (!token) return json(res, 400, { error: '缺少 bot_token' })

  // 到 Telegram 的链路偶有超时（实测约 1/6），重试两次基本都能成
  let r: Response | null = null
  let lastErr = ''
  for (let attempt = 1; attempt <= 3; attempt++) {
    r = await fetch(`https://api.telegram.org/bot${token}/getUpdates?limit=20`, {
      signal: AbortSignal.timeout(20_000),
    }).catch((e: unknown) => {
      lastErr = describeFetchError(e)
      return null
    })
    if (r) break
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 800 * attempt))
  }

  if (!r) {
    log.warn('查询 Telegram 更新失败', { error: lastErr })
    return json(res, 502, { error: `无法连接 Telegram（${lastErr}），请稍后重试` })
  }
  if (r.status === 409) {
    return json(res, 409, { error: '该 token 正被另一个程序长轮询，无法读取更新。请换用独立的 Bot。' })
  }
  if (!r.ok) return json(res, 400, { error: `Telegram 返回 ${r.status}，token 可能不正确` })

  const data = (await r.json()) as {
    result?: { message?: { chat?: { id?: number; type?: string; username?: string; first_name?: string } } }[]
  }
  const seen = new Map<string, { id: string; type: string; name: string }>()
  for (const u of data.result ?? []) {
    const c = u.message?.chat
    if (c?.id == null) continue
    seen.set(String(c.id), {
      id: String(c.id), type: c.type ?? '?',
      name: c.username ? `@${c.username}` : (c.first_name ?? ''),
    })
  }

  json(res, 200, {
    chats: [...seen.values()],
    hint: seen.size === 0 ? '没读到任何消息。请先在 Telegram 里给这个 Bot 发一条 /start，再点一次。' : null,
  })
})

route('DELETE', '/api/channels/:id', async ({ user, res, params, deps, ip }) => {
  const c = await deps.store.getChannel(params.id!, user.id)
  await deps.store.deleteChannel(params.id!, user.id)
  // 删除必须留痕：渠道没了等于通知全断，而这种故障是静默的
  await deps.store.audit({
    actor: 'admin', action: 'channel.delete',
    detail: c ? `${c.type}:${c.name}` : params.id!, ip, created_at: now(),
  })
  json(res, 200, { ok: true })
})

/**
 * 浏览器通知（Web Push）。
 *
 * 订阅本身就是一条渠道：这样规则、测试按钮、按用户隔离全都直接复用，
 * 不需要另开一套。一个浏览器一条，删掉这条渠道就等于退订。
 */
const S_VAPID = 'vapid_keys'

/**
 * 这台网关的 VAPID 密钥对，首次用到时生成。
 *
 * 私钥加密落库（和渠道配置同一把 DEK）。公钥要交给浏览器当
 * applicationServerKey——订阅在创建那一刻就和它绑死了，所以**不能换**：
 * 换了之后老订阅仍然只认老公钥，而我们把公钥连同订阅一起存在渠道配置里，
 * 所以换了也不会把老订阅弄坏。
 */
async function vapidKeys(deps: ApiDeps): Promise<VapidKeys> {
  const raw = await deps.store.getSetting(S_VAPID)
  if (raw) {
    try { return JSON.parse(await deps.cipher.decrypt(fromHex(raw))) as VapidKeys } catch { /* 坏了就重生成 */ }
  }
  const keys = await generateVapidKeys()
  await deps.store.setSetting(S_VAPID, toHex(await deps.cipher.encrypt(JSON.stringify(keys))))
  log.info('已生成 VAPID 密钥对')
  return keys
}

/** 浏览器订阅前要先拿到公钥。只回公钥，不回私钥 */
route('GET', '/api/push/key', async ({ res, deps }) => {
  json(res, 200, { key: (await vapidKeys(deps)).publicKey })
})

/**
 * 登记一个浏览器订阅。
 *
 * 同一个 endpoint 重复订阅是常事（刷新页面、重新授权），按 endpoint 去重，
 * 否则渠道列表会被同一个浏览器塞满，而且每条消息推好几遍。
 */
route('POST', '/api/push/subscribe', async ({ user, res, body, deps, ip }) => {
  const b = body as { endpoint?: string; p256dh?: string; auth?: string; label?: string }
  const keys = await vapidKeys(deps)
  const base = deps.baseUrl?.replace(/\/$/, '')
  const cfg = {
    endpoint: b.endpoint, p256dh: b.p256dh, auth: b.auth,
    label: (b.label ?? '').slice(0, 64) || null,
    vapid_public: keys.publicKey, vapid_private: keys.privateKey,
    // VAPID 的 sub 必须是 mailto: 或 https:，推送服务会校验
    subject: base?.startsWith('https://') ? base : 'mailto:admin@localhost',
  }
  const parsed = WebPushConfig.safeParse(cfg)
  if (!parsed.success) {
    return json(res, 400, { error: '订阅信息不完整', detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) })
  }

  // 同一个浏览器重复订阅：覆盖，不新建
  for (const c of await deps.store.listChannels(user.id)) {
    if (c.type !== 'webpush') continue
    try {
      const old = JSON.parse(await deps.cipher.decrypt(c.config_enc)) as { endpoint?: string }
      if (old.endpoint !== cfg.endpoint) continue
      // 只更新配置，**不动 enabled**：界面每次进设置页都会重登记一次来自愈，
      // 顺手把用户手动停用的渠道又打开就太意外了
      await deps.store.upsertChannel({
        ...c, name: cfg.label ?? c.name,
        config_enc: await deps.cipher.encrypt(JSON.stringify(parsed.data)),
      })
      return json(res, 200, { id: c.id, replaced: true, enabled: c.enabled })
    } catch { /* 解不开的老配置跳过 */ }
  }

  const id = newId('ch')
  await deps.store.upsertChannel({
    id, user_id: user.id, type: 'webpush',
    name: cfg.label ?? '浏览器通知',
    config_enc: await deps.cipher.encrypt(JSON.stringify(parsed.data)),
    enabled: true, created_at: now(),
  })
  await deps.store.audit({
    user_id: user.id, actor: user.name, action: 'push.subscribe',
    detail: cfg.label, ip, created_at: now(),
  })
  json(res, 200, { id, replaced: false, enabled: true })
})

/**
 * 渠道测试。不是可选功能：配错渠道是这类系统最常见的故障，
 * 而故障时你收不到任何通知——这是个静默失败（计划 §7.4）。
 */
route('POST', '/api/channels/:id/test', async ({ user, res, params, deps }) => {
  const c = await deps.store.getChannel(params.id!, user.id)
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
    title: '✅ 渠道测试',
    // 正文写给**收到的那个人**看，而不是写给点测试的人看：
    // 如果 chat_id 填成了别人的，看到这条的就是那个陌生人，
    // 他需要知道自己为什么收到了它、以及接下来会收到什么
    body: '这是一条测试消息，收到即说明渠道配置正确。'
      + '如果你并没有配置过这台网关，说明有人把接收地址填成了你的——'
      + '请告诉他，否则他的短信会一直发到你这里。',
    alert: true, priority: 'normal', code: null, eventId: '', occurredAt: now(),
  })
  /**
   * 测试成功留个痕。
   *
   * 「配了渠道」和「渠道真的通」是两件事，而它们的差别只有按下测试那一刻
   * 才看得出来——渠道配错的表现是**什么都没发生**，不报错、不告警，
   * 等你发现时已经漏了几条。总览的上手清单靠这个标记判断第二步做完没有，
   * 所以它记的是「测通过」，不是「存过」。
   */
  if (r?.ok) {
    await deps.store.setUserSetting(user.id, S_CHANNEL_TESTED, String(now()))
      .catch(() => { /* 记不上不该让测试本身失败 */ })
  }

  json(res, r?.ok ? 200 : 502, {
    ok: r?.ok ?? false, attempts: r?.attempts ?? 0, error: r?.error ?? null,
    // 让操作者当场看见「发给了谁」。填错 chat_id 时这是唯一的线索——
    // 否则界面上只有一个绿色的「已发出」，而收到的是别人
    to: r?.to ?? null,
  })
})

// ── 备份 ────────────────────────────────────────────────────

/**
 * 导出配置。
 *
 * 只导「重建时需要、且丢了会心疼」的东西：规则、任务、渠道的壳、
 * 几项设置。**不导消息**（见下面的 /api/backup/events），
 * **不导设备**（一台设备是一次配对出来的长期凭证，文件里恢复不出来，
 * 只能重新扫码），**不导密钥**。
 */
route('GET', '/api/backup/config', async ({ user, res, deps }) => {
  const [rules, tasks, channels, settings] = await Promise.all([
    deps.store.listRules(user.id),
    deps.store.listTasks(user.id),
    deps.store.listChannels(user.id),
    deps.store.listUserSettings(user.id),
  ])

  const out: BackupFile = {
    version: BACKUP_VERSION,
    exported_at: now(),
    notice: BACKUP_NOTICE,
    rules: rules.map((r) => ({
      name: r.name, priority: r.priority, enabled: r.enabled,
      match: JSON.parse(r.match_json) as unknown,
      action: JSON.parse(r.action_json) as unknown,
    })),
    tasks: await Promise.all(tasks.map(async (t) => ({
      name: t.name, enabled: t.enabled, to: t.to_number,
      text: await deps.cipher.decrypt(t.content_enc).catch(() => ''),
      sim_slot: t.sim_slot,
      schedule: JSON.parse(t.schedule_json) as unknown,
    }))),
    channels: await Promise.all(channels.map(async (c) => {
      const raw = JSON.parse(await deps.cipher.decrypt(c.config_enc)) as Record<string, unknown>
      const { config, removed } = redactChannelConfig(c.type, raw)
      return { type: c.type, name: c.name, enabled: c.enabled, config, missing: removed }
    })),
    settings: Object.fromEntries(
      Object.entries(settings)
        .filter(([k]) => EXPORTABLE_USER_SETTINGS.includes(k))
        .map(([k, v]) => [k, redactUserSetting(k, v)])
        .filter(([, v]) => v !== ''),
    ),
  }

  await deps.store.audit({
    user_id: user.id, actor: user.name, action: 'backup.export',
    detail: `规则 ${out.rules.length} 任务 ${out.tasks.length} 渠道 ${out.channels.length}`,
    ip: null, created_at: now(),
  })
  json(res, 200, out)
})

/**
 * 导入配置。
 *
 * **只增不改**：按名字判断，已经存在的原样跳过。合并策略越聪明，
 * 出错时越难解释——而这是一个「我以为恢复好了」代价很高的场景。
 * 导完如实回报每一类各加了几条、跳过了几条。
 *
 * 渠道只恢复出一个壳（密钥不在文件里），而且**一律建成停用**：
 * 一条配置不全的渠道被规则选中，表现是推送静默失败。
 */
route('POST', '/api/backup/config', async ({ user, res, body, deps, ip }) => {
  const v = validateBackup(body)
  if (!v.ok) return json(res, 400, { error: v.error })
  const f = v.file
  const t = now()

  const [haveRules, haveTasks, haveChannels] = await Promise.all([
    deps.store.listRules(user.id), deps.store.listTasks(user.id), deps.store.listChannels(user.id),
  ])
  const nameOf = (xs: { name: string }[]) => new Set(xs.map((x) => x.name))
  const rn = nameOf(haveRules); const tn = nameOf(haveTasks); const cn = nameOf(haveChannels)

  const stat = { rules: 0, tasks: 0, channels: 0, settings: 0, skipped: 0, failed: [] as string[] }

  for (const r of f.rules) {
    if (rn.has(r.name)) { stat.skipped++; continue }
    const m = RuleMatch.safeParse(r.match); const a = RuleAction.safeParse(r.action)
    // 一条坏规则不该让整份文件导不进来，但要说出是哪一条
    if (!m.success || !a.success) { stat.failed.push(`规则「${r.name}」`); continue }
    await deps.store.upsertRule({
      id: newId('rule'), user_id: user.id, name: r.name,
      priority: Number(r.priority) || 100, enabled: !!r.enabled,
      match_json: JSON.stringify(m.data), action_json: JSON.stringify(a.data), created_at: t,
    })
    stat.rules++
  }

  for (const k of f.tasks) {
    if (tn.has(k.name)) { stat.skipped++; continue }
    const sc = Schedule.safeParse(k.schedule)
    if (!sc.success) { stat.failed.push(`任务「${k.name}」`); continue }
    await deps.store.upsertTask({
      id: newId('task'), user_id: user.id, name: k.name,
      // 任务绑定的设备恢复不出来（设备要重新配对），**一律建成停用**并留空设备，
      // 否则一个指向不存在设备的保号任务会永远静默跳过
      enabled: false, device_id: '', to_number: String(k.to ?? ''),
      content_enc: await deps.cipher.encrypt(String(k.text ?? '')),
      sim_slot: k.sim_slot ?? null,
      schedule_json: JSON.stringify(sc.data),
      last_run_at: null, last_status: null, fail_count: 0, created_at: t,
    })
    stat.tasks++
  }

  for (const c of f.channels) {
    if (cn.has(c.name)) { stat.skipped++; continue }
    if (!PROVIDERS[c.type]) { stat.failed.push(`渠道「${c.name}」类型未知`); continue }
    await deps.store.upsertChannel({
      id: newId('ch'), user_id: user.id, type: c.type, name: c.name,
      config_enc: await deps.cipher.encrypt(JSON.stringify(c.config ?? {})),
      // 密钥不在备份文件里，所以这是个配置不全的壳。建成停用的，
      // 免得它被规则选中之后静默发不出去
      enabled: false, created_at: t,
    })
    stat.channels++
  }

  for (const [k, val] of Object.entries(f.settings)) {
    if (!EXPORTABLE_USER_SETTINGS.includes(k)) continue
    await deps.store.setUserSetting(user.id, k, val)
    stat.settings++
  }

  await deps.store.audit({
    user_id: user.id, actor: user.name, action: 'backup.import',
    detail: `规则 +${stat.rules} 任务 +${stat.tasks} 渠道 +${stat.channels} 跳过 ${stat.skipped}`,
    ip, created_at: t,
  })
  json(res, 200, stat)
})

/**
 * 导出消息，NDJSON 流式。
 *
 * **绝不能把全部事件 stringify 成一个数组**：十几万条解密后的正文是
 * 几十 MB 明文外加一次字符串复制。分批取、逐条解、逐行写，内存恒定。
 *
 * 翻页用「时间游标」而不是 OFFSET：补传会往中间插入 occurred_at 很老的事件，
 * OFFSET 窗口会因此错位，漏掉或重复。
 */
route('GET', '/api/backup/events', async ({ user, res, url, deps }) => {
  const p = url.searchParams
  const kindParam = p.get('kind')
  const kind: 'sms' | 'call' | 'notification' | undefined =
    kindParam === 'sms' || kindParam === 'call' || kindParam === 'notification' ? kindParam : undefined
  const since = p.get('since') ? Number(p.get('since')) : undefined
  let until = p.get('until') ? Number(p.get('until')) : now()

  res.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })

  const seen = new Set<string>()
  let total = 0
  for (;;) {
    const rows = await deps.store.listEvents({
      user_id: user.id, limit: 500, offset: 0,
      ...(kind ? { kind } : {}), ...(since !== undefined ? { since } : {}), until,
    })
    if (rows.length === 0) break

    let wrote = 0
    for (const e of rows) {
      // 同一毫秒可能有多条（补传时不罕见），游标只能退到毫秒，
      // 所以要记住这一毫秒里已经输出过哪些 id
      if (seen.has(e.id)) continue
      seen.add(e.id)
      const line = JSON.stringify({
        id: e.id, kind: e.kind, direction: e.direction, sim_slot: e.sim_slot,
        from: await deps.cipher.decrypt(e.sender_enc).catch(() => ''),
        content: await deps.cipher.decrypt(e.content_enc).catch(() => ''),
        occurred_at: e.occurred_at, received_at: e.received_at,
      })
      if (!res.write(`${line}\n`)) await once(res, 'drain')
      wrote++
      total++
    }

    const last = rows[rows.length - 1]!
    // 这一批全是已经输出过的，说明卡在同一毫秒上了，再取也是这些
    if (wrote === 0 && last.occurred_at === until) break
    until = last.occurred_at
    // seen 只需要覆盖游标那一毫秒，不然十几万条会把内存吃光
    if (wrote > 0) {
      for (const id of [...seen]) {
        const still = rows.find((r) => r.id === id && r.occurred_at === until)
        if (!still) seen.delete(id)
      }
    }
    if (rows.length < 500) break
  }
  log.info('导出消息完成', { user_id: user.id, count: total })
  res.end()
})

// ── 规则 ────────────────────────────────────────────────────

route('GET', '/api/rules', async ({ user, res, deps }) => {
  const rows = await deps.store.listRules(user.id)
  const live = new Set((await deps.store.listChannels(user.id)).map((c) => c.id))
  json(res, 200, {
    rules: rows.map((r) => {
      const action = JSON.parse(r.action_json) as { channels?: string[] }
      return {
        id: r.id, name: r.name, priority: r.priority, enabled: r.enabled,
        match: JSON.parse(r.match_json), action, created_at: r.created_at,
        // 让控制台能直接标红，而不是等用户某天发现没收到通知
        dangling_channels: (action.channels ?? []).filter((c) => !live.has(c)),
      }
    }),
  })
}, true, false, 'bot')

route('POST', '/api/rules', async ({ user, res, body, deps, ip }) => {
  const b = body as { id?: string; name?: string; priority?: number; enabled?: boolean; match?: unknown; action?: unknown }
  const m = RuleMatch.safeParse(b.match ?? {})
  const a = RuleAction.safeParse(b.action ?? {})
  if (!m.success || !a.success) {
    const issues = [...(m.success ? [] : m.error.issues), ...(a.success ? [] : a.error.issues)]
    return json(res, 400, { error: '规则校验失败', detail: issues.map((i) => `${i.path.join('.')}: ${i.message}`) })
  }
  const id = b.id ?? newId('rule')
  await deps.store.audit({ actor: 'admin', action: b.id ? 'rule.update' : 'rule.create', detail: `${id}:${b.name ?? ''}`, ip, created_at: now() })
  await deps.store.upsertRule({
    id, user_id: user.id, name: b.name ?? '未命名规则', priority: b.priority ?? 100,
    enabled: b.enabled ?? true,
    match_json: JSON.stringify(m.data), action_json: JSON.stringify(a.data),
    created_at: now(),
  })
  json(res, 200, { id })
})

route('DELETE', '/api/rules/:id', async ({ user, res, params, deps, ip }) => {
  await deps.store.deleteRule(params.id!, user.id)
  await deps.store.audit({ actor: 'admin', action: 'rule.delete', detail: params.id!, ip, created_at: now() })
  json(res, 200, { ok: true })
})

/**
 * 用历史消息试跑规则（计划 §7.4）。
 *
 * 没有这个功能，规则写错的反馈周期是「等下一条真实短信」——
 * 调试成本高到会让人放弃使用规则引擎。
 */
route('POST', '/api/rules/test', async ({ user, res, body, deps }) => {
  const b = body as { match?: unknown; action?: unknown; limit?: number }
  const m = RuleMatch.safeParse(b.match ?? {})
  const a = RuleAction.safeParse(b.action ?? {})
  if (!m.success || !a.success) return json(res, 400, { error: '规则格式不正确' })

  const rule: Rule = {
    id: '__test__', name: '试跑', priority: 0, enabled: true,
    match: m.data, action: a.data,
  }

  const rows = await deps.store.listEvents({ user_id: user.id, limit: Math.min(b.limit ?? 50, 200), offset: 0 })
  const devNames = new Map((await deps.store.listDevices(user.id)).map((d) => [d.id, d.name]))
  const tz = await timezone(deps.store, user.id)
  const results = await Promise.all(rows.map(async (e) => {
    const ev = {
      device_id: e.device_id, kind: e.kind,
      from: await deps.cipher.decrypt(e.sender_enc),
      content: await deps.cipher.decrypt(e.content_enc),
      occurred_at: e.occurred_at,
      // 试跑必须带上方向，否则限定「本机发出」的规则在这里永远是未命中，
      // 而实际运行时却会命中——试跑跟真实行为不一致比没有试跑更糟
      direction: e.direction ?? ('in' as const),
      // 同理，卡槽条件也要按真实数据判
      sim_slot: e.sim_slot,
    }
    const hit = matchRule(rule, ev, safeOffsetMin(e.occurred_at, tz))
    const code = hit && rule.action.extract_code ? extractCode(ev.content) : null
    return {
      id: e.id, from: ev.from, content: ev.content, kind: e.kind,
      device_name: devNames.get(e.device_id) ?? e.device_id,
      occurred_at: e.occurred_at, matched: hit,
      code,
      preview: hit
        ? render(rule.action.template, {
            sender: ev.from, content: ev.content, code: code ?? '',
            // 与 pipeline 保持一致：{time} 是设置时区里的墙上时间，{device} 是设备名
            time: safeWallTime(e.occurred_at, tz),
            device: devNames.get(e.device_id) ?? e.device_id,
            sim: e.sim_slot == null ? '' : `SIM${e.sim_slot + 1}`,
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
route('POST', '/api/rules/seed', async ({ user, res, body, deps }) => {
  const chIds = ((body as { channels?: string[] })?.channels ?? []).filter(Boolean)
  if (chIds.length === 0) return json(res, 400, { error: '请先选择至少一个渠道' })

  const t = now()
  const seeds = buildSeedRules(chIds, () => newId('rule'))
  for (const r of seeds) {
    await deps.store.upsertRule({
      id: r.id, user_id: user.id, name: r.name, priority: r.priority, enabled: true,
      match_json: JSON.stringify(r.match), action_json: JSON.stringify(r.action), created_at: t,
    })
  }
  json(res, 200, { created: seeds.length })
})

/**
 * 设置里那个时区在该时刻的偏移。
 *
 * 不用服务端本地时区：容器跑在 UTC，而用户设的是 Asia/Tokyo，
 * 用本地时区算会让「夜间不打扰」整整错开 9 小时。
 */
function safeOffsetMin(epoch: number, tz: string): number {
  try { return offsetMs(epoch, tz) / 60_000 } catch { return 0 }
}

function safeWallTime(epoch: number, tz: string): string {
  try { return formatWallTime(epoch, tz) } catch { return formatWallTime(epoch, 'UTC') }
}

// ── Bark 设置 ───────────────────────────────────────────────

/**
 * 默认 push：其它服务可以拿已知的 device key 推送，但陌生人不能注册新设备。
 * 老部署里存的是布尔值 bark_public，这里做一次兼容映射。
 */
export async function barkAccess(store: Store): Promise<BarkAccess> {
  const v = await store.getSetting(S_BARK_ACCESS)
  if (v === 'off' || v === 'push' || v === 'full') return v
  const legacy = await store.getSetting('bark_public')
  if (legacy === '1') return 'full'
  if (legacy === '0') return 'off'
  return 'push'
}

route('GET', '/api/bark/info', async ({ user, res, deps }) => {
  json(res, 200, {
    // 网关推送走内部地址，不绕公网；渠道配置里就该填这个
    upstream: deps.barkUpstream ?? null,
    // 其它服务与 Bark App 用这个
    public_url: deps.barkPublicUrl ?? null,
    // Bark App 的「添加服务器」支持扫码，内容就是服务器地址本身。
    // 手打一个带路径的 https 地址是这一步最容易出错的地方。
    qr: deps.barkPublicUrl ? toSvg(deps.barkPublicUrl, { cell: 4, label: 'Bark 服务器地址二维码' }) : null,
    access: await barkAccess(deps.store),
  })
})

route('POST', '/api/bark/access', async ({ user, res, body, deps, ip }) => {
  // 这是实例级的开关，不是个人设置。route() 的 scope 只区分 token 类型，
  // **不做角色判断**——真正判角色的只有显式写了 role !== 'admin' 的地方。
  // 漏了这一句，任何注册进来的成员都能把 Bark 开成完全开放
  if (user.role !== 'admin') return json(res, 403, { error: '只有管理员能改 Bark 的开放档位' })
  const v = (body as { access?: string })?.access
  if (v !== 'off' && v !== 'push' && v !== 'full') {
    return json(res, 400, { error: 'access 必须是 off / push / full' })
  }
  await deps.store.setSetting(S_BARK_ACCESS, v)
  await deps.store.audit({ actor: 'admin', action: `bark.access.${v}`, detail: null, ip, created_at: now() })
  json(res, 200, { access: v })
})

// ── Bot service token ───────────────────────────────────────

/**
 * 每个用户一个 Bot service token。
 *
 * 不能共用一个：Bot 拿它调自己的 REST API，token 决定了它能看到谁的数据。
 * 共用就意味着女朋友的 Bot 能读你的短信——多用户在别处做得再干净，
 * 这一个口子就全漏了。
 */
export async function botTokenFor(store: Store, userId: string): Promise<string> {
  const u = await store.getUser(userId)
  if (!u) return ''
  if (u.bot_token) return u.bot_token
  const t = generateSessionToken()
  await store.upsertUser({ ...u, bot_token: t })
  return t
}

/** 吊销并重发。Telegram 账号疑似被盗时用，不影响 Web 会话。 */
route('POST', '/api/bot/rotate-token', async ({ user, res, deps, ip }) => {
  await deps.store.upsertUser({ ...user, bot_token: generateSessionToken() })
  await deps.store.audit({ user_id: user.id, actor: user.name, action: 'bot.token_rotate', detail: null, ip, created_at: now() })
  json(res, 200, { ok: true })
})

// ── 保号任务 ────────────────────────────────────────────────

/**
 * 计划任务。
 *
 * 保号只是其中一种用法；同一套机制也能做每日提醒、每周汇报之类的事。
 */
route('GET', '/api/tasks', async ({ user, res, deps }) => {
  const tz = await timezone(deps.store, user.id)
  const rows = await deps.store.listTasks(user.id)
  const items = await Promise.all(rows.map(async (r) => {
    const text = await deps.cipher.decrypt(r.content_enc).catch(() => '')
    const t = parseTask(r, text)
    return {
      id: r.id, name: r.name, enabled: r.enabled, device_id: r.device_id,
      to: r.to_number, text, sim_slot: r.sim_slot,
      schedule: t ? t.schedule : null,
      schedule_text: t ? describeSchedule(t.schedule) : '配置损坏',
      last_run_at: r.last_run_at, last_status: r.last_status, fail_count: r.fail_count,
      next_run_at: t && r.enabled ? taskNextRun(t, tz) : null,
      created_at: r.created_at,
    }
  }))
  json(res, 200, { tasks: items, timezone: tz })
  // bot 作用域：/tasks 就在 Bot 注册的命令菜单里，不给它权限的后果是
  // 「用户能点、点了一个字都不回」——彻底的沉默，而且日志之外无从察觉。
  // 开放面与已有的 /events、/outbound 同级（都会解出正文）
}, true, false, 'bot')

route('POST', '/api/tasks', async ({ user, res, body, deps, ip }) => {
  const b = body as Record<string, unknown>
  const sched = Schedule.safeParse(b.schedule)
  if (!sched.success) {
    return json(res, 400, { error: '排期配置不合法', detail: sched.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) })
  }

  const to = String(b.to ?? '').trim()
  const enabled = b.enabled === true
  if (enabled && !to) return json(res, 400, { error: '启用时必须填目标号码' })

  const deviceId = String(b.device_id ?? '')
  if (deviceId && !(await deps.store.getDevice(deviceId))) {
    return json(res, 400, { error: '指定的设备不存在' })
  }

  const id = String(b.id ?? '') || newId('task')
  const existing = await deps.store.getTask(id, user.id)
  await deps.store.upsertTask({
    id, user_id: user.id,
    name: String(b.name ?? '').trim() || '未命名任务',
    enabled, device_id: deviceId, to_number: to,
    content_enc: await deps.cipher.encrypt(String(b.text ?? '')),
    sim_slot: simSlotOf(b.sim_slot),
    schedule_json: JSON.stringify(sched.data),
    last_run_at: existing?.last_run_at ?? null,
    last_status: existing?.last_status ?? null,
    fail_count: existing?.fail_count ?? 0,
    created_at: existing?.created_at ?? now(),
  })
  await deps.store.audit({
    actor: 'admin', action: existing ? 'task.update' : 'task.create',
    detail: `${id} ${describeSchedule(sched.data)}`, ip, created_at: now(),
  })
  json(res, 200, { id })
})

route('DELETE', '/api/tasks/:id', async ({ user, res, params, deps, ip }) => {
  await deps.store.deleteTask(params.id!, user.id)
  await deps.store.audit({ actor: 'admin', action: 'task.delete', detail: params.id!, ip, created_at: now() })
  json(res, 200, { ok: true })
})

/**
 * 立即测试。走与定时执行完全相同的代码路径——否则「测得通」不代表「定时能通」。
 * 不推进排期、不计入失败统计。
 */
route('POST', '/api/tasks/:id/test', async ({ user, res, params, deps, ip }) => {
  if (!deps.runTask) return json(res, 500, { error: '未接入计划任务' })
  const row = await deps.store.getTask(params.id!, user.id)
  if (!row) return json(res, 404, { error: '任务不存在' })

  const task = parseTask(row, await deps.cipher.decrypt(row.content_enc))
  if (!task) return json(res, 400, { error: '任务配置损坏' })

  const r = await deps.runTask(task)
  await deps.store.audit({
    actor: 'admin', action: 'task.test',
    detail: `${row.name} ${r.sent ? '已下发' : (r.reason ?? '失败')}`, ip, created_at: now(),
  })
  json(res, r.sent ? 200 : 400, r)
})

// ── 通知捕获 ────────────────────────────────────────────────

const S_NOTIFY_CAPTURE = 'notification_capture'

export interface NotifyCaptureConfig {
  enabled: boolean
  scope: 'all' | 'selected'
  packages: string[]
}
export const DEFAULT_NOTIFY_CAPTURE: NotifyCaptureConfig = { enabled: false, scope: 'selected', packages: [] }

/** 通知捕获范围按用户存：它同样随 hello_ack 下发到设备。 */
export async function loadNotifyCapture(store: Store, userId: string): Promise<NotifyCaptureConfig> {
  const raw = await store.getUserSetting(userId, S_NOTIFY_CAPTURE)
  if (!raw) return DEFAULT_NOTIFY_CAPTURE
  try {
    const p = JSON.parse(raw) as Partial<NotifyCaptureConfig>
    return {
      enabled: p.enabled === true,
      scope: p.scope === 'all' ? 'all' : 'selected',
      packages: Array.isArray(p.packages) ? p.packages.filter((x) => typeof x === 'string').slice(0, 200) : [],
    }
  } catch {
    return DEFAULT_NOTIFY_CAPTURE
  }
}

route('GET', '/api/notify-capture', async ({ user, res, deps }) => {
  json(res, 200, await loadNotifyCapture(deps.store, user.id))
})

route('POST', '/api/notify-capture', async ({ user, res, body, deps, ip }) => {
  const b = body as Partial<NotifyCaptureConfig>
  const cfg: NotifyCaptureConfig = {
    enabled: b.enabled === true,
    scope: b.scope === 'all' ? 'all' : 'selected',
    packages: Array.isArray(b.packages)
      ? [...new Set(b.packages.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 128))].slice(0, 200)
      : [],
  }
  if (cfg.enabled && cfg.scope === 'selected' && cfg.packages.length === 0) {
    // 选择模式下空白名单等于不捕获，直接拒绝比让用户以为开了却没反应好
    return json(res, 400, { error: '「仅选定应用」模式下至少要选一个，否则不会捕获任何通知' })
  }
  await deps.store.setUserSetting(user.id, S_NOTIFY_CAPTURE, JSON.stringify(cfg))
  await deps.store.audit({
    actor: 'admin', action: 'notify_capture.set',
    detail: !cfg.enabled ? '已停用' : cfg.scope === 'all' ? '全部应用' : `${cfg.packages.length} 个应用`,
    ip, created_at: now(),
  })
  // 配置变更后立刻重连设备，让新配置马上生效而不是等下次握手
  if (deps.reconnectDevices) deps.reconnectDevices()
  json(res, 200, { ok: true })
})

/**
 * 导入手机里已有的历史短信与通话。
 *
 * 实时捕获只能看见「启用之后」发生的事，装网关之前的记录躺在手机本地。
 * 导入的记录只归档不推送——几千条旧短信照常推送就是几千条通知。
 */
route('POST', '/api/devices/:id/import-history', async ({ user, res, params, body, deps, ip }) => {
  if (!deps.importHistory) return json(res, 500, { error: '未接入' })
  if (!(await ownedDevice(deps, user.id, params.id!))) return json(res, 404, { error: '设备不存在' })
  const b = body as { days?: number; limit?: number }
  const days = Number(b?.days)
  // days<=0 或没给表示不限时间
  const since = Number.isFinite(days) && days > 0 ? now() - days * 86_400_000 : null
  const limit = Math.min(Math.max(Number(b?.limit) || 1000, 1), 5000)

  /**
   * 导入的记录会不会一进来就被保留上限删掉？先算，再问。
   *
   * 导入的 `occurred_at` 是短信原本的时间，所以在「保留最新 N 条」的排序里
   * 它们必然排在最末——**第一批被删的就是它们**。而整条链上没有任何一处
   * 会告诉用户这件事：导入接口返回的是「手机读了多少条」，清理只写服务端
   * 日志，导入的事件又只归档不推送。用户看到「导入成功 3000 条」，
   * 一两小时后列表里什么都没多，他会认为是网关把他的历史弄丢了。
   *
   * 所以在**下发指令之前**拦一道，协议和保留上限那边保持一致：
   * 有冲突就回 409 带上数字，界面问过人再带 confirm 来。
   */
  const cfg = parseRetention(await deps.store.getUserSetting(user.id, RETENTION_SETTING))
  const conflicts: Record<string, { limit: number; count: number }> = {}
  for (const kind of RETAINABLE_KINDS) {
    if (kind === 'notification') continue     // 导入只涉及短信与通话
    if (cfg[kind] <= 0) continue
    const count = await deps.store.countEventsByKind(user.id, kind)
    // 已经顶到上限，或者这一批导进来必然溢出
    if (count + limit > cfg[kind]) conflicts[kind] = { limit: cfg[kind], count }
  }
  if (Object.keys(conflicts).length > 0 && (b as { confirm?: boolean })?.confirm !== true) {
    return json(res, 409, {
      error: '导入的历史记录会被保留上限删掉',
      retention_conflict: conflicts,
    })
  }

  const r = await deps.importHistory(params.id!, since, limit)
  if (!r.ok) return json(res, 502, { error: r.error ?? '导入失败' })
  await deps.store.audit({
    actor: 'admin', action: 'device.import_history',
    detail: `${params.id} ${since ? `最近 ${days} 天` : '全部'} 上限 ${limit}`,
    ip, created_at: now(),
  })
  json(res, 200, r.result)
})

/**
 * 与手机对齐：手机有网关没有的补进来，网关有手机已经没有的删掉。
 *
 * 删除方向是不可逆的，所以默认只出计划不动手（`apply` 为 false 时返回将要删什么），
 * 由界面确认后再调一次带 `apply` 的。
 *
 * 安全边界全部在 core/fingerprint.ts 的 planReconcile 里，这里只负责取数据。
 */
route('POST', '/api/devices/:id/reconcile', async ({ user, res, params, body, deps, ip }) => {
  if (!deps.importHistory || !deps.listFingerprints) return json(res, 500, { error: '未接入' })
  if (!(await ownedDevice(deps, user.id, params.id!))) return json(res, 404, { error: '设备不存在' })
  const b = body as { days?: number; limit?: number; apply?: boolean }
  const days = Number(b?.days)
  const since = Number.isFinite(days) && days > 0 ? now() - days * 86_400_000 : null
  const limit = Math.min(Math.max(Number(b?.limit) || 2000, 1), 20000)
  const id = params.id!

  // 第一步：把手机上有、网关没有的补进来（只归档不推送，见 HistoryImporter）
  const imp = await deps.importHistory(id, since, limit)
  if (!imp.ok) return json(res, 502, { error: imp.error ?? '同步失败' })

  // 第二步：问手机「你现在还有哪些」
  const fps = await deps.listFingerprints(id, since, limit)
  if (!fps.ok) return json(res, 502, { error: fps.error ?? '读取手机记录失败' })

  // 第三步：把网关里这台设备的短信与通话拿出来算指纹
  const rows = await deps.store.listEvents({
    user_id: user.id,
    device_id: id,
    ...(since !== null ? { since } : {}),
    limit: 50_000, offset: 0,
  })
  const gatewayEvents = await Promise.all(
    rows
      // 应用通知不在手机的短信/通话库里，拿它去比对等于全判成「已删除」
      .filter((e) => e.kind === 'sms' || e.kind === 'call')
      .map(async (e) => ({
        id: e.id,
        kind: e.kind,
        occurred_at: e.occurred_at,
        fp: await eventFingerprint(
          e.kind,
          await deps.cipher.decrypt(e.sender_enc),
          await deps.cipher.decrypt(e.content_enc),
        ),
      })),
  )

  // 上界留 60 秒余量：刚收到、还没落进手机库的那条不能被判成「已删除」
  const plan = planReconcile(gatewayEvents, fps.items ?? [], { until: now() - 60_000 })

  if (b?.apply !== true) {
    // 预览：把要删的挑几条出来，让人看清删的是什么再决定
    const preview = await Promise.all(
      plan.stale.slice(0, 5).map(async (sid) => {
        const e = await deps.store.getEvent(sid, user.id)
        if (!e) return null
        return {
          from: await deps.cipher.decrypt(e.sender_enc),
          content: (await deps.cipher.decrypt(e.content_enc)).slice(0, 40),
          occurred_at: e.occurred_at,
        }
      }),
    )
    return json(res, 200, {
      imported: imp.result,
      phone_count: fps.items?.length ?? 0,
      truncated: fps.truncated ?? false,
      stale: plan.stale.length,
      window: plan.window,
      reason: plan.reason ?? null,
      preview: preview.filter(Boolean),
    })
  }

  let deleted = 0
  for (const sid of plan.stale) {
    if (await deps.store.deleteEvent(sid, user.id)) deleted++
  }
  if (deleted > 0) {
    log.warn('镜像同步删除了手机上已不存在的记录', { device_id: id, deleted })
    await deps.store.audit({
      actor: 'admin', action: 'device.reconcile',
      detail: `${id} 删除 ${deleted} 条（手机上已不存在）`, ip, created_at: now(),
    })
  }
  json(res, 200, { imported: imp.result, deleted, window: plan.window })
})

/** 让设备列出已安装应用，供控制台挑选。 */
route('POST', '/api/devices/:id/apps', async ({ user, res, params, deps }) => {
  if (!deps.listApps) return json(res, 500, { error: '未接入' })
  if (!(await ownedDevice(deps, user.id, params.id!))) return json(res, 404, { error: '设备不存在' })
  const r = await deps.listApps(params.id!)
  if (!r.ok) return json(res, 502, { error: r.error ?? '查询失败' })
  json(res, 200, r.apps)
})

// ── 短信指令 ────────────────────────────────────────────────

const S_SMS_COMMAND = 'sms_command'

const DEFAULT_SMS_COMMAND: SmsCommandConfig = {
  enabled: false, secret: '', allow_numbers: [], reply: true,
}

/**
 * 短信指令配置。**按用户存**，不是全局的。
 *
 * 这份配置里有口令明文，而它会经 hello_ack 下发到每一台设备。
 * 存成全局的话，任意一个登录用户都能读到口令、把自己的号码加进白名单，
 * 再发一条短信查别人手机的定位——开放注册之后这是一条现成的提权路径。
 */
export async function loadSmsCommand(store: Store, userId: string): Promise<SmsCommandConfig> {
  const raw = await store.getUserSetting(userId, S_SMS_COMMAND)
  if (!raw) return DEFAULT_SMS_COMMAND
  const p = SmsCommandConfig.safeParse(JSON.parse(raw))
  return p.success ? p.data : DEFAULT_SMS_COMMAND
}

/** 口令由服务端生成：用户自己起的口令挡不住穷举，而这条链路上口令是唯一凭证。 */
const newSecret = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(9)))
    .map((b) => SECRET_ALPHABET[b % SECRET_ALPHABET.length])
    .join('')
// 去掉 0/O/1/l/I：口令要靠手打进短信，形近字符会让人白试几次
const SECRET_ALPHABET = 'abcdefghjkmnpqrstuvwxyzACDEFGHJKLMNPQRSTUVWXYZ23456789'

route('GET', '/api/sms-command', async ({ user, res, deps }) => {
  json(res, 200, await loadSmsCommand(deps.store, user.id))
})

route('POST', '/api/sms-command', async ({ user, res, body, deps, ip }) => {
  const b = body as Partial<SmsCommandConfig> & { regenerate?: boolean }
  const cur = await loadSmsCommand(deps.store, user.id)
  const cfg: SmsCommandConfig = {
    enabled: b.enabled === true,
    secret: b.regenerate || !cur.secret ? newSecret() : cur.secret,
    allow_numbers: Array.isArray(b.allow_numbers)
      ? [...new Set(b.allow_numbers
          .filter((x): x is string => typeof x === 'string')
          .map((x) => x.replace(/[\s-]/g, ''))
          .filter((x) => x.length > 0 && x.length <= 32))].slice(0, 20)
      : cur.allow_numbers,
    reply: b.reply !== false,
  }
  await deps.store.setUserSetting(user.id, S_SMS_COMMAND, JSON.stringify(cfg))
  await deps.store.audit({
    user_id: user.id, actor: user.name, action: 'sms_command.set',
    // 口令本身不写进审计
    detail: `${cfg.enabled ? '启用' : '停用'}${b.regenerate ? '，已重置口令' : ''}，白名单 ${cfg.allow_numbers.length} 个`,
    ip, created_at: now(),
  })
  if (deps.reconnectDevices) deps.reconnectDevices()
  json(res, 200, cfg)
})

// ── 电量告警 ────────────────────────────────────────────────

/**
 * 消息保留上限。
 *
 * GET 一并把**当前条数**给出来，好让界面在下调之前算出「会删掉多少条」——
 * 这个数字是这个功能唯一的刹车。只给一个下拉让人选 999，他不会知道
 * 那意味着当场少掉三万条。
 */
route('GET', '/api/retention', async ({ user, res, deps }) => {
  const cfg = parseRetention(await deps.store.getUserSetting(user.id, RETENTION_SETTING))
  const counts: Record<string, number> = {}
  for (const k of RETAINABLE_KINDS) counts[k] = await deps.store.countEventsByKind(user.id, k)
  counts.outbound = await deps.store.countOutbound({ user_id: user.id })
  json(res, 200, { retention: cfg, counts, choices: RETENTION_CHOICES })
})

route('POST', '/api/retention', async ({ user, res, body, deps, ip }) => {
  const b = body as { retention?: unknown; confirm?: boolean }
  const next = sanitizeRetention(b?.retention)
  const prev = parseRetention(await deps.store.getUserSetting(user.id, RETENTION_SETTING))

  /**
   * 会删东西的改动要带 confirm。
   *
   * 「会不会删」不看上限有没有变小，看**当前条数有没有超过新上限**：
   * 从不限制改成 5000，听起来是放宽，但只有 300 条的人一条都不会掉，
   * 而有 8 万条的人当场掉 7.5 万。前端先 GET 拿到条数算一遍，
   * 这里再独立算一遍——前端算的那次只是给人看的，不能当成授权。
   */
  const willDelete: Record<string, number> = {}
  let total = 0
  for (const k of RETENTION_KEYS) {
    if (next[k] <= 0) continue
    const n = k === 'outbound'
      ? await deps.store.countOutbound({ user_id: user.id })
      : await deps.store.countEventsByKind(user.id, k)
    const over = Math.max(n - next[k], 0)
    if (over > 0) { willDelete[k] = over; total += over }
  }
  if (total > 0 && b?.confirm !== true) {
    return json(res, 409, { error: '这个设置会删除历史消息，需要确认', will_delete: willDelete, total })
  }

  await deps.store.setUserSetting(user.id, RETENTION_SETTING, serializeRetention(next))

  /**
   * 保存即执行，不等那个每小时一次的周期任务。
   *
   * 按钮上写的是「保存并删除 201 条」——保存完一小时内什么都不发生，
   * 人会以为没生效，然后再点一次、再选一次，甚至怀疑设置没存上。
   * 删不完的（十几万行那种）交给周期任务续，这里如实告诉他还在继续。
   */
  const trimmed = await trimUserNow({
    listUsers: () => deps.store.listUsers(),
    getUserSetting: (u, k) => deps.store.getUserSetting(u, k),
    countEventsByKind: (u, k) => deps.store.countEventsByKind(u, k),
    trimEvents: (u, k, keep, batch, before) => deps.store.trimEvents(u, k, keep, batch, before),
    countOutbound: (flt) => deps.store.countOutbound(flt),
    trimOutbound: (u, keep, batch, before) => deps.store.trimOutbound(u, keep, batch, before),
  }, user.id)

  const actually = RETENTION_KEYS.reduce((n, k) => n + trimmed.deleted[k], 0)
  await deps.store.audit({
    user_id: user.id, actor: user.name, action: 'retention.set',
    detail: RETENTION_KEYS.map((k) => `${k}=${next[k] || '不限'}`).join(' ')
      + (actually > 0 ? ` 已删除 ${actually} 条` : ''),
    ip, created_at: now(),
  })
  log.warn('保留上限已更改', { user: user.name, prev, next, deleted: trimmed.deleted, done: trimmed.done })
  json(res, 200, { retention: next, will_delete: willDelete, total, deleted: actually, done: trimmed.done })
})

route('GET', '/api/battery-alerts', async ({ user, res, deps }) => {
  json(res, 200, await loadBatteryConfig(deps.store, user.id))
})

route('POST', '/api/battery-alerts', async ({ user, res, body, deps, ip }) => {
  const b = body as Record<string, unknown>
  const clamp = (v: unknown) => {
    const n = Number(v)
    return Number.isFinite(n) && n >= 0 && n <= 100 ? Math.round(n) : 0
  }
  const cfg = {
    low: clamp(b.low),
    full: clamp(b.full),
    notify_charging_change: b.notify_charging_change === true,
  }
  if (cfg.full > 0 && cfg.low > 0 && cfg.full <= cfg.low) {
    return json(res, 400, { error: '满电阈值必须高于低电量阈值' })
  }
  await deps.store.setUserSetting(user.id, BATTERY_SETTING_KEY, JSON.stringify(cfg))
  await deps.store.audit({ actor: 'admin', action: 'battery_alerts.set', detail: JSON.stringify(cfg), ip, created_at: now() })
  json(res, 200, { ok: true })
})

// ── 时区 ────────────────────────────────────────────────────

const S_TIMEZONE = 'timezone'
/** 默认东京：这套系统的典型场景就是人在日本、卡在国内。 */
const DEFAULT_TZ = DEFAULT_TIMEZONE

/** 时区按用户存：两个人可能不在同一个国家，而规则时段与任务排期都按它算。 */
export async function timezone(store: Store, userId: string): Promise<string> {
  return (await store.getUserSetting(userId, S_TIMEZONE)) ?? DEFAULT_TZ
}

route('GET', '/api/timezone', async ({ user, res, deps }) => {
  json(res, 200, { timezone: await timezone(deps.store, user.id) })
})

route('POST', '/api/timezone', async ({ user, res, body, deps, ip }) => {
  const tz = String((body as { timezone?: string })?.timezone ?? '').trim()
  // 用 Intl 自己校验，比维护一份时区白名单可靠
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
  } catch {
    return json(res, 400, { error: '无效的时区名称' })
  }
  await deps.store.setUserSetting(user.id, S_TIMEZONE, tz)
  await deps.store.audit({ user_id: user.id, actor: user.name, action: 'timezone.set', detail: tz, ip, created_at: now() })
  json(res, 200, { ok: true })
})

// ── 总览统计 ────────────────────────────────────────────────

route('GET', '/api/stats', async ({ user, res, deps }) => {
  const devices = await deps.store.listDevices(user.id)
  const online = new Set(deps.hub.onlineDevices())
  const dayAgo = now() - 86_400_000

  const todayEvents = (await deps.store.listEvents({ user_id: user.id, limit: 500, offset: 0, since: dayAgo })).length
  const outbound = await deps.store.listOutbound(200, 0, { user_id: user.id })
  const todayOutbound = outbound.filter((o) => o.created_at >= dayAgo)

  json(res, 200, {
    devices: devices.map((d) => ({
      id: d.id, name: d.name,
      status: d.status === 'revoked' ? 'revoked' : online.has(d.id) ? 'online' : 'offline',
      last_seen_at: d.last_seen_at, battery: d.battery, charging: d.charging,
      net: parseNet(d.net_json),
      app_version: d.app_version,
    })),
    today: {
      events: todayEvents,
      outbound: todayOutbound.length,
      outbound_failed: todayOutbound.filter((o) => o.status === 'failed').length,
    },
    channels: (await deps.store.listChannels(user.id)).filter((c) => c.enabled).length,
    rules: (await deps.store.listRules(user.id)).filter((r) => r.enabled).length,
    /**
     * 上手清单的三个信号。
     *
     * 都要「曾经」而不是「今天」：今日事件为 0 只说明今天安静，
     * 不说明这条链路没通过。第一次跑通之后这个清单就不再出现，
     * 而判断「跑通过没有」只能看历史。
     */
    onboarding: {
      paired: devices.some((d) => d.status !== 'revoked'),
      channel_tested: (await deps.store.getUserSetting(user.id, S_CHANNEL_TESTED)) !== null,
      got_event: (await deps.store.countEvents({ user_id: user.id })) > 0,
    },
  })
}, true, false, 'bot')

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

route('POST', '/api/outbound', async ({ user, res, body, deps, ip }) => {
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
    id, user_id: user.id, device_id: b.device_id, to_number: b.to,
    content_enc: await deps.cipher.encrypt(b.text),
    sim_slot: simSlotOf(b.sim_slot),
    status: 'pending', error: null, created_at: t, updated_at: t,
  })

  const frame = makeFrame('cmd', {
    cmd_id: id, action: 'send_sms',
    args: { to: b.to, text: b.text, sim_slot: simSlotOf(b.sim_slot) },
  }, t) as DownstreamFrame

  // 设备离线就直接失败：短信有时效性，排队几小时后再发出去
  // 往往比不发更糟（验证码早已过期，对方收到莫名其妙的回复）
  if (!deps.hub.send(b.device_id, frame)) {
    await deps.store.advanceOutbound(id, 'failed', '设备离线', now())
    return json(res, 503, { id, status: 'failed', error: '设备离线' })
  }

  await deps.store.audit({ actor: 'console', action: 'outbound.create', detail: `${id} → ${maskNumber(b.to)}`, ip, created_at: t })
  json(res, 202, { id, status: 'pending' })
}, true, false, 'bot')

route('GET', '/api/outbound/:id', async ({ user, res, params, deps }) => {
  const o = await deps.store.getOutbound(params.id!, user.id)
  // 不属于自己的一律当「不存在」，不回 403——那等于确认这条记录真的存在
  if (!o) return json(res, 404, { error: '任务不存在' })
  const dev = await deps.store.getDevice(o.device_id)
  json(res, 200, {
    id: o.id, device_id: o.device_id, device_name: dev?.name ?? o.device_id,
    to: o.to_number,
    text: await deps.cipher.decrypt(o.content_enc),
    sim_slot: o.sim_slot, sim: simLabel(simsOf(dev?.net_json), o.sim_slot),
    status: o.status, error: o.error,
    created_at: o.created_at, updated_at: o.updated_at,
  })
}, true, false, 'bot')

/** 删除一条发送记录。任务本身不会被撤回——短信早就发出去了，删的只是这条记录。 */
route('DELETE', '/api/outbound/:id', async ({ user, res, params, deps, ip }) => {
  const ok = await deps.store.deleteOutbound(params.id!, user.id)
  if (!ok) return json(res, 404, { error: '记录不存在' })
  await deps.store.audit({
    actor: 'admin', action: 'outbound.delete', detail: params.id!, ip, created_at: now(),
  })
  json(res, 200, { ok: true })
})

const OUTBOUND_STATUS = new Set(['pending', 'accepted', 'sent', 'delivered', 'failed'])

/**
 * 网关自己发出去的短信记录。
 *
 * 与 /api/events 不同，这里的筛选全部走 SQL：收件人号码是明文列，
 * 只有正文是密文——而按正文搜发件记录几乎没有场景，就不做了。
 */
route('GET', '/api/outbound', async ({ user, res, url, deps }) => {
  const q = url.searchParams
  const limit = Math.min(Math.max(Number(q.get('limit') ?? 50), 1), 200)
  const offset = Math.max(Number(q.get('offset') ?? 0), 0)
  const status = q.get('status')
  const filter = {
    user_id: user.id,
    device_id: q.get('device') || null,
    status: status && OUTBOUND_STATUS.has(status) ? (status as OutboundRecord['status']) : null,
    to: q.get('to')?.trim() || null,
  }
  const [rows, total] = await Promise.all([
    deps.store.listOutbound(limit, offset, filter),
    deps.store.countOutbound(filter),
  ])
  const devs = await deps.store.listDevices(user.id)
  const names = new Map(devs.map((d) => [d.id, d.name]))
  const sims = new Map(devs.map((d) => [d.id, simsOf(d.net_json)]))
  json(res, 200, {
    total,
    outbound: await Promise.all(rows.map(async (o) => ({
      id: o.id, device_id: o.device_id, device_name: names.get(o.device_id) ?? o.device_id,
      to: o.to_number,
      text: await deps.cipher.decrypt(o.content_enc),
      sim_slot: o.sim_slot, sim: simLabel(sims.get(o.device_id) ?? [], o.sim_slot),
      status: o.status, error: o.error, created_at: o.created_at, updated_at: o.updated_at,
    }))),
  })
}, true, false, 'bot')

/** 审计日志里不写完整号码。 */
const maskNumber = (n: string): string =>
  n.length <= 5 ? '*'.repeat(n.length) : n.slice(0, 3) + '*'.repeat(n.length - 5) + n.slice(-2)

// ── 事件 ────────────────────────────────────────────────────

/**
 * 事件查询。
 *
 * 分两层过滤：
 *  - 索引列（类型、设备、时间范围）走 SQL，能利用索引也能准确计数
 *  - 正文与号码是密文，SQL 搜不了，只能取出解密后在内存里过滤
 *
 * 带关键词或号码过滤时，需要先把候选集全部解密才能知道总数与分页边界，
 * 因此设了扫描上限：超过就截断并如实告知，而不是给一个错误的总数。
 */
/**
 * 关键词检索的扫描预算。
 *
 * 号码与正文是密文，SQL 搜不了，只能逐条解密后在内存里过滤。实测（node:crypto，
 * 本机）10 万条约 1.1 秒，所以真正的约束不是「能不能扫」而是「一次请求愿意花多久」。
 *
 * 分批扫 + 时间预算，而不是一刀切的条数上限：条数上限会让「几个月前那条」
 * 永远搜不到，而且用户看不出为什么。搜不完时如实返回搜到了哪一天，
 * 让人能点「继续往更早搜」。
 */
const SCAN_BATCH = 2000
const SCAN_BUDGET_MS = 1500
const SCAN_ROW_CAP = 20_000
/** 深搜：用户明确要求往前翻时放宽，代价是这一次请求慢几秒 */
const DEEP_BUDGET_MS = 8000
const DEEP_ROW_CAP = 200_000

/**
 * 单条事件。
 *
 * 控制台原先是拉最近 200 条再在前端找——Bark 通知点进来的是几天前那条时，
 * 就会显示「消息不存在」。而 Bark 深链恰恰是这个项目最主要的入口。
 */
route('GET', '/api/events/:id', async ({ user, res, params, deps }) => {
  const e = await deps.store.getEvent(params.id!, user.id)
  if (!e) return json(res, 404, { error: '消息不存在或已删除' })
  const dev = await deps.store.getDevice(e.device_id)
  const ruleNames = new Map((await deps.store.listRules(user.id)).map((r) => [r.id, r.name]))
  json(res, 200, {
    id: e.id,
    device_id: e.device_id,
    device_name: dev?.name ?? e.device_id,
    kind: e.kind,
    direction: e.direction,
    sim_slot: e.sim_slot,
    // 标签在服务端算：「只有一张卡就什么都不显示」这条规则只该有一处实现
    sim: simLabel(simsOf(dev?.net_json), e.sim_slot),
    from: await deps.cipher.decrypt(e.sender_enc),
    content: await deps.cipher.decrypt(e.content_enc),
    occurred_at: e.occurred_at,
    received_at: e.received_at,
    matched_rules: e.matched_rules
      ? (JSON.parse(e.matched_rules) as string[]).map((id) => ruleNames.get(id) ?? id)
      : [],
  })
}, true, false, 'bot')

/** 删除单条消息。删了就没了，没有回收站——这一点在界面上要说清楚。 */
route('DELETE', '/api/events/:id', async ({ user, res, params, deps, ip }) => {
  const ok = await deps.store.deleteEvent(params.id!, user.id)
  if (!ok) return json(res, 404, { error: '消息不存在' })
  await deps.store.audit({
    actor: 'admin', action: 'event.delete', detail: params.id!, ip, created_at: now(),
  })
  json(res, 200, { ok: true })
})

/**
 * 按条件批量删除。
 *
 * 用 POST 而不是带查询串的 DELETE：一个能清空历史的操作不该出现在
 * 浏览器地址栏里，也不该被任何「预取链接」之类的行为误触发。
 *
 * 只认 SQL 能过滤的维度。关键词过滤要逐条解密，条件写错就是不可逆的批量误删。
 */
route('POST', '/api/events/bulk-delete', async ({ user, res, body, deps, ip }) => {
  const b = body as { device?: string; kind?: string; direction?: string; since?: number; until?: number; confirm?: boolean }
  if (b?.confirm !== true) return json(res, 400, { error: '缺少确认' })

  const kind = b.kind === 'sms' || b.kind === 'call' || b.kind === 'notification' ? b.kind : undefined
  const filter: EventFilter = {
    user_id: user.id,
    ...(kind ? { kind } : {}),
    ...(b.device ? { device_id: b.device } : {}),
    ...(b.direction === 'in' || b.direction === 'out' ? { direction: b.direction } : {}),
    ...(Number.isFinite(b.since) ? { since: Number(b.since) } : {}),
    ...(Number.isFinite(b.until) ? { until: Number(b.until) } : {}),
  }

  const deleted = await deps.store.deleteEvents(filter)
  const desc = Object.entries(filter).map(([k, v]) => `${k}=${String(v)}`).join(' ') || '全部'
  log.warn('批量删除消息', { deleted, filter: desc })
  await deps.store.audit({
    actor: 'admin', action: 'event.bulk_delete',
    detail: `${deleted} 条（${desc}）`, ip, created_at: now(),
  })
  json(res, 200, { deleted })
})


/**
 * 这一类被保留上限截到哪儿了。
 *
 * 加它的理由是一次很具体的误判：`exhausted`（扫完了）原来的含义是
 * 「扫到了全部历史的底」——因为在保留上限之前事件永不删除。上限生效后
 * 库底就是保留边界，而界面照旧显示「没有匹配的消息」，用户会得出
 * 「这条短信我根本没收到过」的结论，而那正是**漏报**的表现，
 * 于是整个排查方向从第一步就错了。
 *
 * 只在**确实已经在裁剪**时才返回（limit > 0 且条数已经顶到上限）。
 * 刚装一周的人最早一条也很近，但一条都没被删——给他编一个删除故事更糟。
 */
async function retentionEdge(
  deps: ApiDeps, userId: string, kind: RetainableKind | undefined,
): Promise<{ limit: number; count: number; oldest_at: number } | null> {
  if (!kind) return null
  const cfg = parseRetention(await deps.store.getUserSetting(userId, RETENTION_SETTING))
  const limit = cfg[kind] ?? 0
  if (limit <= 0) return null
  const count = await deps.store.countEventsByKind(userId, kind)
  if (count < limit) return null
  const oldest = await deps.store.oldestEventAt(userId, kind)
  return oldest === null ? null : { limit, count, oldest_at: oldest }
}

route('GET', '/api/events', async ({ user, res, url, deps }) => {
  const p = url.searchParams
  const limit = Math.min(Math.max(Number(p.get('limit') ?? 30), 1), 200)
  const offset = Math.max(Number(p.get('offset') ?? 0), 0)

  const kindParam = p.get('kind')
  const kind: 'sms' | 'call' | 'notification' | undefined =
    kindParam === 'sms' || kindParam === 'call' || kindParam === 'notification' ? kindParam : undefined
  const filter: EventFilter = {
    user_id: user.id,
    ...(kind ? { kind } : {}),
    ...(p.get('device') ? { device_id: p.get('device')! } : {}),
    ...(p.get('direction') === 'in' || p.get('direction') === 'out' ? { direction: p.get('direction') as 'in' | 'out' } : {}),
    ...(p.get('since') ? { since: Number(p.get('since')) } : {}),
    ...(p.get('until') ? { until: Number(p.get('until')) } : {}),
  }

  const q = p.get('q')?.trim().toLowerCase() ?? ''
  const from = p.get('from')?.trim().toLowerCase() ?? ''
  const needsDecryptFilter = q !== '' || from !== ''

  const allDevices = await deps.store.listDevices(user.id)
  const deviceNames = new Map(allDevices.map((d) => [d.id, d.name]))
  const deviceSims = new Map(allDevices.map((d) => [d.id, simsOf(d.net_json)]))
  // 命中规则存的是 id，直接显示等于让人对着一串 rule_3f2a... 猜是哪条
  const ruleNames = new Map((await deps.store.listRules(user.id)).map((r) => [r.id, r.name]))
  const decrypt = async (e: Awaited<ReturnType<typeof deps.store.getEvent>> & object) => ({
    id: e.id,
    device_id: e.device_id,
    device_name: deviceNames.get(e.device_id) ?? e.device_id,
    kind: e.kind,
    from: await deps.cipher.decrypt(e.sender_enc),
    content: await deps.cipher.decrypt(e.content_enc),
    occurred_at: e.occurred_at,
    received_at: e.received_at,
    direction: e.direction,
    sim_slot: e.sim_slot,
    sim: simLabel(deviceSims.get(e.device_id) ?? [], e.sim_slot),
    matched_rules: e.matched_rules
      ? (JSON.parse(e.matched_rules) as string[]).map((id) => ruleNames.get(id) ?? id)
      : [],
  })

  // 无需解密过滤时，SQL 直接分页，无论多少数据都是常数开销
  if (!needsDecryptFilter) {
    const rows = await deps.store.listEvents({ ...filter, limit, offset })
    json(res, 200, {
      events: await Promise.all(rows.map(decrypt)),
      total: await deps.store.countEvents(filter),
      limit, offset, truncated: false,
      retention: await retentionEdge(deps, user.id, kind),
    })
    return
  }

  const deep = p.get('deep') === '1'
  // 扫到哪一天为止：界面用它告诉用户「更早的还没搜」
  let scannedTo: number | null = null

  const r = await scanMatches(
    async (skip, take) => {
      const rows = await deps.store.listEvents({ ...filter, limit: take, offset: skip })
      if (rows.length > 0) scannedTo = rows[rows.length - 1]!.occurred_at
      return Promise.all(rows.map(decrypt))
    },
    (e) =>
      (q === '' || e.content.toLowerCase().includes(q) || e.from.toLowerCase().includes(q)) &&
      (from === '' || e.from.toLowerCase().includes(from)),
    {
      offset, limit,
      batch: SCAN_BATCH,
      budgetMs: deep ? DEEP_BUDGET_MS : SCAN_BUDGET_MS,
      rowCap: deep ? DEEP_ROW_CAP : SCAN_ROW_CAP,
    },
  )

  json(res, 200, {
    events: r.page,
    // 没扫完时这是「目前找到的条数」，不是总数——界面上要说清楚
    total: r.total,
    limit, offset,
    scanned: r.scanned,
    scanned_to: scannedTo,
    exhausted: r.exhausted,
    truncated: !r.exhausted,
    // exhausted 现在只代表「扫到库底」，而库底可能就是保留边界
    retention: await retentionEdge(deps, user.id, kind),
  })
}, true, false, 'bot')

// ── 会话视图 ────────────────────────────────────────────────

/**
 * 按号码归拢的会话列表 —— 控制台里那个「像短信 App 一样」的视图。
 *
 * 号码是密文，SQL 没法 GROUP BY，只能取一批出来解密后在内存里分组。
 * 所以这是**最近若干条里的会话**，不是全部历史的会话总表：
 * 要做后者得把整库解密一遍，而会话视图的用途本来就是「最近在跟谁来往」。
 * 更早的记录仍然能在会话里翻到（进去之后按号码过滤，那条路径是完整的）。
 */
const THREAD_SCAN = 1500

route('GET', '/api/threads', async ({ user, res, url, deps }) => {
  const scan = Math.min(Math.max(Number(url.searchParams.get('scan') ?? THREAD_SCAN), 100), 20_000)

  const rows = await deps.store.listEvents({ user_id: user.id, kind: 'sms', limit: scan, offset: 0 })
  const items = await Promise.all(rows.map(async (e) => ({
    from: await deps.cipher.decrypt(e.sender_enc),
    text: await deps.cipher.decrypt(e.content_enc),
    at: e.occurred_at,
    direction: (e.direction ?? 'in') as 'in' | 'out',
    device_id: e.device_id,
    sim_slot: e.sim_slot,
  })))

  // 网关自己发出去的也要出现在会话里：控制台发完一条，它就该在对话里，
  // 否则「我刚发的那条呢」只能去另一个页面找
  const sent = await deps.store.listOutbound(scan, 0, { user_id: user.id, device_id: null, status: null, to: null })
  for (const o of sent) {
    items.push({
      from: o.to_number,
      text: await deps.cipher.decrypt(o.content_enc),
      at: o.created_at,
      direction: 'out',
      device_id: o.device_id,
      sim_slot: o.sim_slot,
    })
  }

  json(res, 200, {
    threads: groupThreads(items),
    scanned: rows.length + sent.length,
    // 取满了说明更早的还有，界面据此说明这是「最近的会话」
    truncated: rows.length >= scan,
  })
}, true, false, 'bot')

/**
 * 一条会话里的全部往来。
 *
 * 事件流与网关的发送记录合并成同一条时间线——在手机上它们本来就是一条对话。
 * 号码用归一化后的键做**部分匹配**，所以 +86 前缀写法不同的记录都能捞到。
 */
route('GET', '/api/threads/:key', async ({ user, res, params, url, deps }) => {
  const key = params.key!
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 200), 1), 500)
  const scan = Math.min(Math.max(Number(url.searchParams.get('scan') ?? 8000), 100), 200_000)

  const rows = await deps.store.listEvents({ user_id: user.id, kind: 'sms', limit: scan, offset: 0 })
  const events: ThreadItem[] = []
  let number = ''
  for (const e of rows) {
    const from = await deps.cipher.decrypt(e.sender_enc)
    if (threadKey(from) !== key) continue
    if (!number) number = from
    events.push({
      id: e.id,
      direction: (e.direction ?? 'in') as 'in' | 'out',
      text: await deps.cipher.decrypt(e.content_enc),
      at: e.occurred_at,
      source: 'event',
      sim_slot: e.sim_slot,
      device_id: e.device_id,
    })
    if (events.length >= limit) break
  }

  const outbound: ThreadItem[] = []
  // 号码里可能带空格与横杠（「+86 138 0013 8000」），SQL 的 LIKE 匹配不上归一化后的键，
  // 只能取一批回来逐条归一化再比
  for (const o of await deps.store.listOutbound(scan, 0, { user_id: user.id, device_id: null, status: null, to: null })) {
    if (threadKey(o.to_number) !== key) continue
    if (!number) number = o.to_number
    outbound.push({
      id: o.id, direction: 'out',
      text: await deps.cipher.decrypt(o.content_enc),
      at: o.created_at, source: 'outbound',
      status: o.status, error: o.error,
      sim_slot: o.sim_slot, device_id: o.device_id,
    })
  }

  if (events.length === 0 && outbound.length === 0) {
    return json(res, 404, { error: '这个号码没有往来记录' })
  }

  const devs = await deps.store.listDevices(user.id)
  const names = new Map(devs.map((d) => [d.id, d.name]))
  const sims = new Map(devs.map((d) => [d.id, simsOf(d.net_json)]))
  const items = mergeThread(events, outbound).map((x) => ({
    ...x,
    device_name: x.device_id ? names.get(x.device_id) ?? x.device_id : null,
    sim: simLabel(x.device_id ? sims.get(x.device_id) ?? [] : [], x.sim_slot),
  }))

  json(res, 200, {
    key, number,
    items,
    // 最近一条收到的消息决定「回复」用哪台设备哪张卡：
    // 多卡场景下从别的卡回过去，对方看到的是陌生号码
    reply_device: [...items].reverse().find((x) => x.direction === 'in')?.device_id ?? null,
    reply_sim: [...items].reverse().find((x) => x.direction === 'in')?.sim_slot ?? null,
    truncated: rows.length >= scan,
  })
}, true, false, 'bot')

// ── 分发 ────────────────────────────────────────────────────

export async function handleApi(req: IncomingMessage, res: ServerResponse, deps: ApiDeps): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (!url.pathname.startsWith('/api/')) return false

  const match = routes.find((r) => r.method === (req.method ?? 'GET') && r.pattern.test(url.pathname))
  // 未匹配的 /api/* 返回 404 而不是 405，不泄漏有哪些路由存在
  if (!match) { json(res, 404, { error: 'not found' }); return true }

  const ip = resolveClientIp(req, deps.trustedProxy ?? null)

  // 未完成初始化时，除向导外一切拒绝（计划 §12.1①）
  if (!match.setup && !(await isInitialized(deps.store))) {
    json(res, 403, { error: '服务端尚未完成初始化，请先访问控制台完成配置向导' })
    return true
  }

  let user = ANON
  if (match.auth) {
    const who = await checkAuth(req, deps, ip, match.scope)
    if (!who) {
      // 未认证一律 404，不返回 401——不确认接口存在（计划 §6.3）
      json(res, 404, { error: 'not found' })
      return true
    }
    user = who
  }

  const m = match.pattern.exec(url.pathname)!
  const params: Record<string, string> = {}
  match.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]!) })

  let body: unknown = null
  if (req.method === 'POST' || req.method === 'PUT') {
    try {
      body = await readJson(req, BIG_BODY_PATHS.includes(url.pathname) ? MAX_BODY_IMPORT : MAX_BODY)
    } catch (e) {
      // 「太大」和「写坏了」必须分开说：两者的下一步完全不同
      const tooBig = e instanceof BodyTooLarge
      json(res, tooBig ? 413 : 400, {
        error: tooBig
          ? `请求体超过 ${Math.round((e as BodyTooLarge).limit / 1024)} KB 上限`
          : '请求体不是合法 JSON',
      })
      return true
    }
  }

  try {
    await match.handler({ req, res, url, params, body, deps, ip, user })
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
async function checkAuth(req: IncomingMessage, deps: ApiDeps, ip: string, scope: Scope): Promise<UserRecord | null> {
  const h = req.headers.authorization
  if (!h?.startsWith('Bearer ')) return null
  const presented = h.slice(7)

  // Bot 的 service token 只在标记为 bot scope 的路由上有效。
  // 每个用户一个 token，据此定位主人——Bot 取到的只能是自己主人的数据
  if (scope === 'bot') {
    const owner = await deps.store.getUserByBotToken(presented)
    // 账号停用或到期，Bot 这条路也要断——它完全不走会话逻辑，是独立的一条
    if (userActive(owner, now())) return owner
  }

  const sess = await deps.store.getSession(await hashToken(presented))
  if (sess) {
    const t = now()
    if (sess.revoked || sess.expires_at < t) return null
    if (!timingSafeEqual(sess.ua_hash, await hashToken(req.headers['user-agent'] ?? ''))) {
      log.warn('会话 UA 不匹配，已拒绝', { ip })
      return null
    }
    // 受信任的会话不校验 IP 段：手机在 WiFi 与流量之间切换、换个基站，
    // IP 段就变了，严格绑定会让「保持登录」名存实亡。UA 绑定仍然保留。
    if (!sess.trusted && sess.ip_prefix !== ipPrefix(ip)) {
      log.warn('会话 IP 段不匹配，已拒绝', { ip })
      return null
    }
    const owner = await deps.store.getUser(sess.user_id)
    // 账号被删、被停用、或到期时，手里的会话立刻作废。
    // 只在登录处判是不够的：会话最长 30 天且每次访问滑动顺延，
    // 到期那一刻用户手里多半正攥着一个有效会话
    if (!userActive(owner, now())) return null
    await deps.store.touchSession(sess.token_hash, t + (sess.trusted ? TRUSTED_SESSION_TTL_MS : SESSION_TTL_MS))
    return owner
  }

  // 应急用的长期管理 token（GW_ADMIN_TOKEN / data/admin.token）。
  // 它代表「机器的主人」，落到第一个管理员账号上
  if (timingSafeEqual(presented, deps.adminToken)) {
    // 同样要过 userActive：一个到期的管理员账号不该因为有应急 token 就复活
    const admins = (await deps.store.listUsers()).filter((u) => u.role === 'admin' && userActive(u, now()))
    return admins[0] ?? null
  }
  return null
}

const MAX_BODY = 256 * 1024
/**
 * 配置导入要放宽。
 *
 * 规则编辑器鼓励人多填关键词（tagInput），一份规则多、关键词长的配置
 * 很容易越过 256KB。而超限和 JSON 语法错误如果报成同一句话，
 * 用户看到的是「你的文件格式不对」——**而那个文件是这台机器自己导出的**。
 */
const MAX_BODY_IMPORT = 4 * 1024 * 1024
const BIG_BODY_PATHS = ['/api/backup/config']

/** 超限单独成一个错误类型，好让调用方把它和「JSON 写坏了」分开报 */
class BodyTooLarge extends Error {
  constructor(readonly limit: number) { super('body too large') }
}

function readJson(req: IncomingMessage, limit = MAX_BODY): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0
    let over = false
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (over) {
        /**
         * 已经超限了，但**要把剩下的读完再回**，只是不再往内存里放。
         *
         * 直接 destroy 的话，还在上传的客户端会先撞上写失败（ECONNRESET），
         * 而那个错误会盖掉我们已经发出去的 413——用户看到「连接断了」，
         * 比看到「文件太大」难排查得多。
         *
         * 但也不能无限读下去：超过上限十倍就认定对面不怀好意，直接断。
         */
        if (size > limit * 10) req.destroy()
        return
      }
      if (size > limit) { over = true; reject(new BodyTooLarge(limit)); return }
      chunks.push(c)
    })
    req.on('end', () => {
      if (over) return
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw.trim()) return resolve(null)
      try { resolve(JSON.parse(raw)) } catch (e) { reject(e as Error) }
    })
    // 超限之后我们自己 destroy 会触发 error，那时 promise 早已 reject 过，忽略即可
    req.on('error', (e) => { if (!over) reject(e) })
  })
}
