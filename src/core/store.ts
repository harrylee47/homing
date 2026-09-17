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
  /** 归属用户。设备是一切数据的源头，它的归属决定了消息的归属 */
  user_id: string
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
  /** 归属用户。从设备继承——设备属于谁，它报上来的消息就属于谁 */
  user_id: string
  device_id: string
  kind: EventKind
  /** in=收到，out=设备发出。老记录为 null，按 in 处理 */
  direction: 'in' | 'out' | null
  /** 卡槽序号，0 = SIM1。未知（老记录、ROM 不给）为 null */
  sim_slot: number | null
  sender_enc: Uint8Array
  content_enc: Uint8Array
  enc_ver: number
  occurred_at: number
  received_at: number
  /** 命中的规则 id，JSON 数组字符串 */
  matched_rules: string | null
  created_at: number
}

/**
 * 只按索引列筛选的条件。正文与号码是密文，只能在内存里过滤。
 *
 * `user_id` 是**必填**的，故意的：多用户下漏掉一个作用域条件，
 * 就是把别人的银行验证码摆到你眼前。让它成为类型错误，而不是靠人记得写。
 */
export interface EventFilter {
  user_id: string
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
  /** 归属用户 */
  user_id: string
  type: string
  name: string
  config_enc: Uint8Array
  enabled: boolean
  created_at: number
}

