/**
 * Telegram Bot 的 long polling 传输层。
 *
 * 用 long polling 而不是 webhook：Bot 主动外连 Telegram，**零入站端口**；
 * webhook 需要暴露端口并配证书。本项目规模下资源开销可忽略，拓扑上干净得多
 * （计划 §11.4）。Workers 版没有常驻进程，届时改为 webhook，但命令逻辑
 * 在 core/bot.ts 里不变。
 */
import { COMMANDS, handleCallback, handleCommand, handleReply, type BotApi, type BotMessage } from '../../core/bot.js'
import { log } from '../../core/logging.js'
import type { Store } from '../../core/store.js'

export interface BotDeps {
  store: Store
  /** 自己的 API 基址，如 http://127.0.0.1:8070 */
  apiBase: string
  /** Bot 专用 service token */
  serviceToken: string
}

interface TgUpdate {
  update_id: number
  message?: {
    message_id: number
    text?: string
    chat: { id: number }
    reply_to_message?: { message_id: number }
  }
  callback_query?: {
    id: string
    data?: string
    message?: { chat: { id: number } }
  }
}

/** 同一个 bot token 被另一个进程长轮询时 Telegram 返回的状态码。 */
const HTTP_CONFLICT = 409

export class TelegramBot {
  private offset = 0
  private running = false
  private channelId = ''
  private conflictLogged = false

  constructor(
    private readonly deps: BotDeps,
    private readonly botToken: string,
    /** 白名单：只响应这些 chat_id，其余静默丢弃（计划 §11.4 安全约束①） */
    private readonly allowedChats: Set<string>,
    channelId: string,
  ) {
    this.channelId = channelId
  }

  start(): void {
    if (this.running) return
    this.running = true
    void this.registerMenu()
    void this.loop()
    log.info('Telegram Bot 已启动', { chats: this.allowedChats.size })
  }

