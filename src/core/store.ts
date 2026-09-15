/**
 * 存储接口。core 层只依赖此接口，不依赖 SQLite / D1 任何一方。
 *
 * 硬约束②：实现必须限制在 D1 兼容子集——不用触发器、自定义函数、ATTACH，
 * 全文检索用 LIKE 而非 FTS5。
 */
import type { EventKind } from './protocol.js'
import type { RuleAction, RuleMatch } from './rules.js'

export interface DeviceRecord {
  id: string
  name: string
  /** 凭证哈希，绝不存明文（计划 §6.1） */
  token_hash: string
  status: 'online' | 'offline' | 'revoked'
  last_seen_at: number | null
  battery: number | null
  /** 是否在充电。null 表示设备未上报（老版本 Agent） */
  charging: boolean | null
  /**
   * 最近一次上报的网络状态，JSON（结构见 protocol.ts 的 NetStatus）。
   *
   * 用一列 JSON 而不是拆成 wifi/ssid/signal 几列：这组字段随 Android 版本
   * 增减，每加一项就来一次表迁移不值得，而且它只用于展示，不参与任何查询。
   */
  net_json: string | null
  /** 最近一次定位结果，加密存储。位置与短信正文同等敏感。 */
  location_enc: Uint8Array | null
  location_at: number | null
  app_version: string | null
  created_at: number
}

/** 落库的事件。敏感字段已加密，core 层拿到的是密文。 */
export interface StoredEvent {
  id: string
  device_id: string
  kind: EventKind
  /** in=收到，out=设备发出。老记录为 null，按 in 处理 */
  direction: 'in' | 'out' | null
  sender_enc: Uint8Array
  content_enc: Uint8Array
  enc_ver: number
  occurred_at: number
  received_at: number
  /** 命中的规则 id，JSON 数组字符串 */
  matched_rules: string | null
  created_at: number
}

/** 只按索引列筛选的条件。正文与号码是密文，只能在内存里过滤。 */
export interface EventFilter {
  kind?: EventKind | undefined
  device_id?: string | undefined
  /** 收/发方向。老记录 direction 为 NULL，按 'in' 处理 */
  direction?: 'in' | 'out' | undefined
  /** occurred_at 下界（含） */
  since?: number | undefined
  /** occurred_at 上界（含） */
  until?: number | undefined
}

export interface EventQuery extends EventFilter {
  limit: number
  offset: number
}

/** 写入结果，用于回 event_ack。 */
export type InsertEventResult = 'stored' | 'duplicate'

/** 渠道。config 加密存储——里面是 Bot token 这类凭证。 */
export interface ChannelRecord {
  id: string
  type: string
  name: string
  config_enc: Uint8Array
  enabled: boolean
  created_at: number
}

export interface RuleRecord {
  id: string
  name: string
  priority: number
  enabled: boolean
  /** JSON 字符串，结构见 rules.ts 的 RuleMatch */
  match_json: string
  action_json: string
  created_at: number
}

/**
 * 一次性配对码（计划 §6.1）。
 *
 * 只存哈希：配对码在 TTL 内等价于设备凭证，泄露即可注册任意设备。
 */
export interface PairingCodeRecord {
  code_hash: string
  device_name: string
  expires_at: number
  used_at: number | null
  created_at: number
}

/**
 * 发送任务（计划 §7.3 outbound）。
 *
 * 状态机 pending → accepted → sent → delivered，任一步可转 failed。
 * 每一步都落库，控制台上能看到完整过程——上游 SmsForwarder 在这块体验较糙，
 * 是明确的改进点（计划 §5.5）。
 */
export interface OutboundRecord {
  id: string
  device_id: string
  to_number: string
  content_enc: Uint8Array
  sim_slot: number | null
  status: 'pending' | 'accepted' | 'sent' | 'delivered' | 'failed'
  error: string | null
  created_at: number
  updated_at: number
}


/** 发送记录的筛选条件。收件人号码是明文列，可以直接走 SQL。 */
export interface OutboundFilter {
  device_id?: string | null
  status?: OutboundRecord['status'] | null
  /** 收件人号码的部分匹配 */
  to?: string | null
}

