/**
 * 单条设备连接的协议状态机。运行时无关——ws 与 Durable Object 共用。
 *
 * 调用方（适配层）只负责收发字节与管理定时器，所有协议决策都在这里。
 */
import type { Cipher } from './crypto.js'
import { hashToken, timingSafeEqual } from './crypto.js'
import { makeFrame, parseUpstream } from './frames.js'
import type { Hub } from './hub.js'
import { log } from './logging.js'
import { userActive } from './users.js'
import {
  DEFAULT_AGENT_CONFIG,
  ErrorCode,
  FATAL_ERROR_CODES,
  type AgentConfig,
  type DownstreamFrame,
  type EventKind as EventKindT,
  type EventPayload,
} from './protocol.js'
import { processEvent } from './pipeline.js'
import type { InsertEventResult, Store } from './store.js'

export interface SessionDeps {
  store: Store
  cipher: Cipher
  hub: Hub
  /** 控制台地址，供通知生成深链 */
  baseUrl?: string | null
  config?: AgentConfig
  /** 每次握手时动态生成配置。优先于静态 config。 */
  /** 按设备主人取配置。同一台网关上两个人的短信指令口令不是同一个 */
  loadConfig?: ((userId: string) => Promise<AgentConfig>) | undefined
  /** 可注入，便于测试 */
  now?: () => number
  /** 查询类指令的结果回调（如 get_location）。 */
  onQueryResult?: ((cmdId: string, ok: boolean, detail: Record<string, unknown> | null, error: string | null) => void) | undefined
  /** 事件入库后的后续处理（规则匹配 + 推送）。测试可替换为空实现。 */
  onStored?: (eventId: string, e: { device_id: string; kind: EventKindT; from: string; content: string; occurred_at: number; direction?: 'in' | 'out'; imported?: boolean }) => void
}

/** 会话对适配层的指令：发若干帧，可选随后关闭连接。 */
export interface SessionAction {
  send: DownstreamFrame[]
  close?: { code: number; reason: string }
}

const NONE: SessionAction = { send: [] }

/**
 * 历史导入去重的时间窗。
 *
 * 取 5 秒：同一条记录在两条采集路径上的时间差最多几百毫秒，5 秒足够宽；
 * 而「同号码、同内容、5 秒内的两条独立记录」现实中几乎不存在。
 */
const DEDUP_WINDOW_MS = 5000

/** WS 关闭码：4001 认证失败，4002 协议错误。1000 为正常关闭。 */
export const CLOSE_AUTH_FAILED = 4001
export const CLOSE_PROTOCOL_ERROR = 4002

export class DeviceSession {
  private state: 'awaiting_hello' | 'authenticated' | 'closed' = 'awaiting_hello'
  private deviceId: string | null = null
  /** 这台设备的主人。事件的归属从它继承，不由 Agent 上报——那是可以伪造的 */
  private userId = ''
  private readonly now: () => number
  private readonly config: AgentConfig

  constructor(private readonly deps: SessionDeps) {
    this.now = deps.now ?? (() => Date.now())
    this.config = deps.config ?? DEFAULT_AGENT_CONFIG
  }

  get authenticatedDeviceId(): string | null {
    return this.state === 'authenticated' ? this.deviceId : null
  }

  /** 处理一帧上行数据。永不抛异常——任何内部错误都转成拒绝帧。 */
  async handle(raw: string): Promise<SessionAction> {
    if (this.state === 'closed') return NONE

    const parsed = parseUpstream(raw, this.now())
    if (!parsed.ok) {
      // 未认证阶段用 hello_reject 告知原因；已认证阶段不因单帧错误断连
      if (this.state === 'awaiting_hello') {
        return this.reject(parsed.code, parsed.message)
      }
      log.warn('丢弃非法帧', { device_id: this.deviceId, code: parsed.code, message: parsed.message })
      return NONE
    }

    const frame = parsed.frame
    if (this.state === 'awaiting_hello' && frame.type !== 'hello') {
      return this.reject(ErrorCode.PROTOCOL_MALFORMED, '首帧必须为 hello')
    }

    switch (frame.type) {
      case 'hello':
        return this.onHello(frame.payload)
      case 'event':
        return this.onEvent(frame.payload)
      case 'ping':
        return { send: [makeFrame('pong', { seq: frame.payload.seq }, this.now()) as DownstreamFrame] }
      case 'pong':
        return this.onPong(frame.payload)
      case 'cmd_result':
        return this.onCmdResult(frame.payload)
    }
  }

