/**
 * Telegram Bot 渠道。
 *
 * ⚠️ 正文必须包在 <tg-spoiler> 里，且验证码不得单独明文显示。
 *
 * Telegram 的反欺诈系统会封禁转发验证码的 Bot —— 这是上一版网关踩过的坑，
 * 不是理论风险。代价是通知栏预览看不到验证码，必须点开消息再点一下才能看，
 * 「通知栏直接可见」那个体验只能留给自建的 Bark（计划 §11.3）。
 *
 * Bot token 只存在于加密后的渠道配置里，任何日志输出都不得包含它
 * —— 旧系统每 10 秒往日志里打印一次完整 token，是明确的反面教材。
 */
import { z } from 'zod'
import { ProviderError, type NotifyMessage, type Provider, type SendResult } from './types.js'

export const TelegramConfig = z.object({
  bot_token: z.string().min(20).max(200),
  /** 只向固定 chat_id 发送（计划 §11.4 安全约束①） */
  chat_id: z.string().min(1).max(64),
  /** 自定义 API 地址，用于自建反代 */
  api_base: z.string().url().default('https://api.telegram.org'),
  /**
   * 正文模糊化。默认开启，**不建议关闭**：关掉等于把验证码明文发给 Telegram，
   * Bot 被封是迟早的事，而 Bot 一封，所有通知全断。
   */
  spoiler: z.boolean().default(true),
})
export type TelegramConfig = z.infer<typeof TelegramConfig>

/** HTML 实体转义。用 HTML 而非 MarkdownV2：spoiler 标签只有 HTML 模式才有。 */
const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export const telegramProvider: Provider<TelegramConfig> = {
  type: 'telegram',
  configSchema: TelegramConfig,

  async send(cfg, msg): Promise<SendResult> {
    const res = await fetch(`${cfg.api_base}/bot${cfg.bot_token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: cfg.chat_id,
        text: buildText(msg, cfg.spoiler),
        parse_mode: 'HTML',
        // high 优先级才出声，普通消息静默送达，避免夜里被广告短信吵醒
        disable_notification: msg.priority !== 'high',
        // 不放「复制验证码」按钮：按钮文本同样是发给 Telegram 的内容，
        // 验证码只应存在于 spoiler 里面
        reply_markup: msg.consoleUrl && msg.eventId
          ? { inline_keyboard: [[{ text: '🔗 在控制台打开', url: `${msg.consoleUrl.replace(/\/$/, '')}/events/${encodeURIComponent(msg.eventId)}` }]] }
          : undefined,
      }),
      signal: AbortSignal.timeout(15_000),
    }).catch((e: unknown) => {
      throw new ProviderError('telegram', `网络错误: ${String(e)}`)
    })

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      // 4xx 多为配置错误（token 失效、chat_id 不对），重试无意义；429 限流可重试。
      const retryable = res.status === 429 || res.status >= 500
      throw new ProviderError('telegram', `HTTP ${res.status}: ${detail.slice(0, 200)}`, retryable)
    }

    // 返回 message_id：用户直接引用回复这条推送时，据此反查原事件的发件人
    const body = (await res.json().catch(() => null)) as { result?: { message_id?: number } } | null
    const id = body?.result?.message_id
    return { ref: id != null ? String(id) : undefined }
  },
}

export function buildText(msg: NotifyMessage, useSpoiler: boolean): string {
  const time = new Date(msg.occurredAt).toLocaleString('zh-CN', { hour12: false })
  const head = `📩 新消息 · ${esc(time)}\n\n来自: ${esc(msg.title)}`

  if (!msg.body) return head

  // 验证码放在 spoiler 内部的首行：点开后第一眼就能看到，
  // 但在通知栏预览和 Telegram 的内容扫描里都不是明文。
  const inner = msg.code ? `🔑 ${msg.code}\n${msg.body}` : msg.body
  const shown = useSpoiler ? `<tg-spoiler>${esc(inner)}</tg-spoiler>` : esc(inner)
  return `${head}\n\n💬 ${shown}`
}