  /**
   * 注册命令菜单，用户点输入框旁的菜单按钮即可看到全部命令。
   *
   * 到 Telegram 的链路有约 1/6 的偶发超时，一次失败就没菜单了，
   * 而这是每次启动只做一次的操作，值得重试几轮。
   */
  private async registerMenu(): Promise<void> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const ok = await fetch(`https://api.telegram.org/bot${this.botToken}/setMyCommands`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ commands: COMMANDS }),
        signal: AbortSignal.timeout(15_000),
      }).then((r) => r.ok).catch(() => false)

      if (ok) {
        log.info('Bot 命令菜单已注册', { count: COMMANDS.length })
        return
      }
      if (attempt < 3) await sleep(2000 * attempt)
    }
    log.warn('注册 Bot 命令菜单失败，不影响命令本身可用')
  }

  stop(): void {
    this.running = false
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        const updates = await this.getUpdates()
        for (const u of updates) {
          this.offset = Math.max(this.offset, u.update_id + 1)
          await this.dispatch(u).catch((e: unknown) =>
            log.error('处理 Bot 更新失败', { error: String(e) }),
          )
        }
      } catch (e) {
        if (e instanceof ConflictError) {
          // 同一个 token 只能有一个长轮询者。这不是瞬时故障，重试再快也没用，
          // 且会持续刷日志；只提示一次，然后慢速重试等对方退出。
          if (!this.conflictLogged) {
            this.conflictLogged = true
            log.error(
              'Bot token 已被另一个进程占用（Telegram 409）。' +
              '同一个 token 不能同时被两个程序长轮询——请为本网关向 @BotFather 申请独立的 Bot。' +
              '推送不受影响，仅命令交互不可用。',
              { channel_id: this.channelId },
            )
          }
          await sleep(60_000)
          continue
        }
        // 网络抖动、Telegram 限流走这里；退避后继续，不要放弃轮询。
        // 带上 cause：fetch 的顶层错误一律是 "fetch failed"，
        // 真正的原因（ENETUNREACH / ETIMEDOUT / ECONNRESET）在 cause 里，
        // 不打出来就只能靠猜。
        const cause = e instanceof Error ? (e.cause as { code?: string } | undefined)?.code : undefined
        log.warn('Bot 轮询失败', { error: String(e), cause: cause ?? null })
        await sleep(5000)
      }
    }
  }

  private async getUpdates(): Promise<TgUpdate[]> {
    const res = await fetch(`https://api.telegram.org/bot${this.botToken}/getUpdates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ offset: this.offset, timeout: 25, allowed_updates: ['message', 'callback_query'] }),
      // 比服务端 timeout 多留 10 秒，避免正常的长轮询被当成超时
      signal: AbortSignal.timeout(35_000),
    })
    if (res.status === HTTP_CONFLICT) throw new ConflictError()
    if (!res.ok) throw new Error(`getUpdates HTTP ${res.status}`)
    // 恢复正常后允许下次冲突再次提示
    this.conflictLogged = false
    const body = (await res.json()) as { ok: boolean; result?: TgUpdate[] }
    return body.result ?? []
  }

  private async dispatch(u: TgUpdate): Promise<void> {
    const api = this.makeApi()

    if (u.callback_query) {
      const chat = String(u.callback_query.message?.chat.id ?? '')
      if (!this.allowed(chat)) return
      await this.answerCallback(u.callback_query.id)
      const r = await handleCallback(api, u.callback_query.data ?? '')
      if (r) await this.send(chat, r)
      return
    }

    const m = u.message
    if (!m?.text) return
    const chat = String(m.chat.id)
    if (!this.allowed(chat)) return

    // 引用回复优先：这是 Bot 端最值得打磨的交互，比敲 /send 顺手一个量级
    if (m.reply_to_message) {
      const r = await handleReply(api, String(m.reply_to_message.message_id), m.text)
      if (r) { await this.send(chat, r); return }
      // 引用的不是短信推送，继续按命令处理
    }

    const r = await handleCommand(api, m.text)
    if (r) await this.send(chat, r)
  }

  /**
   * 白名单外一律静默丢弃，不回任何提示——回复等于确认这个 Bot 有效，
   * 会招来持续骚扰（计划 §11.4 安全约束①）。
   */
  private allowed(chatId: string): boolean {
    if (this.allowedChats.has(chatId)) return true
    log.warn('忽略来自非白名单会话的消息', { chat_id: chatId })
    return false
  }

  private async send(chatId: string, msg: BotMessage): Promise<void> {
    await fetch(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: msg.text,
        parse_mode: 'HTML',
        reply_markup: msg.buttons
          ? { inline_keyboard: msg.buttons.map((row) => row.map((b) => ({ text: b.text, callback_data: b.data }))) }
          : undefined,
      }),
      signal: AbortSignal.timeout(15_000),
    }).catch((e: unknown) => log.warn('Bot 回复失败', { error: String(e) }))
  }

  private async answerCallback(id: string): Promise<void> {
    await fetch(`https://api.telegram.org/bot${this.botToken}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ callback_query_id: id }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => { /* 回执失败只影响按钮上的转圈动画 */ })
  }

  /** 经自己的 REST API 取数，不直连数据库（计划 §11 的硬性分工）。 */
  private makeApi(): BotApi {
    const call = async (path: string, init?: RequestInit): Promise<unknown> => {
      const res = await fetch(`${this.deps.apiBase}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${this.deps.serviceToken}`,
          ...(init?.body ? { 'content-type': 'application/json' } : {}),
        },
        signal: AbortSignal.timeout(20_000),
      })
      const text = await res.text()
      const data: unknown = text ? JSON.parse(text) : null
      if (!res.ok) {
        const err = (data as { error?: string } | null)?.error
        throw new Error(err ?? `HTTP ${res.status}`)
      }
      return data
    }

    const store = this.deps.store
    const channelId = this.channelId

    return {
      stats: () => call('/api/stats') as ReturnType<BotApi['stats']>,
      rules: () => call('/api/rules') as ReturnType<BotApi['rules']>,
      tasks: () => call('/api/tasks') as ReturnType<BotApi['tasks']>,
      outbound: (p) => {
        const q = new URLSearchParams({ limit: String(p.limit ?? 10) })
        if (p.to) q.set('to', p.to)
        if (p.status) q.set('status', p.status)
        return call(`/api/outbound?${q.toString()}`) as ReturnType<BotApi['outbound']>
      },
      events: (p) => {
        const q = new URLSearchParams({ limit: String(p.limit ?? 10) })
        if (p.q) q.set('q', p.q)
        if (p.from) q.set('from', p.from)
        if (p.device) q.set('device', p.device)
        if (p.kind) q.set('kind', p.kind)
        if (p.direction) q.set('direction', p.direction)
        return call(`/api/events?${q.toString()}`) as ReturnType<BotApi['events']>
      },

      sendSms: async (deviceId, to, text, simSlot) => {
        try {
          return (await call('/api/outbound', {
            method: 'POST',
            body: JSON.stringify({ device_id: deviceId, to, text, sim_slot: simSlot ?? null }),
          })) as { id: string; status: string }
        } catch (e) {
          return { id: '', status: 'failed', error: e instanceof Error ? e.message : String(e) }
        }
      },

      // 映射查询没有对应的 REST 接口，且它是 Bot 传输层自己的状态，
      // 不涉及业务逻辑，直接读存储不会造成两端逻辑漂移
      lookupRef: async (ref) => {
        const r = await store.getMessageRef(channelId, ref)
        return r ? { sender: r.sender, device_id: r.device_id, event_id: r.event_id, sim_slot: r.sim_slot } : null
      },

      isKnownNumber: async (n) => {
        const r = (await call(`/api/events?limit=200`)) as { events: { from: string }[] }
        return r.events.some((e) => e.from === n)
      },
    }
  }
}

class ConflictError extends Error {
  constructor() {
    super('bot token conflict')
    this.name = 'ConflictError'
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
