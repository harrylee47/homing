/**
 * 通知渠道接口。新增渠道 = 实现一个接口（计划 §9）。
 *
 * 用 fetch 而非任何 HTTP 库——Node 18+ 与 Workers 都原生提供，满足运行时无关约束。
 */
import type { z } from 'zod'

export interface NotifyMessage {
  /** 渠道标题：短信/通知是发件人，来电是号码，告警是标题本身 */
  title: string
  /**
   * 正文。**只放内容**，不要把发件人、时间、设备拼进来。
   *
   * 每个渠道本身就在显示归属信息（Telegram 的头部、Bark 的标题），
   * 模板里再拼一次就成了「来自: 10690…」+「【10690…】10690…」这种三连。
   * 归属由下面那几个结构化字段表达，各渠道按自己的形式渲染。
   */
  body: string
  /** 消息类型，决定头部怎么排。系统告警没有类型。 */
  kind?: 'sms' | 'call' | 'notification' | undefined
  /**
   * 这是系统告警（设备离线、渠道故障、异地登录），不是转发来的消息。
   *
   * **默认 false，且必须显式打开**：Telegram 那边靠它决定要不要模糊正文。
   * 反过来设计——「没标类型就当告警」——意味着哪天有人漏填一个字段，
   * 短信正文就明文发进了 Telegram，而那正是上一版网关被封的原因。
   * 漏填只能导致「多模糊了一条告警」，不能导致明文泄漏。
   */
  alert?: boolean | undefined
  /**
   * 正文里有凭证（找回码这类），即使是告警也要模糊。
   *
   * 告警默认不模糊，因为里面没有短信正文、模糊了反而要多点一下。
   * 但找回码是**一次性口令**——它和银行验证码是同一类东西，
   * 明文躺在 Telegram 的聊天记录里既是泄漏面，也正是会招来封号的那种内容。
   */
  sensitive?: boolean | undefined
  direction?: 'in' | 'out' | undefined
  /**
   * 已按用户设置的时区格式化好的时间。
   *
   * 由 pipeline 算好传进来，渠道不要自己 `toLocaleString`——
   * 服务端跑在 UTC 容器里，那样算出来的时间比 Telegram 自己的时间戳
   * 差了整整一个时区，同一条消息上出现两个时间，谁也不知道该信哪个。
   */
  localTime?: string | undefined
  /** 「SIM2 · 尾号8888」。单卡或卡槽未知时为 null，见 core/sim.ts */
  sim?: string | null | undefined
  priority: 'normal' | 'high'
  /** 提取出的验证码，可空 */
  code: string | null
  /** 事件 id，用于深链跳转 */
  eventId: string
  occurredAt: number
  /** 控制台里这条事件的完整地址。未配置 GW_BASE_URL 时为 null。 */
  consoleUrl?: string | null
  /**
   * 来源设备名。
   *
   * **只在有多台设备时才填**：单设备场景下每条通知都缀一个设备名是纯噪音，
   * 而多设备时不写就分不清这条验证码是哪张卡收到的。
   */
  deviceName?: string | null
  /**
   * 渠道私有选项，按渠道类型分组（如 `{ bark: { level: 'timeSensitive' } }`）。
   * 放在消息上而不是渠道配置里，是因为它随规则变化：
   * 银行验证码要穿透专注模式，广告短信不该。
   */
  options?: Record<string, unknown>
}

/** 发送结果。ref 是渠道侧的消息标识，用于把用户的回复关联回原事件。 */
export interface SendResult {
  ref?: string | undefined
}

export interface Provider<C = unknown> {
  readonly type: string
  /** 配置结构，用于保存前校验与控制台表单生成 */
  readonly configSchema: z.ZodType<C>
  /** 发送。失败必须抛异常，由 notifier 统一重试。 */
  send(config: C, msg: NotifyMessage): Promise<SendResult | void>
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
