/**
 * 公告与公开邀请码——「通知」页那一屏的规则。
 *
 * 这一块是整套系统里**唯一不需要登录就能读到的业务数据**，所以它的边界要
 * 特别清楚：公告是运营者写给所有人的，公开邀请码是运营者主动放出来的入口。
 * 除此之外一个字都不能从这里漏出去（谁生成的、备注写了什么、用掉它的是谁，
 * 都留在管理员那一侧）。
 *
 * ## 为什么公开邀请码要存明文
 *
 * 普通邀请码只存哈希：拿到码等于拿到一个能看银行验证码的账号，所以生成时
 * 那一次就是唯一一次能看到它的机会。公开码的处境正相反——它**本来就要被
 * 贴在一个谁都能打开的页面上**，再存哈希就不是安全措施，只是让它没法显示。
 *
 * 代价要说清楚：一个公开码在被用掉之前，任何看到这个页面的人都能拿它注册。
 * 所以它的默认有效期短、列表只给最近几十条、用掉与过期的都如实标出来。
 *
 * ## 为什么普通用户能生成，而且只能生成 24 小时的
 *
 * 门槛是「今天有消息进过这台网关」而不是「注册过」：前者说明这是一台真的在
 * 用的网关，后者只说明有人开过号。这道门槛挡的是「注册一个号就开始批量发码」。
 *
 * 有效期固定 24 小时、每人每天一个，都是同一个理由：公开码的风险随时间累积，
 * 而普通用户不该有能力把这个窗口开大。管理员要长效码，走管理员那条路。
 */

/** 公告标题上限。超过这个长度的标题在列表里会被折行，不如逼着写短 */
export const ANNOUNCE_TITLE_MAX = 60
/** 公告正文上限。它不是知识库，长文该放到别处再贴链接 */
export const ANNOUNCE_BODY_MAX = 2000

/** 用户自助生成的邀请码固定 24 小时，界面上不给选 */
export const SELF_INVITE_TTL_MS = 24 * 3_600_000
/** 每人每天一个。够用来拉一个人，不够用来刷 */
export const SELF_INVITE_PER_DAY = 1

/** 「通知」页最多列出多少个公开码。再多就不是入口而是列表页了 */
export const PUBLIC_INVITE_LIMIT = 40
/** 公告最多列多少条 */
export const ANNOUNCE_LIMIT = 30

/** 管理员那两张列表每页几条。邀请码与公告都会越积越长，一页摊完就没法用了 */
export const ADMIN_PAGE = 10
/** 「邀请朋友」那张卡里列出自己最近几个码 */
export const SELF_INVITE_SHOWN = 10

/**
 * 「今天」的起点。
 *
 * 用**网关配置的时区**而不是 UTC：运营者说「今日活跃」时说的是他自己那一天。
 * 服务端跑在 UTC 的容器里，直接切 UTC 零点会让东八区的人在早上八点之前
 * 都算作「昨天活跃」——恰恰是他起床看验证码的那段时间。
 *
 * `offset` 由调用方用 `schedule.ts` 的 `offsetMs(epoch, tz)` 算好传进来：
 * 那个函数按**事件发生的那一刻**现算偏移，夏令时切换当天也是对的。
 */
export function dayStart(epoch: number, offset: number): number {
  const local = epoch + offset
  return local - (local % 86_400_000) - offset
}

/** 邀请码在界面上的三种状态。过期与已用要分开——它们对读的人意味着不同的事 */
export type InviteState = 'open' | 'used' | 'expired'

export function inviteState(
  i: { used_at: number | null; expires_at: number },
  now: number,
): InviteState {
  if (i.used_at !== null) return 'used'
  return i.expires_at <= now ? 'expired' : 'open'
}

/**
 * 公告的标题与正文。两个都必填——只有标题的公告在列表里看起来像坏掉了，
 * 只有正文的没法在列表里扫。
 */
export function normalizeAnnouncement(
  input: { title?: unknown; body?: unknown },
): { title: string; body: string } | { error: string } {
  const title = typeof input.title === 'string' ? input.title.trim() : ''
  const body = typeof input.body === 'string' ? input.body.trim() : ''
  if (!title) return { error: '标题不能为空' }
  if (title.length > ANNOUNCE_TITLE_MAX) return { error: `标题最多 ${ANNOUNCE_TITLE_MAX} 字` }
  if (!body) return { error: '正文不能为空' }
  if (body.length > ANNOUNCE_BODY_MAX) return { error: `正文最多 ${ANNOUNCE_BODY_MAX} 字` }
  return { title, body }
}