/** 会话。token 只存哈希；绑定 UA 与 IP 段，减少凭证被盗后异地复用（计划 §6.3）。 */
export interface SessionRecord {
  token_hash: string
  ua_hash: string
  ip_prefix: string
  created_at: number
  expires_at: number
  revoked: boolean
}

/**
 * 推送消息 → 事件 的映射，用于「Reply 即回复」。
 *
 * 落库而不是放内存 LRU：硬约束④要求进程内状态必须能从存储重建，
 * 而这个映射一丢，用户引用回复旧消息就会失败——恰恰是最常用的交互。
 */
export interface MessageRefRecord {
  channel_id: string
  /** 渠道侧的消息标识，如 Telegram 的 message_id */
  ref: string
  event_id: string
  /** 原始发件人，回复时作为收件人 */
  sender: string
  device_id: string
  created_at: number
}

/**
 * 计划任务。
 *
 * 用独立表而不是塞进 settings 的 JSON：任务有状态（上次执行、失败计数）
 * 且会增删改，塞在一个 JSON 里每次都要整体读写，并发下容易互相覆盖。
 */
export interface TaskRecord {
  id: string
  name: string
  enabled: boolean
  /** 空串表示任意在线设备，仅适用于单设备部署 */
  device_id: string
  to_number: string
  content_enc: Uint8Array
  /** JSON，结构见 schedule.ts 的 Schedule */
  schedule_json: string
  last_run_at: number | null
  last_status: 'ok' | 'failed' | null
  fail_count: number
  created_at: number
}

export interface Store {
  /** 启动时执行迁移。必须幂等。 */
  migrate(): Promise<void>

  // 设备
  getDevice(id: string): Promise<DeviceRecord | null>
  listDevices(): Promise<DeviceRecord[]>
  createDevice(d: DeviceRecord): Promise<void>
  /** 握手成功后更新在线状态与遥测 */
  /** 更新心跳与电量等。**不得把 revoked 状态改回去**——吊销是终态。 */
  touchDevice(id: string, patch: Partial<Pick<DeviceRecord, 'status' | 'last_seen_at' | 'battery' | 'charging' | 'app_version'>>): Promise<void>
  /** 记录最近一次定位。单独一个方法，避免定位数据混进高频的心跳更新里 */
  setDeviceLocation(id: string, enc: Uint8Array, at: number): Promise<void>
  /**
   * 彻底删除设备记录。
   *
   * **只允许删已吊销的**（调用方负责检查）：删一台还在线的设备，
   * 它的 Agent 下次握手会收到 AUTH_UNKNOWN_DEVICE 而彻底停下来，
   * 得跑到手机跟前重新配对。吊销是那个「我确认这台不要了」的动作，
   * 删除只是事后打扫。
   *
   * @returns 是否真的删掉了
   */
  deleteDevice(id: string): Promise<boolean>
  /** 删除这台设备的全部发送记录，返回条数。删设备时可选一并清理。 */
  deleteOutboundByDevice(deviceId: string): Promise<number>
  /**
   * 吊销设备：置为 revoked **并作废凭证**。
   *
   * 两件事缺一不可——只改状态的话，断线时的 touchDevice 会把它覆盖回 offline，
   * 设备拿着原 token 重连就又活了。实现必须保证吊销后无法再握手成功。
   */
  revokeDevice(id: string): Promise<void>

  // 渠道
  listChannels(): Promise<ChannelRecord[]>
  getChannel(id: string): Promise<ChannelRecord | null>
  upsertChannel(c: ChannelRecord): Promise<void>
  deleteChannel(id: string): Promise<void>

  // 规则
  listRules(): Promise<RuleRecord[]>
  upsertRule(r: RuleRecord): Promise<void>
  deleteRule(id: string): Promise<void>

  // 配对码
  createPairingCode(p: PairingCodeRecord): Promise<void>
  /** 按哈希取出未使用且未过期的配对码 */
  takePairingCode(codeHash: string, now: number): Promise<PairingCodeRecord | null>

