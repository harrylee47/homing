/**
 * 通知分发（计划 §9 可靠性要求）。
 *
 * 三条硬要求：
 *  - 发送失败重试 3 次，指数退避
 *  - 三次全败 → 写审计日志并触发跨渠道告警
 *  - 单个 Provider 故障不得阻塞其他渠道（并发发送，独立超时）
 */
import { log } from './logging.js'
import { barkProvider } from './providers/bark.js'
import { telegramProvider } from './providers/telegram.js'
import { webhookProvider } from './providers/webhook.js'
import { ProviderError, type NotifyMessage, type Provider } from './providers/types.js'

export const PROVIDERS: Record<string, Provider<never>> = {
  telegram: telegramProvider as unknown as Provider<never>,
  bark: barkProvider as unknown as Provider<never>,
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
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** 重试退避的基数。可注入，测试里调小以免真实等待数秒。 */
export interface DispatchOptions { retryBaseMs?: number | undefined }

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
      if (attempt < MAX_ATTEMPTS) {
        await sleep((opts.retryBaseMs ?? DEFAULT_RETRY_BASE_MS) * 2 ** (attempt - 1))
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
): Promise<void> {
  const failedIds = new Set(failed.map((f) => f.channelId))
  const healthy = allChannels.filter((c) => c.enabled && !failedIds.has(c.id))
  if (healthy.length === 0) {
    log.error('所有渠道均不可用，无法发出告警', { context })
    return
  }

  const detail = failed.map((f) => `${f.channelType}(${f.channelId}): ${f.error}`).join('; ')
  await dispatch(healthy, {
    title: '⚠️ 渠道发送失败',
    body: `${context}\n${detail}`.slice(0, 500),
    alert: true,
    priority: 'high',
    code: null,
    eventId: '',
    occurredAt: Date.now(),
  }, opts).catch((e: unknown) => log.error('告警本身也发送失败', { error: String(e) }))
}
