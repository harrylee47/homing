/**
 * 消息保留上限。
 *
 * 短信、通话、应用通知各自一个上限，超出的按 `occurred_at` 从旧到新删除。
 *
 * 这个模块存在的前提是一条反向约束：**在此之前事件是永不删除的**，
 * `core/search.ts` 的整套设计（不设「最多扫 N 条」的硬上限、搜不完就如实
 * 告诉你搜到了哪一天）就建立在「几个月前那条一定还在库里」上。
 * 加上限等于推翻这个前提，所以两件事必须做到：
 *
 * ① **已有账号默认不限制。** 设置不存在 = 不限制，而不是「取个默认值」。
 *    上线一个功能就把别人几年的短信删掉，是这里唯一不可接受的失败。
 *    默认值只写给**新建**的账号。
 * ② 上限生效后界面要说明，否则「搜不到三个月前那条」会被当成搜索坏了。
 */

/**
 * 走 `events` 表的三类。
 *
 * 它们各自对应 `events.kind`，所以能共用 `trimEvents`。
 */
export const RETAINABLE_KINDS = ['sms', 'call', 'notification'] as const
export type RetainableKind = (typeof RETAINABLE_KINDS)[number]

/**
 * 能设上限的四项 —— 比上面多一个 `outbound`（网关自己发出去的短信）。
 *
 * 它在**另一张表**、另一套字段（没有 occurred_at，只有 created_at），所以
 * 不能共用 trimEvents，要单独一条路。但它必须在这里，理由是会话视图：
 * CLAUDE.md 要求「事件流与 outbound 表要并成一条时间线」——那是「像短信 App
 * 一样」的全部意义。只管收到的那一半，老时段里收到的被删了、发出去的还在，
 * 同一段对话看起来就像自言自语。
 *
 * 顺带这也让设置项的名字对得上：叫「消息保留上限」却不管发送记录，
 * 用户设完发现发送记录一条没少，会以为功能坏了。
 */
export const RETENTION_KEYS = ['sms', 'call', 'notification', 'outbound'] as const
export type RetentionKey = (typeof RETENTION_KEYS)[number]

/**
 * 可选的上限档位。
 *
 * 给下拉不给文本框（CLAUDE.md：控制台里不要让人手写枚举值）。
 * 手写一个 999 和手写一个 99 在界面上长得差不多，而后者会多删掉 900 条。
 */
export const RETENTION_CHOICES = [0, 200, 500, 999, 2000, 5000, 20000] as const

/** 新账号的默认上限。已有账号**不套用**这个值——见文件头 ①。 */
export const DEFAULT_RETENTION = 999

/** 存在 user_settings 里的键。 */
export const RETENTION_SETTING = 'retention'

/** 一个账号的四档上限。`0` 表示不限制。 */
export type RetentionConfig = Record<RetentionKey, number>

export const UNLIMITED: RetentionConfig = { sms: 0, call: 0, notification: 0, outbound: 0 }

/**
 * 把存的字符串解析成配置。
 *
 * **解析不出来一律回落到「不限制」**，而不是回落到默认值。这条方向不能反：
 * 设置被写坏时，「不限制」的代价是多存了一些消息，「默认 999」的代价是
 * 把人家几万条历史删到只剩 999 条——而且是在他完全不知情的情况下。
 * 坏数据要往安全的方向塌。
 */
export function parseRetention(raw: string | null): RetentionConfig {
  if (!raw) return { ...UNLIMITED }
  try {
    const o = JSON.parse(raw) as Record<string, unknown>
    if (!o || typeof o !== 'object' || Array.isArray(o)) return { ...UNLIMITED }
    const out = { ...UNLIMITED }
    for (const k of RETENTION_KEYS) {
      const v = o[k]
      // 只接受非负整数。负数、NaN、Infinity、字符串 "999" 一律当没设——
      // 「999」这种字符串是最容易从手写 JSON 里混进来的，
      // 而它一旦被 Number() 悄悄转成 999，就是一次静默的批量删除
      if (typeof v === 'number' && Number.isInteger(v) && v >= 0) out[k] = v
    }
    return out
  } catch {
    return { ...UNLIMITED }
  }
}

/** 界面提交上来的配置：只认档位里的值，其余一律当「不限制」。 */
export function sanitizeRetention(input: unknown): RetentionConfig {
  const o = (input ?? {}) as Record<string, unknown>
  const out = { ...UNLIMITED }
  for (const k of RETENTION_KEYS) {
    const v = Number(o[k])
    if ((RETENTION_CHOICES as readonly number[]).includes(v)) out[k] = v
  }
  return out
}

export const serializeRetention = (c: RetentionConfig): string => JSON.stringify(c)

/** 新账号建号时写的那份。 */
export const newAccountRetention = (): RetentionConfig => ({
  sms: DEFAULT_RETENTION, call: DEFAULT_RETENTION,
  notification: DEFAULT_RETENTION, outbound: DEFAULT_RETENTION,
})

/**
 * 这一轮该删多少条。
 *
 * 分开成纯函数是为了能测：清理任务本身要碰数据库，而「该不该删、删几条」
 * 这件事不该混在里面。`batch` 是单轮上限——首次生效时可能要删十几万行，
 * 一条 SQL 干完会把库锁住，而这期间正好有事件在写入。
 */
export function overflow(total: number, limit: number, batch: number): number {
  if (limit <= 0) return 0          // 不限制
  if (total <= limit) return 0
  return Math.min(total - limit, batch)
}

