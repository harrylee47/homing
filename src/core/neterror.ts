/**
 * 把 fetch 失败的**真正原因**挖出来。
 *
 * Node 上 `fetch` 的拒绝值恒是 `TypeError: fetch failed`——这四个字对排查
 * 毫无帮助，而真正的原因藏在 `cause` 里。2026-09-17 就为这个付了两个小时：
 * 生产上 Telegram 每分钟失败一两次，日志里只有 "fetch failed"，看着像链路抖动；
 * 真相是 `cause.errors[]` 里写着
 * `["ETIMEDOUT/149.154.166.110", "ENETUNREACH/2001:67c:4e8:f004::9"]`——
 * 一眼就能看出是 IPv6 出口的问题，而那一行当时被整个丢掉了。
 *
 * 两种结构都要认：
 * - 单地址失败：`cause.code`（ENOTFOUND / ECONNREFUSED / ECONNRESET …）
 * - 多地址失败：`AggregateError`，`cause.errors[]` 逐个地址一条，**地址要带上**
 *   （只打 code 看不出是哪个族失败，而「哪个族」正是答案）
 *
 * 超时是例外：`AbortSignal.timeout` 拒绝的是 `TimeoutError`，**没有 cause**，
 * 此时 `String(e)` 本身就是答案，不能因为取不到 cause 就抹成空。
 */
export function describeFetchError(e: unknown): string {
  const base = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
  const cause = (e as { cause?: unknown })?.cause as
    | { code?: string; errors?: unknown[] }
    | undefined
  if (!cause || typeof cause !== 'object') return base

  const parts: string[] = []
  if (typeof cause.code === 'string') parts.push(cause.code)
  for (const sub of Array.isArray(cause.errors) ? cause.errors : []) {
    const s = sub as { code?: string; address?: string; port?: number }
    const code = typeof s?.code === 'string' ? s.code : '?'
    // 地址是 IP，不是号码也不是正文——不触及脱敏红线，而它是这里信息量最大的一项
    parts.push(s?.address ? `${code}/${s.address}` : code)
  }
  // 去重：单地址失败时 cause.code 与 errors[0].code 常常是同一个
  const uniq = [...new Set(parts)]
  return uniq.length ? `${base} (${uniq.join(', ')})` : base
}
