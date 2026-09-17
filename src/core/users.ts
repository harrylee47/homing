/**
 * 账号状态的唯一判定。
 *
 * 「停用」和「到期」在系统里必须是**同一个判断**，而且必须在每一条鉴权路径上
 * 都问一遍。这不是重复劳动——这个项目已经在同一类问题上栽过一次：
 * 吊销设备时只改了状态、没作废凭证，结果断线重连就又活了（见 CLAUDE.md）。
 *
 * 账号到期有四条互不相交的绕行路径，漏一条就等于没做：
 *
 *  1. **Web 会话**：最长 30 天且每次访问滑动顺延。到期那一刻，用户手里
 *     多半正攥着一个有效会话——只在登录处判，他能接着用一个月。
 *  2. **Bot service token**：完全不走会话逻辑，是独立的一条。
 *  3. **设备 WebSocket**：握手只校验设备凭证，从不碰 users 表。而且握手
 *     一辈子只发生一次——只在握手时判，已经连着的手机会继续上报几个月。
 *     所以除了握手判断，还必须有一个周期清扫去主动断开。
 *  4. **后台循环**：保号任务（真花钱）、离线告警、Bot 轮询都是跨用户遍历的，
 *     它们只看数据归属，不看账号状态。
 *
 * 第三条是最容易漏的，也是后果最难看的一条：用户发现自己登不进控制台，
 * 但 Bark 还在响——而你会发现自己还在替一个过期账号转发别人的银行验证码。
 */

/** 判定账号是否还能用。所有鉴权路径都问这一个函数。 */
export function userActive(
  u: { disabled: boolean; expires_at?: number | null } | null | undefined,
  now: number,
): boolean {
  if (!u) return false
  if (u.disabled) return false
  return u.expires_at == null || u.expires_at > now
}

/** 不能用的原因，给界面与日志。区分两种状态是因为用户的下一步动作不同。 */
export function inactiveReason(
  u: { disabled: boolean; expires_at?: number | null },
  now: number,
): 'disabled' | 'expired' | null {
  if (u.disabled) return 'disabled'
  if (u.expires_at != null && u.expires_at <= now) return 'expired'
  return null
}

/** 还有几天到期。null = 永久；负数 = 已经过期。 */
export function daysLeft(u: { expires_at?: number | null }, now: number): number | null {
  if (u.expires_at == null) return null
  return Math.ceil((u.expires_at - now) / 86_400_000)
}