  /**
   * 指令回执。
   *
   * 发短信类：cmd_id 即 outbound id —— 两者一一对应，不需要额外的映射表，
   * 也就不存在「服务端重启后映射丢失」的问题（硬约束④）。
   *
   * 查询类（get_location）：没有对应的 outbound 记录，结果通过回调交给
   * 等待中的请求；status='done' 只出现在这类指令上。
   */
  private async onCmdResult(p: {
    cmd_id: string
    status: 'accepted' | 'sent' | 'delivered' | 'done' | 'failed'
    error: string | null
    detail?: Record<string, unknown> | null
  }): Promise<SessionAction> {
    log.info('收到指令回执', { device_id: this.deviceId, cmd_id: p.cmd_id, status: p.status, error: p.error })

    // 查询类指令没有对应的 outbound 记录，结果直接交给等待方
    if (p.status === 'done') {
      this.deps.onQueryResult?.(p.cmd_id, true, p.detail ?? null, p.error)
      return NONE
    }
    // 查询类失败同样要通知等待方，否则请求只能等超时
    if (p.status === 'failed') {
      this.deps.onQueryResult?.(p.cmd_id, false, p.detail ?? null, p.error)
    }

    await this.deps.store.advanceOutbound(p.cmd_id, p.status, p.error, this.now())
    return NONE
  }

  /** 连接断开时调用，登记离线时间。 */
  async onDisconnect(): Promise<void> {
    const id = this.deviceId
    this.state = 'closed'
    if (!id) return
    await this.deps.store.touchDevice(id, { status: 'offline', last_seen_at: this.now() })
    await this.logDevice(id, this.userId, 'warn', 'offline', null)
    log.info('设备断开', { device_id: id })
  }

  /**
   * 记一条连接日志。
   *
   * 「设备不在线」只有一个比特的信息量，真正有用的是**在那之前发生了什么**。
   * 这些服务端本来就知道，从前只写进 stdout——翻不到，也没法按设备看。
   *
   * **绝不写入短信正文、号码、验证码或凭证**：这张表会展示给人看，
   * 脱敏标准与日志输出相同。写失败只吞掉——诊断数据不该阻断主链路。
   */
  private async logDevice(
    deviceId: string | null, userId: string | null,
    level: 'info' | 'warn' | 'error', event: string, detail: string | null,
  ): Promise<void> {
    // 设备 id 显式传：握手被拒的几处发生在 this.deviceId 赋值**之前**，
    // 靠成员变量的话那几条——恰恰是最该记下来的几条——一条都记不上
    if (!deviceId || !userId) return
    await this.deps.store.appendDeviceLog({
      device_id: deviceId, user_id: userId, level, event, detail, created_at: this.now(),
    }).catch((e: unknown) => log.warn('连接日志写入失败', { error: String(e) }))
  }

  // ── 握手 ────────────────────────────────────────────────

