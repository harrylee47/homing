/**
 * 通知渠道接口。新增渠道 = 实现一个接口（计划 §9）。
 *
 * 用 fetch 而非任何 HTTP 库——Node 18+ 与 Workers 都原生提供，满足运行时无关约束。
 */
import type { z } from 'zod'

export interface NotifyMessage {
  title: string
  body: string
  priority: 'normal' | 'high'
  /** 提取出的验证码，可空 */
  code: string | null
  /** 事件 id，用于深链跳转 */
  eventId: string
  occurredAt: number
}

export interface Provider<C = unknown> {
  readonly type: string
  /** 配置结构，用于保存前校验与控制台表单生成 */
  readonly configSchema: z.ZodType<C>
  /** 发送。失败必须抛异常，由 notifier 统一重试。 */
  send(config: C, msg: NotifyMessage): Promise<void>
}

/** 渠道发送失败。message 会写入 audit_log，不得包含短信正文。 */
export class ProviderError extends Error {
  constructor(
    readonly providerType: string,
    message: string,
    readonly retryable = true,
  ) {
    super(message)
    this.name = 'ProviderError'
  }
}
