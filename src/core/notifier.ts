/**
 * 通知分发（计划 §9 可靠性要求）。
 *
 * 三条硬要求：
 *  - 发送失败重试 3 次，指数退避
 *  - 三次全败 → 写审计日志并触发跨渠道告警
 *  - 单个 Provider 故障不得阻塞其他渠道（并发发送，独立超时）
 */
import { log } from './logging.js'
import { shouldAlert, type AlertWindowStore } from './alertwindow.js'
import { barkProvider } from './providers/bark.js'
import { ntfyProvider } from './providers/ntfy.js'
import { webpushProvider } from './providers/webpush.js'
import { telegramProvider } from './providers/telegram.js'
import { webhookProvider } from './providers/webhook.js'
import { ProviderError, type NotifyMessage, type Provider } from './providers/types.js'

export const PROVIDERS: Record<string, Provider<never>> = {
  telegram: telegramProvider as unknown as Provider<never>,
  bark: barkProvider as unknown as Provider<never>,
  ntfy: ntfyProvider as unknown as Provider<never>,
  webpush: webpushProvider as unknown as Provider<never>,
  webhook: webhookProvider as unknown as Provider<never>,
}

/** 注册渠道实现。M4 的 Bark / Webhook 走同一入口，测试也用它注入桩。 */
export function registerProvider(p: Provider<never>): void {
  PROVIDERS[p.type] = p
}

export interface ChannelConfig {
  id: string
  type: string
  name: string
  /** 已解密的配置对象 */
  config: unknown
  enabled: boolean
}

export interface DeliveryResult {
  channelId: string
  channelType: string
  ok: boolean
  attempts: number
  error: string | null
  /** 渠道侧消息标识，供「Reply 即回复」建立映射 */
  ref?: string | undefined
  /** 对端身份的人类描述，只有渠道测试会读它（见 SendResult.to） */
  to?: string | undefined
}

const MAX_ATTEMPTS = 3
const DEFAULT_RETRY_BASE_MS = 1000

/**
 * 对方要求的等待时间的上限。
 *
 * 超过这个数就不等了——直接判失败，把这一条交给跨渠道告警去说。
 * 理由是这里的等待会**占住这台设备的推送队列**（见 session.ts 的串行链），
 * 后面那条真正要紧的验证码得排在它后面。宁可这一条失败得响亮，
 * 也不要静悄悄地把整条队列压住几分钟。
 *
 * Telegram 实际给的 retry_after 多在几秒到几十秒，60 秒足够覆盖绝大多数；
 * 真要到分钟级，那说明量级已经不对了，该看的是为什么会有那么多推送。
 */
const MAX_RETRY_AFTER_MS = 60_000
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** 重试退避的基数。可注入，测试里调小以免真实等待数秒。 */
export interface DispatchOptions {
  retryBaseMs?: number | undefined
  /**
   * 「对方让等多久」的上限，可注入好让测试不用真的睡 60 秒。
   * 不传就用 MAX_RETRY_AFTER_MS。
   */
  maxRetryAfterMs?: number | undefined
}

/**
 * 向多个渠道并发发送。
 *
 * 返回每个渠道的结果而不是抛异常——调用方需要知道「哪些成功了」，
 * 只报一个总体失败会让排查无从下手。
 */
export async function dispatch(
  channels: ChannelConfig[],
  msg: NotifyMessage,
  opts: DispatchOptions = {},
): Promise<DeliveryResult[]> {
  const targets = channels.filter((c) => c.enabled)
  // 并发：一个渠道慢或挂掉，不能拖住其他渠道
  return Promise.all(targets.map((c) => sendWithRetry(c, msg, opts)))
}