export interface RuleRecord {
  id: string
  /** 归属用户 */
  user_id: string
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
  /** 归属用户。兑换出来的设备就归这个人 */
  user_id: string
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
/** 一条设备连接日志。字段刻意都是枚举或短串，不承载任何用户内容 */
export interface DeviceLogRecord {
  device_id: string
  user_id: string
  /** info=正常生命周期，warn=可自愈的异常，error=需要人介入 */
  level: 'info' | 'warn' | 'error'
  /** 机器可读的事件类型，如 online / offline / auth_rejected / heartbeat_timeout */
  event: string
  /** 给人看的一句话。不得包含正文、号码、凭证 */
  detail: string | null
  created_at: number
}

export interface OutboundRecord {
  id: string
  /** 归属用户 */
  user_id: string
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
  /** 必填，理由同 EventFilter */
  user_id: string
  device_id?: string | null
  status?: OutboundRecord['status'] | null
  /** 收件人号码的部分匹配 */
  to?: string | null
}

/** 会话。token 只存哈希；绑定 UA 与 IP 段，减少凭证被盗后异地复用（计划 §6.3）。 */
export interface SessionRecord {
  /** 登录的是谁 */
  user_id: string
  token_hash: string
  ua_hash: string
  ip_prefix: string
  created_at: number
  expires_at: number
  revoked: boolean
  /**
   * 用户勾了「在这台设备上保持登录」。
   *
   * 两个后果，都是用户明确换来的：有效期从 30 分钟变成 30 天；
   * **不再校验 IP 段**——手机在 WiFi 与流量之间切换、换个基站，IP 段就变了，
   * 严格绑定的话一天要重登好几次，而这正是这个选项要解决的问题。
   * UA 绑定仍然保留。
   */
  trusted: boolean
}

/**
 * 推送消息 → 事件 的映射，用于「Reply 即回复」。
 *
 * 落库而不是放内存 LRU：硬约束④要求进程内状态必须能从存储重建，
 * 而这个映射一丢，用户引用回复旧消息就会失败——恰恰是最常用的交互。
 */
export interface MessageRefRecord {
  /** 归属用户 */
  user_id: string
  channel_id: string
  /** 渠道侧的消息标识，如 Telegram 的 message_id */
  ref: string
  event_id: string
  /** 原始发件人，回复时作为收件人 */
  sender: string
  device_id: string
  /**
   * 原消息是哪张卡收到的。回复时必须用同一张卡。
   *
   * 和 device_id 是同一个道理：多卡场景下从别的卡发回去，
   * 对方看到的是一个陌生号码——只是这次「别的卡」在同一台手机上。
   */
  sim_slot: number | null
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
  /** 归属用户 */
  user_id: string
  name: string
  enabled: boolean
  /** 空串表示任意在线设备，仅适用于单设备部署 */
  device_id: string
  to_number: string
  content_enc: Uint8Array
  /**
   * 用哪张卡发。null = 系统默认卡。
   *
   * 保号是**按卡**的事：双卡机上两张卡各自都要定期产生使用记录，
   * 只绑设备的话另一张卡照样会被停机。
   */
  sim_slot: number | null
  /** JSON，结构见 schedule.ts 的 Schedule */
  schedule_json: string
  last_run_at: number | null
  last_status: 'ok' | 'failed' | null
  fail_count: number
  created_at: number
}

/**
 * 一个用户。
 *
 * 多用户不是「给控制台加几个账号」，而是**各自一套完全独立的数据**：
 * 设备、渠道、规则、任务、消息、通话，互相看不见。同住一个屋檐下的两个人
 * 各自插着自己的卡，凭什么要互相能读对方的银行验证码。
 *
 * 管理员的特权是建号、删号、停用、续期、**重置口令**。
 *
 * 关于「管理员看不到别人的消息」这句话，准确的说法是：
 * 他在控制台里读不到，但他能重置任何人的口令，从而以那个人的身份登录、
 * 看到全部短信。所以这是**「不会顺手看到」，不是「拿不到」**——
 * 面向用户的文案必须按后者写，写成前者就是一句站不住的承诺。
 *
 * 能做到的补偿是让这件事**留下痕迹且当事人会知道**：重置会写审计，
 * 并向被重置者自己的渠道推一条通知（审计日志他看不到，推送他收得到）。
 */
export interface UserRecord {
  id: string
  /** 登录名。区分大小写地存，比对时按小写 */
  name: string
  password_hash: string
  /** TOTP 密钥。与旧版单用户一致明文存——它和 DEK 一样躺在同一个库里 */
  totp_secret: string
  role: 'admin' | 'member'
  /** Bot 的 service token。每个用户一个，Bot 据此只能取到自己主人的数据 */
  bot_token: string
  disabled: boolean
  /**
   * 账号到期时刻。null = 永久。
   *
   * 到期后**所有服务都停**，不只是登不进控制台：手机断连、任务不跑、
   * 推送不发。判定统一走 core/users.ts 的 userActive——四条鉴权路径
   * 每一条都要问它，漏一条就等于没做。
   */
  expires_at: number | null
  /** 同意隐私声明的版本与时刻。没同意过的老账号为 null */
  agreed_version: string | null
  agreed_at: number | null
  created_at: number
}

/**
 * 邀请码。
 *
 * 语义等同配对码：在有效期内拿到码就能开一个能看银行验证码的账号。
 * 所以待遇也一样——**只存哈希**，兑换是「取出即标记已用」的原子操作。
 * 拆成「先查再更新」两步的话，并发下同一个码能开出两个号。
 */
export interface InviteRecord {
  code_hash: string
  created_by: string
  /** 给管理员自己看的备注：这个码是发给谁的 */
  note: string | null
  /** 用这个码注册出来的账号能用多少天。null = 永久 */
  valid_days: number | null
  /** 码本身的过期时刻——没人用也会失效，别让它永远躺在那儿 */
  expires_at: number
  used_at: number | null
  used_by: string | null
  created_at: number
}

export interface Store {
  /** 启动时执行迁移。必须幂等。 */
  migrate(): Promise<void>

  // 用户
  listUsers(): Promise<UserRecord[]>
  getUser(id: string): Promise<UserRecord | null>
  /** 按登录名查，大小写不敏感 */
  getUserByName(name: string): Promise<UserRecord | null>
  /** 按 bot service token 查。Bot 请求据此定位主人 */
  getUserByBotToken(token: string): Promise<UserRecord | null>
  upsertUser(u: UserRecord): Promise<void>
  /** 连同这个用户的全部数据一起删。返回各类删了多少条 */
  deleteUser(id: string): Promise<Record<string, number>>

