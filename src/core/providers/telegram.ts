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
import { describeFetchError } from '../neterror.js'

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
      throw new ProviderError('telegram', `网络错误: ${describeFetchError(e)}`)
    })

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      // 4xx 多为配置错误（token 失效、chat_id 不对），重试无意义；429 限流可重试。
      const retryable = res.status === 429 || res.status >= 500
      throw new ProviderError('telegram', `HTTP ${res.status}: ${detail.slice(0, 200)}`, retryable)
    }

    // 返回 message_id：用户直接引用回复这条推送时，据此反查原事件的发件人
    const body = (await res.json().catch(() => null)) as {
      result?: { message_id?: number; chat?: TelegramChat }
    } | null
    const id = body?.result?.message_id
    return {
      ref: id != null ? String(id) : undefined,
      to: describeChat(body?.result?.chat),
    }
  },
}

interface TelegramChat {
  id?: number | string
  type?: string
  title?: string
  username?: string
  first_name?: string
}

/**
 * 把 Telegram 回的 chat 对象说成一句人话。
 *
 * 用于渠道测试的回显：「已发到 @harry（私聊）」和「已发到 群「家里」」
 * 是两件完全不同的事，而后者意味着群里每个人都会收到你的银行验证码。
 * 不回显的话，这两种情况在界面上都只是一个绿色的「测试消息已发出」。
 */
function describeChat(chat: TelegramChat | undefined): string | undefined {
  if (!chat) return undefined
  const kind = chat.type === 'private' ? '私聊'
    : chat.type === 'group' || chat.type === 'supergroup' ? '群'
    : chat.type === 'channel' ? '频道'
    : chat.type ?? ''
  const who = chat.username ? `@${chat.username}`
    : chat.title ? `「${chat.title}」`
    : chat.first_name ?? String(chat.id ?? '')
  return kind ? `${who}（${kind}）` : who
}

/**
 * 一条 Telegram 消息长什么样。
 *
 * 排版规则只有一条：**归属信息在头部，逐行带标签；正文只放内容。**
 *
 * 之前是「来自: X」加上模板拼出来的「【X】正文」，同一个号码在一条消息里
 * 出现两到三次（通知类事件的正文本身还会再带一次标题），读起来全是噪音。
 * 现在发件人、卡槽、设备、时间各占一行，正文干净。
 *
 * 时间用 pipeline 按用户时区算好的 localTime，不在这里 toLocaleString——
 * 服务端跑在 UTC 容器里，那样会比 Telegram 自己的时间戳差一整个时区。
 */
export function buildText(msg: NotifyMessage, useSpoiler: boolean): string {
  const time = msg.localTime ?? new Date(msg.occurredAt).toISOString().replace('T', ' ').slice(0, 19)
  const lines: string[] = []

  if (msg.alert === true) {
    // 系统告警（设备离线、渠道故障、异地登录）：没有发件人可言，
    // 标题就是全部信息，再套一层「来自:」只会让人找不到重点。
    // 也不模糊——这里面没有短信正文，模糊了反而要多点一下才看得见。
    lines.push(`<b>${esc(msg.title)}</b> · ${esc(time)}`)
    if (msg.body) {
      // 带凭证的告警照样要模糊：找回码和银行验证码是同一类东西
      const shown = msg.sensitive && useSpoiler ? `<tg-spoiler>${esc(msg.body)}</tg-spoiler>` : esc(msg.body)
      lines.push('', shown)
    }
    return lines.join('\n')
  }

  const h = msg.kind ? HEAD[msg.kind] : HEAD.sms
  const label = msg.kind === 'sms' && msg.direction === 'out' ? '已发送' : h.label
  lines.push(`${h.icon} <b>${label}</b> · ${esc(time)}`)
  lines.push(`${msg.kind === 'sms' && msg.direction === 'out' ? '收件人' : h.field}: ${esc(msg.title)}`)
  // 卡槽与设备都只在「有歧义时」才由 pipeline 填：单卡单设备下是纯噪音
  if (msg.sim) lines.push(`SIM: ${esc(msg.sim)}`)
  if (msg.deviceName) lines.push(`设备: ${esc(msg.deviceName)}`)

  if (!msg.body) return lines.join('\n')

  // 验证码放在 spoiler 内部的首行：点开后第一眼就能看到，
  // 但在通知栏预览和 Telegram 的内容扫描里都不是明文。
  const inner = msg.code ? `🔑 ${msg.code}\n\n${msg.body}` : msg.body
  const shown = useSpoiler ? `<tg-spoiler>${esc(inner)}</tg-spoiler>` : esc(inner)
  return `${lines.join('\n')}\n\n💬 ${shown}`
}

/** 每种事件的图标与「谁」那一行的标签。来电写「号码」而不是「发件人」。 */
const HEAD: Record<'sms' | 'call' | 'notification', { icon: string; label: string; field: string }> = {
  sms: { icon: '📨', label: '新短信', field: '发件人' },
  call: { icon: '📞', label: '来电', field: '号码' },
  notification: { icon: '🔔', label: '应用通知', field: '来源' },
}