/** 清理任务要用到的那部分存储能力。不依赖整个 Store，好测。 */
export interface RetentionStore {
  listUsers(): Promise<{ id: string }[]>
  getUserSetting(userId: string, key: string): Promise<string | null>
  countEventsByKind(userId: string, kind: RetainableKind): Promise<number>
  trimEvents(userId: string, kind: RetainableKind, keep: number, batch: number, before: number): Promise<number>
  /** 发送记录走另一张表：没有 occurred_at，按 created_at 排 */
  countOutbound(filter: { user_id: string }): Promise<number>
  trimOutbound(userId: string, keep: number, batch: number, before: number): Promise<number>
}

/** 单轮单类最多删多少条。见 overflow() 上面那段为什么要分批。 */
export const TRIM_BATCH = 2000

/**
 * 护栏：**最近这段时间内到达的消息，一律不自动删**。
 *
 * 排序用的是 `occurred_at`，而它是**设备生成的**——协议里 `Timestamp` 只要求
 * 非负整数，`CLOCK_SKEW_TOLERANCE_MS` 的注释还显式说明它只约束帧的 ts、
 * 不约束 `event.occurred_at`（补传时它本来就可以是几天前）。
 *
 * 在「事件永不删除」的年代这个决定是对的：手机时钟错了，最多把列表排乱。
 * 加了保留上限之后，同一个字段从「展示顺序」升级成了「谁生谁死的判据」，
 * 而它是设备可控、且已知不可靠的。一台时钟跑偏的手机，新收到的验证码会
 * 带着一个很旧的 occurred_at 进来，排在保留窗口之外，当轮就被删掉。
 *
 * 所以删除的条件里再加一道 `received_at`——那是落库时用**服务端**时钟写的
 * （session.ts），设备伪造不了。代价是上限在这个窗口内是近似的；
 * 换来的是「刚到手的消息，不管手机时钟多离谱，都不会被自动删掉」。
 *
 * 顺带它还兜住两件事：补传途中被清理（补传是按 occurred_at 升序上来的，
 * 最老的先到，而清理删的正是最老的），以及刚导入的那一批被当轮清空。
 */
export const TRIM_GUARD_MS = 60 * 60 * 1000

/**
 * 跑一轮清理，返回每个账号每一类实际删了多少。
 *
 * **逐个账号、逐个类型各自判断**，不做任何跨账号的合并查询。这一条是
 * 刻意的笨办法：多用户隔离在这个项目里是靠类型强制的（EventFilter 的
 * user_id 必填、listXxx 的 userId 必填），而清理任务是少数几个必须跨用户
 * 遍历的地方之一，一旦在这里图快写一条「WHERE kind = ?」的批量语句，
 * 删掉的就是所有人的历史。宁可多跑几次查询。
 */
export async function runRetention(
  store: RetentionStore,
  batch = TRIM_BATCH,
  now = Date.now(),
): Promise<{ user_id: string; kind: RetentionKey; deleted: number }[]> {
  const out: { user_id: string; kind: RetentionKey; deleted: number }[] = []
  const guard = now - TRIM_GUARD_MS
  for (const u of await store.listUsers()) {
    const cfg = parseRetention(await store.getUserSetting(u.id, RETENTION_SETTING))
    for (const kind of RETAINABLE_KINDS) {
      const limit = cfg[kind]
      if (limit <= 0) continue          // 不限制
      const total = await store.countEventsByKind(u.id, kind)
      if (overflow(total, limit, batch) === 0) continue
      const deleted = await store.trimEvents(u.id, kind, limit, batch, guard)
      if (deleted > 0) out.push({ user_id: u.id, kind, deleted })
    }
    if (cfg.outbound > 0) {
      const total = await store.countOutbound({ user_id: u.id })
      if (overflow(total, cfg.outbound, batch) > 0) {
        const deleted = await store.trimOutbound(u.id, cfg.outbound, batch, guard)
        if (deleted > 0) out.push({ user_id: u.id, kind: 'outbound', deleted })
      }
    }
  }
  return out
}


/**
 * 立刻把一个账号修剪到位，返回每类实际删了多少。
 *
 * 为什么要有这个：周期清理是**每小时**一次，而界面上那个按钮写的是
 * 「保存并删除 201 条」。保存完一小时内什么都不发生，是承诺与行为不符——
 * 人会以为没生效，然后再点一次、再选一次，甚至去怀疑设置没保存上。
 *
 * `maxRounds` 封顶：从「不限制」改到 999 的账号可能要删十几万行，
 * 不能让一次 HTTP 请求在那儿转几分钟。删不完的交给周期任务续上，
 * 调用方据此告诉用户「还在后台继续」。
 */
export async function trimUserNow(
  store: RetentionStore,
  userId: string,
  batch = TRIM_BATCH,
  maxRounds = 10,
  now = Date.now(),
): Promise<{ deleted: Record<RetentionKey, number>; done: boolean }> {
  const cfg = parseRetention(await store.getUserSetting(userId, RETENTION_SETTING))
  const deleted = { sms: 0, call: 0, notification: 0, outbound: 0 } as Record<RetentionKey, number>
  const guard = now - TRIM_GUARD_MS
  let done = true
  for (const kind of RETAINABLE_KINDS) {
    const limit = cfg[kind]
    if (limit <= 0) continue
    for (let i = 0; ; i++) {
      if (i >= maxRounds) { done = false; break }
      const n = await store.trimEvents(userId, kind, limit, batch, guard)
      deleted[kind] += n
      if (n < batch) break      // 这一轮没删满，说明已经到位
    }
  }
  if (cfg.outbound > 0) {
    for (let i = 0; ; i++) {
      if (i >= maxRounds) { done = false; break }
      const n = await store.trimOutbound(userId, cfg.outbound, batch, guard)
      deleted.outbound += n
      if (n < batch) break
    }
  }
  return { deleted, done }
}