  // 设备
  /** 按 id 取，不带作用域：WS 握手时只有 device_id，归属由返回的记录给出 */
  getDevice(id: string): Promise<DeviceRecord | null>
  listDevices(userId: string): Promise<DeviceRecord[]>
  /** 跨用户列出。只给巡检类用途（离线告警、在线数统计），不得用于任何面向界面的读取 */
  listAllDevices(): Promise<DeviceRecord[]>
  createDevice(d: DeviceRecord): Promise<void>
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
   * @returns 是否真的删掉了（不属于这个用户时为 false）
   */
  deleteDevice(id: string, userId: string): Promise<boolean>
  /** 删除这台设备的全部发送记录，返回条数。删设备时可选一并清理。 */
  deleteOutboundByDevice(deviceId: string, userId: string): Promise<number>
  /**
   * 吊销设备：置为 revoked **并作废凭证**。
   *
   * 两件事缺一不可——只改状态的话，断线时的 touchDevice 会把它覆盖回 offline，
   * 设备拿着原 token 重连就又活了。实现必须保证吊销后无法再握手成功。
   */
  revokeDevice(id: string, userId: string): Promise<void>

  // 渠道
  listChannels(userId: string): Promise<ChannelRecord[]>
  /** 跨用户列出。只给 Bot 轮询器这类基础设施用 */
  listAllChannels(): Promise<ChannelRecord[]>
  getChannel(id: string, userId: string): Promise<ChannelRecord | null>
  upsertChannel(c: ChannelRecord): Promise<void>
  deleteChannel(id: string, userId: string): Promise<void>

  // 规则
  listRules(userId: string): Promise<RuleRecord[]>
  upsertRule(r: RuleRecord): Promise<void>
  deleteRule(id: string, userId: string): Promise<void>

  // 邀请码
  listInvites(): Promise<InviteRecord[]>
  createInvite(i: InviteRecord): Promise<void>
  /**
   * 只看不取：校验这个码此刻有没有效，**不消费它**。
   *
   * 注册流程要先确认「这人拿着一个有效的码」再去查用户名，否则
   * 「用户名被占」与「邀请码无效」两种回答就成了不需要邀请码的枚举器。
   * 而如果为了避免枚举就先把码消费掉，名字撞车的人会白白烧掉一个码——
   * 所以必须是「先看、再查名、最后原子地取」三步。
   */
  peekInvite(codeHash: string, now: number): Promise<InviteRecord | null>
  /** 按哈希取出未使用且未过期的邀请码，**并原子地标记已用**。并发下只能成功一次 */
  takeInvite(codeHash: string, userId: string, now: number): Promise<InviteRecord | null>
  /** 撤销尚未使用的邀请码 */
  deleteInvite(codeHash: string): Promise<boolean>

  // 配对码
  createPairingCode(p: PairingCodeRecord): Promise<void>
  /** 按哈希取出未使用且未过期的配对码。不带作用域：兑换时还不知道是谁 */
  takePairingCode(codeHash: string, now: number): Promise<PairingCodeRecord | null>

  // 计划任务
  listTasks(userId: string): Promise<TaskRecord[]>
  /** 跨用户列出，给调度器用 */
  listAllTasks(): Promise<TaskRecord[]>
  getTask(id: string, userId: string): Promise<TaskRecord | null>
  upsertTask(t: TaskRecord): Promise<void>
  deleteTask(id: string, userId: string): Promise<void>
  /** 只更新执行状态，不动配置——避免执行时把用户正在编辑的配置覆盖回去 */
  updateTaskRun(id: string, patch: { last_run_at: number; last_status: 'ok' | 'failed'; fail_count: number }): Promise<void>
  setTaskEnabled(id: string, userId: string, enabled: boolean): Promise<void>

  // 推送消息映射
  putMessageRef(r: MessageRefRecord): Promise<void>
  getMessageRef(channelId: string, ref: string): Promise<MessageRefRecord | null>
  /** 清理过期映射，保留期由调用方决定（计划 §11.4 建议 7 天） */
  cleanupMessageRefs(before: number): Promise<void>

  // 设置分两层，别混用。
  //
  // 全局：部署级的东西——初始化标记、预置规则版本、Bark 对外可达性。
  // 按用户：**每个人自己的配置**——时区、短信指令口令、通知捕获范围、电量告警。
  //
  // 这个分界不是洁癖。短信指令的配置会经 hello_ack 下发到**每一台设备**，
  // 存成全局的话，任意一个登录用户都能读到口令明文、把自己的号码加进白名单，
  // 然后发一条短信查别人手机的定位。开放注册之后这就不是理论路径了。
  getSetting(key: string): Promise<string | null>
  setSetting(key: string, value: string): Promise<void>
  getUserSetting(userId: string, key: string): Promise<string | null>
  /**
   * 某个用户的全部设置。**只给配置导出用，且导出方必须按白名单过一遍**——
   * 这张表里还住着待绑的 TOTP 种子与找回码状态（见 core/backup.ts）。
   */
  listUserSettings(userId: string): Promise<Record<string, string>>
  setUserSetting(userId: string, key: string, value: string): Promise<void>

