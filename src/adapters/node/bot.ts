/**
 * Telegram Bot 的 long polling 传输层。
 *
 * 用 long polling 而不是 webhook：Bot 主动外连 Telegram，**零入站端口**；
 * webhook 需要暴露端口并配证书。本项目规模下资源开销可忽略，拓扑上干净得多
 * （计划 §11.4）。Workers 版没有常驻进程，届时改为 webhook，但命令逻辑
 * 在 core/bot.ts 里不变。
 */
import { COMMANDS, handleCallback, handleCommand, handleReply, handleText, type BotApi, type BotMessage } from '../../core/bot.js'
import { log } from '../../core/logging.js'
import { describeFetchError } from '../../core/neterror.js'
import { threadKey } from '../../core/thread.js'
import type { Cipher } from '../../core/crypto.js'
import type { Store } from '../../core/store.js'

export interface BotDeps {
  store: Store
  /** 自己的 API 基址，如 http://127.0.0.1:8070 */
  apiBase: string
  /** Bot 专用 service token */
  serviceToken: string
  /** 渠道属主。「回复」提示落 message_ref 时要按它归属 */
  userId: string
  /** 发件人号码在 message_refs 里是加密落库的（见 MessageRefRecord.sender_enc） */
  cipher: Cipher
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
    // message_id 是按钮所在那条消息的 id，点完之后要用它把消息改写掉
    message?: { message_id: number; chat: { id: number } }
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
    // 三轮都失败时要说出原因。原来这个 catch 把错误整个吞了，最后那句
    // log.warn 光秃秃一行——而它失败的原因与轮询失败往往是同一个（出网），
    // 有 describeFetchError 挖出来的 code/地址才对得上号
    let lastError = ''
    for (let attempt = 1; attempt <= 3; attempt++) {
      const ok = await fetch(`https://api.telegram.org/bot${this.botToken}/setMyCommands`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ commands: COMMANDS }),
        signal: AbortSignal.timeout(15_000),
      }).then((r) => {
        if (!r.ok) lastError = `HTTP ${r.status}`
        return r.ok
      }).catch((e: unknown) => {
        lastError = describeFetchError(e)
        return false
      })

      if (ok) {
        log.info('Bot 命令菜单已注册', { count: COMMANDS.length })
        return
      }
      if (attempt < 3) await sleep(2000 * attempt)
    }
    log.warn('注册 Bot 命令菜单失败，不影响命令本身可用', { error: lastError })
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
          await this.dispatch(u).catch(async (e: unknown) => {
            log.error('处理 Bot 更新失败', { error: String(e) })
            /**
             * 出错也要回一句。
             *
             * 只写日志的话，用户那边是彻底的沉默——他分不清是「我打错了」
             * 还是「Bot 挂了」，而运维这边除非主动翻日志也不会知道。
             * /tasks 缺 bot 作用域这条死命令就是这么藏了很久的。
             */
            const chat = u.message?.chat?.id ?? u.callback_query?.message?.chat?.id
            if (chat == null) return
            await this.send(String(chat), { text: '这条命令没能执行完。稍后再试，或者到控制台看看。' })
              .catch(() => { /* 连错误提示都发不出去就只能作罢 */ })
          })
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
        /**
         * 网络抖动、Telegram 限流走这里；退避后继续，不要放弃轮询。
         *
         * 一定要用 describeFetchError：fetch 的顶层错误一律是 "fetch failed"，
         * 而真正的原因在 `cause` 里。这里曾经只取 `cause.code`，于是
         * 多地址失败时打出来的是一个光秃秃的 ETIMEDOUT——`cause.errors[]`
         * 里那句 `ENETUNREACH/<IPv6 地址>`（一眼就能定位问题）被丢掉了。
         * 2026-09-17 为此查了两个小时。
         */
        log.warn('Bot 轮询失败', { error: describeFetchError(e) })
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
      if (r) {
        /**
         * 把原来那条带按钮的消息改写成结果，并撤掉按钮。
         *
         * 不撤的话按钮还能再点：第二次点会被告知「已过期」，
         * 而那句话读起来像「没发出去」，用户最自然的下一步是重发 /send，
         * 结果同一条短信发两遍。发短信是不可撤销的。
         *
         * 改写失败也不影响主流程——handleCallback 那边还有一层
         * 「已经发过了」的兜底。
         */
        const orig = u.callback_query.message?.message_id
        // edit=true 的是翻页/详情这类「换一屏内容」，原地改写；
        // 其余（发送结果、回复提示）是新的一步，另发一条
        if (r.edit && orig != null) await this.editMessage(chat, orig, r)
        else await this.send(chat, r)
      }
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
      /**
       * 引用的不是一条能回复的消息（比如 Bot 自己打印的列表）。
       *
       * 这里**不能**继续往下落到 handleText——那样一句「好的」会被当成
       * 关键词去搜，用户以为自己回复出去了，其实什么都没发。
       * 明确说一句，并给出正确的做法。
       */
      if (!m.text.startsWith('/')) {
        await this.send(chat, {
          text: '这条不是短信推送，没法据此回复。\n'
            + '用 /from &lt;号码&gt; 或 /thread &lt;号码&gt; 找到原消息，点开后用「↩️ 回复」。',
        })
        return
      }
      // 引用着一条消息但打的是命令，那就按命令处理
    }

    const r = (await handleCommand(api, m.text)) ?? (await handleText(api, m.text))
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

  /**
   * 回一条消息。超过长度上限的自动切成多条。
   *
   * 两个坑叠在一起，表现是「用户什么都没收到，日志里也没有一行」：
   *
   * ① `fetch` 对 HTTP 400 是 **resolve 而不是 reject**，所以挂在后面的
   *    `.catch(log.warn)` 永远不会触发。必须显式检查 res.ok。
   * ② Telegram 单条消息上限 4096 字符，超了直接 400。`/recent 30` 很容易越线：
   *    中文银行短信普遍 60–120 字，每条还要加上 26 个字符的 <tg-spoiler> 标签。
   *
   * 切分必须落在**行边界**：parse_mode=HTML 下把 <tg-spoiler> 从中间切开，
   * 标签不闭合，Telegram 同样回 400——那正是现在看不见的那类失败。
   */
  private async send(chatId: string, msg: BotMessage): Promise<void> {
    const parts = splitForTelegram(msg.text)
    for (const [i, text] of parts.entries()) {
      // 按钮只挂最后一片，否则同一组按钮会出现好几遍
      const last = i === parts.length - 1
      const res = await fetch(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: 'HTML',
          reply_markup: last ? replyMarkup(msg) : undefined,
        }),
        signal: AbortSignal.timeout(15_000),
      }).catch((e: unknown) => {
        // describeFetchError 不能省：fetch 的顶层拒绝值恒是 TypeError: fetch failed，
        // 真正的原因（哪个地址族、什么 code）在 cause 里。Bot 是唯一一个长期
        // 主动外连的组件，那次 Happy Eyeballs 的 ETIMEDOUT 就是这么被抹掉的
        log.warn('Bot 回复失败', { error: describeFetchError(e) })
        return null
      })
      if (!res) return
      if (res.ok && last && msg.replyTo) {
        /**
         * 给这条 forceReply 提示落一条回复映射。
         *
         * 用户对着它打字发回来时，消息自带 reply_to_message，
         * handleReply 按 message_id 就能查到「回给谁、用哪台设备哪张卡」——
         * 和引用一条真实短信推送走的是完全相同的那条路，
         * 服务端不需要记「谁正在回复谁」这种进程内状态。
         */
        const body = (await res.clone().json().catch(() => null)) as { result?: { message_id?: number } } | null
        const mid = body?.result?.message_id
        if (mid != null) {
          await this.deps.store.putMessageRef({
            channel_id: this.channelId, ref: String(mid), event_id: msg.replyTo.eventId,
            user_id: this.deps.userId, sender_enc: await this.deps.cipher.encrypt(msg.replyTo.sender),
            device_id: msg.replyTo.deviceId, sim_slot: msg.replyTo.simSlot,
            created_at: Date.now(),
          }).catch((e: unknown) => log.warn('记录回复映射失败', { error: String(e) }))
        }
      }
      if (!res.ok) {
        // 响应体里是 Telegram 给的原因（标签不闭合、消息过长、被拉黑…），
        // 不打出来就只能靠猜。它不含短信正文，可以安全落日志
        const detail = await res.text().catch(() => '')
        log.error('Bot 回复被 Telegram 拒绝', {
          status: res.status, part: `${i + 1}/${parts.length}`, detail: detail.slice(0, 300),
        })
        return
      }
    }
  }

  /**
   * 原地改写一条已发出的消息。
   *
   * 两个用途：翻页（换一屏内容，不该在聊天记录里堆十几个版本），
   * 以及按钮点完之后把它换成结果并撤掉按钮（不撤的话能再点一次，
   * 而对 /send 来说那意味着同一条短信发两遍）。
   *
   * 改写后的内容可能超过单条上限，那时只能退回新发一条。
   */
  private async editMessage(chatId: string, messageId: number, msg: BotMessage): Promise<void> {
    const parts = splitForTelegram(msg.text)
    if (parts.length > 1) { await this.send(chatId, msg); return }
    const res = await fetch(`https://api.telegram.org/bot${this.botToken}/editMessageText`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId, message_id: messageId, text: msg.text, parse_mode: 'HTML',
        // 显式给一个空的 inline_keyboard 才能把按钮撤掉；不传这个字段是「保持原样」
        reply_markup: msg.buttons
          ? { inline_keyboard: msg.buttons.map((row) => row.map((b) => ({ text: b.text, callback_data: b.data }))) }
          : { inline_keyboard: [] },
      }),
      signal: AbortSignal.timeout(15_000),
    }).catch((e: unknown) => {
      // 同上：String(e) 在这里永远只有 "fetch failed" 四个字
      log.warn('Bot 改写消息失败', { error: describeFetchError(e) })
      return null
    })
    // 内容一字未变时 Telegram 回 400 message is not modified，那不是故障；
    // 其余的照样要打出来，否则又是一次静默失败
    if (res && !res.ok) {
      const detail = await res.text().catch(() => '')
      if (!detail.includes('message is not modified')) {
        log.error('Bot 改写消息被拒绝', { status: res.status, detail: detail.slice(0, 300) })
      }
    }
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
        const q = new URLSearchParams({ limit: String(p.limit ?? 10), offset: String(p.offset ?? 0) })
        if (p.to) q.set('to', p.to)
        if (p.status) q.set('status', p.status)
        return call(`/api/outbound?${q.toString()}`) as ReturnType<BotApi['outbound']>
      },
      events: (p) => {
        const q = new URLSearchParams({ limit: String(p.limit ?? 10), offset: String(p.offset ?? 0) })
        if (p.q) q.set('q', p.q)
        if (p.from) q.set('from', p.from)
        if (p.device) q.set('device', p.device)
        if (p.kind) q.set('kind', p.kind)
        if (p.direction) q.set('direction', p.direction)
        // deep=1 放宽扫描预算，对应控制台的「继续往更早搜」
        if (p.deep) q.set('deep', '1')
        return call(`/api/events?${q.toString()}`) as ReturnType<BotApi['events']>
      },
      // 单条查不到时回 null 而不是抛：用户点开一条已被删掉的消息是正常情形，
      // 不该让整个回调走进「这条命令没能执行完」
      event: async (id) => {
        try { return (await call(`/api/events/${encodeURIComponent(id)}`)) as Awaited<ReturnType<BotApi['event']>> }
        catch { return null }
      },
      thread: async (key) => {
        try { return (await call(`/api/threads/${encodeURIComponent(key)}`)) as Awaited<ReturnType<BotApi['thread']>> }
        catch { return null }
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
        const r = await this.deps.store.getMessageRef(channelId, ref)
        if (!r) return null
        // 密文优先；加密之前落的那些老行只有明文列（七天后自然清掉）
        const sender = r.sender_enc.length > 0
          ? await this.deps.cipher.decrypt(r.sender_enc)
          : (r.sender_legacy ?? '')
        return { sender, device_id: r.device_id, event_id: r.event_id, sim_slot: r.sim_slot }
      },

      /**
       * 这个号码是不是打过交道的。用于 /send 的二次确认——那是防 Telegram
       * 账号被盗的一道，不是防手滑。
       *
       * 比对必须先归一化：同一个人在历史里会以 `95533` / `+8695533` /
       * `0086 95533` 三种写法出现，按原串全等比的话，天天打交道的号码
       * 也会弹「⚠️ 不在历史记录中」。误报多了人就条件反射点确认，
       * 这道防线等于没有。复用会话视图那套 threadKey，两处对「同一个号码」
       * 的判断保持一致。
       */
      isKnownNumber: async (n) => {
        const r = (await call(`/api/events?limit=200`)) as { events: { from: string }[] }
        const want = threadKey(n)
        return r.events.some((e) => threadKey(e.from) === want)
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

/** Telegram 单条消息的字符上限。留出余量，别卡着线发 */
const TG_LIMIT = 3500

/**
 * 按行切分长文本。
 *
 * **只在换行处切**：parse_mode=HTML 下把 `<tg-spoiler>` 从中间切开会让标签
 * 不闭合，Telegram 回 400 整条丢掉——而 spoiler 里装的正是短信正文。
 * 单行本身就超长时只能硬切，那种情况下宁可 Telegram 拒一条，
 * 也不要把标签切坏导致**整段**都发不出去。
 */
export function splitForTelegram(text: string, limit = TG_LIMIT): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let buf = ''
  for (const line of text.split('\n')) {
    if (buf && buf.length + 1 + line.length > limit) {
      out.push(buf)
      buf = ''
    }
    if (line.length > limit) {
      // 单行超长：先把攒着的发掉，再把这一行硬切
      if (buf) { out.push(buf); buf = '' }
      for (let i = 0; i < line.length; i += limit) out.push(line.slice(i, i + limit))
      continue
    }
    buf = buf ? `${buf}\n${line}` : line
  }
  if (buf) out.push(buf)
  return out
}

/**
 * 一条消息的 reply_markup。三种互斥形态：
 * 内联按钮（列表、确认）、强制回复（让客户端自动带上引用）、常驻键盘。
 */
function replyMarkup(msg: BotMessage): unknown {
  if (msg.buttons) {
    return { inline_keyboard: msg.buttons.map((row) => row.map((b) => ({ text: b.text, callback_data: b.data }))) }
  }
  if (msg.forceReply) return { force_reply: true, input_field_placeholder: '直接打字…' }
  if (msg.keyboard) {
    return { keyboard: msg.keyboard.map((row) => row.map((t) => ({ text: t }))), resize_keyboard: true, is_persistent: true }
  }
  return undefined
}