  private async onHello(p: {
    device_id: string
    token: string
    app_version: string
    android_sdk: number
    battery: number
    charging?: boolean | null | undefined
    pending_count: number
    net?: unknown
  }): Promise<SessionAction> {
    const device = await this.deps.store.getDevice(p.device_id)

    // 未知设备与凭证错误返回同一错误码会更保守，但运维时极难排查；
    // 此处区分，代价是攻击者可枚举 device_id——而 device_id 本身不是秘密。
    if (!device) {
      return this.reject(ErrorCode.AUTH_UNKNOWN_DEVICE, '设备未注册，请重新配对')
    }
    if (device.status === 'revoked') {
      await this.logDevice(device.id, device.user_id, 'error', 'auth_revoked', '凭证已被吊销，连接被拒')
      return this.reject(ErrorCode.AUTH_DEVICE_REVOKED, '设备凭证已被吊销')
    }

    const incoming = await hashToken(p.token)
    if (!timingSafeEqual(incoming, device.token_hash)) {
      await this.logDevice(device.id, device.user_id, 'error', 'auth_failed', '凭证不匹配。设备需要重新配对')
      log.warn('凭证校验失败', { device_id: p.device_id })
      return this.reject(ErrorCode.AUTH_INVALID_TOKEN, '凭证无效')
    }

    /**
     * 设备的主人还能不能用这个服务。
     *
     * 握手只校验设备凭证的话，账号到期后手机照常上报、pipeline 照常推送、
     * 保号任务照常花钱——用户会发现自己登不进控制台但 Bark 还在响，
     * 而你会发现自己还在替一个过期账号转发别人的银行验证码。
     */
    const owner = await this.deps.store.getUser(device.user_id)
    if (!userActive(owner, this.now())) {
      await this.logDevice(device.id, device.user_id, 'error', 'account_inactive', '账号已停用或到期，服务暂停')
      log.warn('设备主人的账号已停用或到期，拒绝握手', { device_id: device.id, user_id: device.user_id })
      return this.reject(ErrorCode.ACCOUNT_INACTIVE, '账号已停用或已到期')
    }

    this.state = 'authenticated'
    this.deviceId = device.id
    this.userId = device.user_id
    await this.deps.store.touchDevice(device.id, {
      status: 'online',
      last_seen_at: this.now(),
      battery: p.battery,
      // 老版本 Agent 不上报充电状态，此时保持原值而不是写成 null，
      // 否则升级前后会反复清空
      ...(p.charging !== undefined && p.charging !== null ? { charging: p.charging } : {}),
      ...(p.net ? { net_json: JSON.stringify(p.net) } : {}),
      app_version: p.app_version,
    })

    await this.logDevice(device.id, device.user_id, 'info', 'online',
      `v${p.app_version} · SDK ${p.android_sdk} · 电量 ${p.battery}%` +
      (p.pending_count > 0 ? ` · 待补传 ${p.pending_count} 条` : ''))
    log.info('设备上线', {
      device_id: device.id,
      app_version: p.app_version,
      android_sdk: p.android_sdk,
      battery: p.battery,
      pending_count: p.pending_count,
    })

    // 每次握手都取当前配置：Agent 不持久化业务配置，服务端改了设置
    // 只需让设备重连即可生效
    const config = this.deps.loadConfig ? await this.deps.loadConfig(this.userId) : this.config

    return {
      send: [
        makeFrame(
          'hello_ack',
          { server_time: this.now(), config, known_event_ids: [] },
          this.now(),
        ) as DownstreamFrame,
      ],
    }
  }

  // ── 事件入库 ────────────────────────────────────────────

  private async onEvent(e: EventPayload): Promise<SessionAction> {
    // 连接已绑定设备，帧内 device_id 必须一致——否则一台设备可冒充另一台
    // （计划 §11.6：连接建立后仍校验每帧的 device_id 与凭证绑定关系）
    if (e.device_id !== this.deviceId) {
      log.warn('事件 device_id 与连接不符，已丢弃', {
        conn_device: this.deviceId,
        frame_device: e.device_id,
        event_id: e.id,
      })
      return this.ackEvent(e.id, 'rejected', 'device_id 与连接不符')
    }

    // 历史导入：同一条记录可能已经被实时捕获过，而两条路径的 id 不一样，
    // 按 id 的幂等去重挡不住。这里按「同设备 + 同类型 + 时间几乎相同 + 内容一致」再挡一道。
    if (e.extra.imported === true && (await this.isDuplicateImport(e))) {
      log.info('历史导入命中已有记录，跳过', { event_id: e.id, occurred_at: e.occurred_at })
      return this.ackEvent(e.id, 'duplicate')
    }

    let result: InsertEventResult
    try {
      const ts = this.now()
      result = await this.deps.store.insertEvent({
        id: e.id,
        user_id: this.userId,
        device_id: e.device_id,
        kind: e.kind,
        direction: e.extra.direction ?? 'in',
        sim_slot: e.sim_slot,
        sender_enc: await this.deps.cipher.encrypt(e.from),
        content_enc: await this.deps.cipher.encrypt(e.content),
        enc_ver: 1,
        occurred_at: e.occurred_at,
        received_at: ts,
        matched_rules: null,
        created_at: ts,
      })
    } catch (err) {
      // 入库失败必须回 rejected 之外的信号——这里选择不 ack，
      // 让 Agent 保留在队列里重传，宁可重复也不能丢（重复由幂等兜住）。
      log.error('事件入库失败', { event_id: e.id, error: String(err) })
      return NONE
    }

    log.info(result === 'stored' ? '事件已入库' : '事件重复，幂等跳过', {
      event_id: e.id,
      kind: e.kind,
      from: e.from,
      content: e.content,
      occurred_at: e.occurred_at,
    })

    // 只对新事件触发推送：补传重复上报不应让用户收到两遍验证码。
    // 不 await —— 落库已保证不丢，让 Agent 等推送结果只会拖慢队列。
    if (result === 'stored') {
      const handler = this.deps.onStored ?? this.defaultOnStored
      handler(e.id, {
        device_id: e.device_id, kind: e.kind, from: e.from,
        content: e.content, occurred_at: e.occurred_at,
        direction: e.extra.direction ?? 'in',
        imported: e.extra.imported === true,
      })
    }

    return this.ackEvent(e.id, result)
  }