  // 会话
  createSession(s: SessionRecord): Promise<void>
  getSession(tokenHash: string): Promise<SessionRecord | null>
  touchSession(tokenHash: string, expiresAt: number): Promise<void>
  revokeSession(tokenHash: string): Promise<void>
  /** 全端下线：改口令或发现异常时使用。只下线这个用户自己的会话 */
  revokeAllSessions(userId: string): Promise<void>
  /** 清理过期会话，启动时与定期调用 */
  cleanupSessions(now: number): Promise<void>

  // 发送任务
  createOutbound(o: OutboundRecord): Promise<void>
  /** 不带作用域：回执要按 cmd_id 找回记录，那时只有 id */
  /**
   * 取一条发送记录。**userId 必填**——返回体里有解密后的正文与收件号码，
   * 而这个接口开放给 bot 作用域。同目录的 getEvent 一直是带作用域的，
   * 这个漏了；改成必填参数，让下次漏写变成编译错误而不是一条静默的越权查询。
   */
  getOutbound(id: string, userId: string): Promise<OutboundRecord | null>
  listOutbound(limit: number, offset: number, filter: OutboundFilter): Promise<OutboundRecord[]>
  /** 分页要的总数。过滤条件与 listOutbound 一致。 */
  countOutbound(filter: OutboundFilter): Promise<number>
  /** 删除一条发送记录。返回是否真的删掉了 */
  deleteOutbound(id: string, userId: string): Promise<boolean>
  /**
   * 状态机推进。只允许前进不允许后退：delivered 之后再收到 sent 必须忽略，
   * 因为多段短信的回执顺序不保证。
   */
  advanceOutbound(id: string, status: OutboundRecord['status'], error: string | null, at: number): Promise<void>

  // 审计
  /** 审计日志。user_id 可选——它是日志不是查询面，漏填只是少一个筛选维度 */
  audit(entry: { user_id?: string | null; actor: string | null; action: string; detail: string | null; ip: string | null; created_at: number }): Promise<void>

  /**
   * 设备连接日志：记下服务端这一侧看得见的每一件事。
   *
   * 「设备不在线」只有一个比特的信息量，排查时真正有用的是**在那之前发生了什么**——
   * 是被吊销了、凭证不对、账号到期、心跳超时，还是它自己断开又连了十几次。
   * 这些服务端本来就知道，只是从前只写进 stdout，翻不到、也没法按设备看。
   *
   * **只记结构化字段，绝不记短信正文、号码、验证码或凭证。**
   * 这张表会经控制台展示给人看，它的脱敏标准与日志输出相同。
   */
  appendDeviceLog(r: DeviceLogRecord): Promise<void>
  /** 某台设备的日志，新的在前。userId 必填——不属于自己的设备一个字都不该看到 */
  listDeviceLogs(deviceId: string, userId: string, limit: number): Promise<DeviceLogRecord[]>
  /** 清掉过老的连接日志。它是诊断数据，不是档案 */
  cleanupDeviceLogs(before: number): Promise<void>

  // 事件
  /**
   * 按 id 幂等写入。已存在时不覆盖、返回 'duplicate'。
   * 这是断网补传不产生重复记录的唯一保证（计划 §5.4）。
   */
  insertEvent(e: StoredEvent): Promise<InsertEventResult>
  getEvent(id: string, userId: string): Promise<StoredEvent | null>
  listEvents(q: EventQuery): Promise<StoredEvent[]>
  /** 满足索引列条件的总数，用于分页。不含正文/号码过滤。 */
  countEvents(f: EventFilter): Promise<number>
  /** 记录命中的规则 id，事件已入库后回填 */
  setMatchedRules(eventId: string, ruleIds: string[]): Promise<void>
  /** 删除单条。返回是否真的删掉了（不存在或不属于这个用户时为 false） */
  deleteEvent(id: string, userId: string): Promise<boolean>
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