  // 计划任务
  listTasks(): Promise<TaskRecord[]>
  getTask(id: string): Promise<TaskRecord | null>
  upsertTask(t: TaskRecord): Promise<void>
  deleteTask(id: string): Promise<void>
  /** 只更新执行状态，不动配置——避免执行时把用户正在编辑的配置覆盖回去 */
  updateTaskRun(id: string, patch: { last_run_at: number; last_status: 'ok' | 'failed'; fail_count: number }): Promise<void>
  setTaskEnabled(id: string, enabled: boolean): Promise<void>

  // 推送消息映射
  putMessageRef(r: MessageRefRecord): Promise<void>
  getMessageRef(channelId: string, ref: string): Promise<MessageRefRecord | null>
  /** 清理过期映射，保留期由调用方决定（计划 §11.4 建议 7 天） */
  cleanupMessageRefs(before: number): Promise<void>

  // 设置（管理员口令哈希、TOTP 密钥、初始化标记）
  getSetting(key: string): Promise<string | null>
  setSetting(key: string, value: string): Promise<void>

  // 会话
  createSession(s: SessionRecord): Promise<void>
  getSession(tokenHash: string): Promise<SessionRecord | null>
  touchSession(tokenHash: string, expiresAt: number): Promise<void>
  revokeSession(tokenHash: string): Promise<void>
  /** 全端下线：改口令或发现异常时使用 */
  revokeAllSessions(): Promise<void>
  /** 清理过期会话，启动时与定期调用 */
  cleanupSessions(now: number): Promise<void>

  // 发送任务
  createOutbound(o: OutboundRecord): Promise<void>
  getOutbound(id: string): Promise<OutboundRecord | null>
  listOutbound(limit: number, offset: number, filter?: OutboundFilter): Promise<OutboundRecord[]>
  /** 分页要的总数。过滤条件与 listOutbound 一致。 */
  countOutbound(filter?: OutboundFilter): Promise<number>
  /** 删除一条发送记录。返回是否真的删掉了 */
  deleteOutbound(id: string): Promise<boolean>
  /**
   * 状态机推进。只允许前进不允许后退：delivered 之后再收到 sent 必须忽略，
   * 因为多段短信的回执顺序不保证。
   */
  advanceOutbound(id: string, status: OutboundRecord['status'], error: string | null, at: number): Promise<void>

  // 审计
  audit(entry: { actor: string | null; action: string; detail: string | null; ip: string | null; created_at: number }): Promise<void>

  // 事件
  /**
   * 按 id 幂等写入。已存在时不覆盖、返回 'duplicate'。
   * 这是断网补传不产生重复记录的唯一保证（计划 §5.4）。
   */
  insertEvent(e: StoredEvent): Promise<InsertEventResult>
  getEvent(id: string): Promise<StoredEvent | null>
  listEvents(q: EventQuery): Promise<StoredEvent[]>
  /** 满足索引列条件的总数，用于分页。不含正文/号码过滤。 */
  countEvents(f: EventFilter): Promise<number>
  /** 记录命中的规则 id，事件已入库后回填 */
  setMatchedRules(eventId: string, ruleIds: string[]): Promise<void>
  /** 删除单条。返回是否真的删掉了（不存在时为 false） */
  deleteEvent(id: string): Promise<boolean>
  /**
   * 按条件批量删除，返回删除条数。
   *
   * 只接受 SQL 能过滤的维度——关键词要逐条解密，而「解密一遍再删」这种
   * 操作一旦条件写错就是不可逆的批量误删，不值得为它承担风险。
   */
  deleteEvents(filter: EventFilter): Promise<number>

  close(): Promise<void>
}


/** 把存储层的 RuleRecord 解析成引擎用的 Rule。解析失败的规则应被跳过而非中断整链。 */
export type ParsedRule = {
  id: string
  name: string
  priority: number
  enabled: boolean
  match: RuleMatch
  action: RuleAction
}
