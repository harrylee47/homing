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
import {
  DEFAULT_AGENT_CONFIG,
  ErrorCode,
  type AgentConfig,
  type DownstreamFrame,
  type EventPayload,
} from './protocol.js'
import type { InsertEventResult, Store } from './store.js'

export interface SessionDeps {
  store: Store
  cipher: Cipher
  hub: Hub
  config?: AgentConfig
  /** 可注入，便于测试 */
  now?: () => number
}

/** 会话对适配层的指令：发若干帧，可选随后关闭连接。 */
export interface SessionAction {
  send: DownstreamFrame[]
  close?: { code: number; reason: string }
}

const NONE: SessionAction = { send: [] }

/** WS 关闭码：4001 认证失败，4002 协议错误。1000 为正常关闭。 */
export const CLOSE_AUTH_FAILED = 4001
export const CLOSE_PROTOCOL_ERROR = 4002

export class DeviceSession {
  private state: 'awaiting_hello' | 'authenticated' | 'closed' = 'awaiting_hello'
  private deviceId: string | null = null
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
        // M2 落地发送状态机；此前先记录，避免 Agent 侧误以为服务端不接收
        log.info('收到指令回执', { device_id: this.deviceId, ...frame.payload })
        return NONE
    }
  }

  /** 连接断开时调用，登记离线时间。 */
  async onDisconnect(): Promise<void> {
    const id = this.deviceId
    this.state = 'closed'
    if (!id) return
    await this.deps.store.touchDevice(id, { status: 'offline', last_seen_at: this.now() })
    log.info('设备断开', { device_id: id })
  }

  // ── 握手 ────────────────────────────────────────────────

  private async onHello(p: {
    device_id: string
    token: string
    app_version: string
    android_sdk: number
    battery: number
    pending_count: number
  }): Promise<SessionAction> {
    const device = await this.deps.store.getDevice(p.device_id)

    // 未知设备与凭证错误返回同一错误码会更保守，但运维时极难排查；
    // 此处区分，代价是攻击者可枚举 device_id——而 device_id 本身不是秘密。
    if (!device) {
      return this.reject(ErrorCode.AUTH_UNKNOWN_DEVICE, '设备未注册，请重新配对')
    }
    if (device.status === 'revoked') {
      return this.reject(ErrorCode.AUTH_DEVICE_REVOKED, '设备凭证已被吊销')
    }

    const incoming = await hashToken(p.token)
    if (!timingSafeEqual(incoming, device.token_hash)) {
      log.warn('凭证校验失败', { device_id: p.device_id })
      return this.reject(ErrorCode.AUTH_INVALID_TOKEN, '凭证无效')
    }

    this.state = 'authenticated'
    this.deviceId = device.id
    await this.deps.store.touchDevice(device.id, {
      status: 'online',
      last_seen_at: this.now(),
      battery: p.battery,
      app_version: p.app_version,
    })

    log.info('设备上线', {
      device_id: device.id,
      app_version: p.app_version,
      android_sdk: p.android_sdk,
      battery: p.battery,
      pending_count: p.pending_count,
    })

    return {
      send: [
        makeFrame(
          'hello_ack',
          { server_time: this.now(), config: this.config, known_event_ids: [] },
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

    let result: InsertEventResult
    try {
      const ts = this.now()
      result = await this.deps.store.insertEvent({
        id: e.id,
        device_id: e.device_id,
        kind: e.kind,
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

    return this.ackEvent(e.id, result)
  }

  private ackEvent(id: string, status: 'stored' | 'duplicate' | 'rejected', error: string | null = null): SessionAction {
    return {
      send: [makeFrame('event_ack', { acks: [{ id, status, error }] }, this.now()) as DownstreamFrame],
    }
  }

  // ── 心跳 ────────────────────────────────────────────────

  private async onPong(p: { seq: number; battery?: number | undefined; pending_count?: number | undefined }): Promise<SessionAction> {
    if (!this.deviceId) return NONE
    await this.deps.store.touchDevice(this.deviceId, {
      last_seen_at: this.now(),
      ...(p.battery !== undefined ? { battery: p.battery } : {}),
    })
    return NONE
  }

  // ── 拒绝 ────────────────────────────────────────────────

  private reject(code: ErrorCode, message: string): SessionAction {
    this.state = 'closed'
    const retryable = ![
      ErrorCode.AUTH_INVALID_TOKEN,
      ErrorCode.AUTH_DEVICE_REVOKED,
      ErrorCode.AUTH_UNKNOWN_DEVICE,
      ErrorCode.PROTOCOL_VERSION_UNSUPPORTED,
    ].includes(code as never)

    return {
      send: [
        makeFrame(
          'hello_reject',
          { code, message, retry_after_sec: retryable ? 30 : null },
          this.now(),
        ) as DownstreamFrame,
      ],
      close: {
        code: code.startsWith('AUTH_') ? CLOSE_AUTH_FAILED : CLOSE_PROTOCOL_ERROR,
        reason: code,
      },
    }
  }
}
