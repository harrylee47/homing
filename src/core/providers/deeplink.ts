/**
 * 通知点击后落到控制台的哪一页。
 *
 * 单独成文件是因为 Bark 与 ntfy 要用同一套语义：同一条规则在两个渠道上
 * 点出来必须去同一个地方，否则「点通知跳哪」这件事就得在每个渠道里
 * 各记一遍。放在 bark.ts 里让 ntfy 反过来 import bark，依赖方向是错的。
 */
import type { NotifyMessage } from './types.js'

/** event=事件详情，compose=预填回复（来电场景），none=不跳转 */
export type DeepLinkMode = 'event' | 'compose' | 'none'

/** 深链指向控制台。没有配 GW_BASE_URL 时返回 null，通知点击就只是展开。 */
export function deepLink(msg: NotifyMessage, mode: DeepLinkMode): string | null {
  if (mode === 'none' || !msg.consoleUrl) return null
  const base = msg.consoleUrl.replace(/\/$/, '')
  if (mode === 'compose') {
    return `${base}/compose?to=${encodeURIComponent(msg.title)}&ref=${encodeURIComponent(msg.eventId)}`
  }
  // eventId 为空的是系统告警（离线、渠道测试），没有详情页可去，落到首页
  return msg.eventId ? `${base}/events/${encodeURIComponent(msg.eventId)}` : base
}

/**
 * 长按/点按钮复制什么。三个渠道共用这套语义。
 *
 * - `code` 复制提取出的验证码，**要求同一条规则也开了 extract_code**，
 *   否则没有码可复制，是个不报错的死配置（界面上会拦）。
 * - `body` 复制整条正文。快递单号、取件码这类不是 4-8 位数字的场景靠它。
 * - `none` 不复制。
 */
export type CopyMode = 'code' | 'body' | 'none'

export function copyText(msg: NotifyMessage, mode: CopyMode): string | null {
  if (mode === 'none') return null
  if (mode === 'body') return msg.body || null
  return msg.code || null
}