async function sendWithRetry(ch: ChannelConfig, msg: NotifyMessage, opts: DispatchOptions): Promise<DeliveryResult> {
  const provider = PROVIDERS[ch.type]
  if (!provider) {
    return { channelId: ch.id, channelType: ch.type, ok: false, attempts: 0, error: `未知渠道类型 ${ch.type}` }
  }

  let lastError = ''
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const r = await provider.send(ch.config as never, msg)
      if (attempt > 1) log.info('渠道重试后成功', { channel: ch.id, type: ch.type, attempt })
      return {
        channelId: ch.id, channelType: ch.type, ok: true, attempts: attempt, error: null,
        ref: r && typeof r === 'object' ? r.ref : undefined,
        to: r && typeof r === 'object' ? r.to : undefined,
      }
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e)
      const retryable = e instanceof ProviderError ? e.retryable : true

      if (!retryable) {
        // 配置错误重试多少次都一样，早点失败早点告警
        log.warn('渠道失败且不可重试', { channel: ch.id, type: ch.type, error: lastError })
        break
      }

      /**
       * 对方说了等多久，就等多久——不要按自己那套指数退避。
       *
       * 429 限流下，1s、2s 两次重试必然再吃两个 429：三次尝试全落在 3 秒
       * 窗口里，而限流方要的是几十秒。结果是「重试了三次」听着很努力，
       * 实际上一次都没等够，这一路推送就此放弃。
       */
      const askedMs = e instanceof ProviderError ? e.retryAfterMs : null
      const maxWait = opts.maxRetryAfterMs ?? MAX_RETRY_AFTER_MS
      if (askedMs !== null && askedMs > maxWait) {
        log.warn('对方要求的等待超出上限，不再重试', {
          channel: ch.id, type: ch.type, asked_ms: askedMs, max_ms: maxWait,
        })
        break
      }
      if (attempt < MAX_ATTEMPTS) {
        const backoff = (opts.retryBaseMs ?? DEFAULT_RETRY_BASE_MS) * 2 ** (attempt - 1)
        // 取大的那个：对方说等 30 秒，我们自己算出来 2 秒，那就等 30 秒
        await sleep(Math.max(backoff, askedMs ?? 0))
      }
    }
  }

  log.error('渠道发送失败', { channel: ch.id, type: ch.type, error: lastError })
  return { channelId: ch.id, channelType: ch.type, ok: false, attempts: MAX_ATTEMPTS, error: lastError }
}

/**
 * 跨渠道告警：某个渠道全败时，从其他健康渠道发出通知。
 *
 * 用失败的渠道去通知「这个渠道失败了」是没有意义的——
 * 与计划 §10.1「告警必须走独立于设备的通道」同一个道理。
 */
export async function crossChannelAlert(
  allChannels: ChannelConfig[],
  failed: DeliveryResult[],
  context: string,
  opts: DispatchOptions = {},
  /**
   * 压制窗口。不传就每次都发（保持老行为，测试与不接存储的调用方用得上）。
   *
   * 传了的话，同一组失败渠道在窗口内只发一条，被压掉的条数由下一条带出来。
   * 见 alertwindow.ts 里为什么这件事必须做、又为什么不能简单压掉。
   */
  window?: { store: AlertWindowStore; userId: string; now?: number | undefined } | undefined,
): Promise<void> {
  const failedIds = new Set(failed.map((f) => f.channelId))
  const healthy = allChannels.filter((c) => c.enabled && !failedIds.has(c.id))
  if (healthy.length === 0) {
    log.error('所有渠道均不可用，无法发出告警', { context })
    return
  }

  let suppressedNote = ''
  if (window) {
    // 键用「哪些渠道失败了」，不用事件 id：同一个渠道连续失败 50 次是一件事
    const key = [...failedIds].sort().join(',')
    const d = await shouldAlert(window.store, window.userId, key, window.now ?? Date.now())
      .catch((e: unknown) => {
        // 压制状态读写失败不能挡住告警本身
        log.warn('告警压制状态读写失败，按不压制处理', { error: String(e) })
        return { send: true, suppressed: 0 }
      })
    if (!d.send) {
      log.info('同一渠道的失败告警已在窗口内发过，这条压制', { context, key })
      return
    }
    if (d.suppressed > 0) {
      suppressedNote = `\n（上一条告警之后还有 ${d.suppressed} 条同样失败，未逐条通知）`
    }
  }

  const detail = failed.map((f) => `${f.channelType}(${f.channelId}): ${f.error}`).join('; ')
  /**
   * 这里必须接返回值，不能挂 `.catch`。
   *
   * 曾经写的是 `dispatch(...).catch(e => log.error('告警本身也发送失败'))`——
   * 那行日志从来没出现过，因为 `dispatch` 是 `Promise.all(sendWithRetry)`，
   * 而 `sendWithRetry` 把 provider.send 整个包在 try/catch 里、每条路径都
   * return 一个 DeliveryResult，**从不 reject**。于是「告警自己也发不出去」
   * 这件事既不留审计、也没有一句专门的日志，只剩 sendWithRetry 里那条
   * 泛泛的「渠道发送失败」——和普通推送失败长得一模一样，分不出来。
   */
  const results = await dispatch(healthy, {
    title: '⚠️ 渠道发送失败',
    body: `${context}\n${detail}${suppressedNote}`.slice(0, 500),
    alert: true,
    priority: 'high',
    code: null,
    eventId: '',
    occurredAt: Date.now(),
  }, opts)
  const alertFailed = results.filter((r) => !r.ok)
  if (alertFailed.length === results.length) {
    log.error('告警本身也发送失败，用户不会收到任何提示', {
      context,
      channels: alertFailed.map((r) => `${r.channelType}(${r.channelId}): ${r.error}`),
    })
  }
}
