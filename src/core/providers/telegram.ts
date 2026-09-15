/**
 * Telegram Bot 渠道。
 *
 * Bot token 只存在于加密后的渠道配置里，任何日志输出都不得包含它
 * ——旧系统每 10 秒往日志里打印一次完整 token，是明确的反面教材。
 */
import { z } from 'zod'
import { ProviderError, type NotifyMessage, type Provider } from './types.js'

export const TelegramConfig = z.object({
  bot_token: z.string().min(20).max(200),
  /** 只向固定 chat_id 发送（计划 §11.4 安全约束①） */
  chat_id: z.string().min(1).max(64),
  /** 自定义 API 地址，用于自建反代 */
  api_base: z.string().url().default('https://api.telegram.org'),
})
export type TelegramConfig = z.infer<typeof TelegramConfig>

/** Telegram MarkdownV2 的保留字符，漏转义会导致整条消息发送失败。 */
const escapeMd = (s: string): string => s.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (c) => `\\${c}`)

export const telegramProvider: Provider<TelegramConfig> = {
  type: 'telegram',
  configSchema: TelegramConfig,

  async send(cfg, msg) {
    const text = buildText(msg)

    const res = await fetch(`${cfg.api_base}/bot${cfg.bot_token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: cfg.chat_id,
        text,
        parse_mode: 'MarkdownV2',
        // high 优先级才出声，普通消息静默送达，避免夜里被广告短信吵醒
        disable_notification: msg.priority !== 'high',
      }),
      signal: AbortSignal.timeout(15_000),
    }).catch((e: unknown) => {
      throw new ProviderError('telegram', `网络错误: ${String(e)}`)
    })

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      // 4xx 多为配置错误（token 失效、chat_id 不对），重试无意义；
      // 429 是限流，重试有意义。
      const retryable = res.status === 429 || res.status >= 500
      throw new ProviderError('telegram', `HTTP ${res.status}: ${detail.slice(0, 200)}`, retryable)
    }
  },
}

function buildText(msg: NotifyMessage): string {
  const lines: string[] = []
  // 验证码放第一行且加粗，手机通知栏预览里第一眼就能看到
  if (msg.code) lines.push(`🔑 *${escapeMd(msg.code)}*`)
  lines.push(`*${escapeMd(msg.title)}*`)
  lines.push(escapeMd(msg.body))
  return lines.join('\n')
}