  private readonly defaultOnStored = (
    eventId: string,
    e: { device_id: string; kind: EventKindT; from: string; content: string; occurred_at: number; direction?: 'in' | 'out'; imported?: boolean },
  ): void => {
    void processEvent(
      { store: this.deps.store, cipher: this.deps.cipher, baseUrl: this.deps.baseUrl ?? null },
      eventId, { ...e, user_id: this.userId },
    )
  }

  /**
   * 这条要导入的记录是不是已经在库里了。
   *
   * 只在导入路径上做：取前后两秒窗口内的同设备同类型事件解开比对。
   * 窗口很窄，所以候选通常是 0～2 条，解密开销可以忽略；允许几秒误差是因为
   * 手机本地库里的 date 与广播到达时刻并不严格相等（来电尤其明显：
   * 通话记录记的是响铃开始，广播能拿到的最早也是同一刻但仍有毫秒级差）。
   */
  private async isDuplicateImport(e: EventPayload): Promise<boolean> {
    const rows = await this.deps.store.listEvents({
      user_id: this.userId,
      device_id: e.device_id,
      kind: e.kind,
      since: e.occurred_at - DEDUP_WINDOW_MS,
      until: e.occurred_at + DEDUP_WINDOW_MS,
      limit: 20,
      offset: 0,
    }).catch(() => [])

    for (const row of rows) {
      if (row.id === e.id) return true
      const [from, content] = await Promise.all([
        this.deps.cipher.decrypt(row.sender_enc),
        this.deps.cipher.decrypt(row.content_enc),
      ])
      if (from === e.from && content === e.content) return true
    }
    return false
  }

  private ackEvent(id: string, status: 'stored' | 'duplicate' | 'rejected', error: string | null = null): SessionAction {
    return {
      send: [makeFrame('event_ack', { acks: [{ id, status, error }] }, this.now()) as DownstreamFrame],
    }
  }

  // ── 心跳 ────────────────────────────────────────────────

  private async onPong(p: {
    seq: number
    battery?: number | undefined
    charging?: boolean | null | undefined
    pending_count?: number | undefined
    net?: unknown
  }): Promise<SessionAction> {
    if (!this.deviceId) return NONE
    await this.deps.store.touchDevice(this.deviceId, {
      last_seen_at: this.now(),
      ...(p.battery !== undefined ? { battery: p.battery } : {}),
      ...(p.charging !== undefined && p.charging !== null ? { charging: p.charging } : {}),
      // 网络状态每次心跳都刷新：掉线排查时「WiFi 关了」比「不在线」有用得多
      ...(p.net ? { net_json: JSON.stringify(p.net) } : {}),
    })
    return NONE
  }

  // ── 拒绝 ────────────────────────────────────────────────

  private reject(code: ErrorCode, message: string): SessionAction {
    this.state = 'closed'
    // 用 protocol.ts 那一份，别在这里再抄一遍：两份清单迟早分叉，
    // 而分叉的表现是「某个错误码这边判可重试、那边判不可重试」
    const retryable = !FATAL_ERROR_CODES.includes(code)

    return {
      send: [
        makeFrame(
          'hello_reject',
          { code, message, retry_after_sec: retryable ? 30 : null },
          this.now(),
        ) as DownstreamFrame,
      ],
      close: {
        // 鉴权类（含账号停用/到期）统一用 4001，别只看 AUTH_ 前缀——
        // ACCOUNT_INACTIVE 不带这个前缀，按前缀判会把它归成「协议错误」
        code: code.startsWith('AUTH_') || code === ErrorCode.ACCOUNT_INACTIVE
          ? CLOSE_AUTH_FAILED : CLOSE_PROTOCOL_ERROR,
        reason: code,
      },
    }
  }
}
