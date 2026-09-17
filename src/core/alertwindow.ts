/**
 * 告警压制窗口。
 *
 * 跨渠道告警原来是**按事件逐条无条件发**的：`pipeline.ts` 只判 `failed.length > 0`
 * 就调 `crossChannelAlert`。平时没事——量小，失败也少。补传时就不一样了：
 * 一批 50 条全部推送失败（比如 Telegram 那头正好挂着），就是 50 条告警从
 * 其余渠道涌出来，每条还各带最多 3 次重试。人本来想知道「Telegram 坏了」，
 * 拿到的是 50 条一模一样的通知把真正的验证码冲掉。
 *
 * 对照组是 `monitor.ts` 的设备离线告警——它一直有去重（`alerted` 集合），
 * 通知失败这一路一直没有。
 *
 * **但不能简单压掉。** 「窗口内又失败了 49 条」这件事本身就是信息：它区分
 * 「偶发一条」和「这个渠道整个瘫了」。所以压制期间**记数**，等窗口过去，
 * 下一条告警把这个数带上。
 *
 * 状态放**存储**不放进程内存：硬约束④只给 WS 连接表与 Bot 的 message_id
 * 缓存开了例外，这里不该再开一个。而且放存储还顺带解决了重启丢窗口的问题——
 * 部署一次就重新开闸放一轮风暴，恰恰发生在你最不想被吵的时候。
 */

/** 同一个键在这段时间内只发一条告警。 */
export const ALERT_WINDOW_MS = 10 * 60 * 1000

/** 存在用户设置里的键。 */
export const ALERT_WINDOW_SETTING = 'alert_window'

interface WindowEntry {
  /** 上一条真正发出去的告警的时刻 */
  at: number
  /** 从那以后被压掉的条数 */
  n: number
}

/** 读写用户设置的最小接口——不依赖整个 Store，好测。 */
export interface AlertWindowStore {
  getUserSetting(userId: string, key: string): Promise<string | null>
  setUserSetting(userId: string, key: string, value: string): Promise<void>
}

export interface AlertDecision {
  /** 现在该不该发 */
  send: boolean
  /** 若该发：上一条之后被压掉了多少条（0 表示没有） */
  suppressed: number
}

/**
 * 问一次「这条告警现在该不该发」，并把状态推进一格。
 *
 * `key` 要能代表「同一件事」——用失败渠道的 id，而不是事件 id：
 * 同一个渠道连续失败 50 次是一件事，不是 50 件。
 *
 * 竞态：两台设备同时失败时可能各读到旧值、各发一条。代价是多一条告警，
 * 不是少一条——这个方向是对的，宁可吵一次不可静默。
 */
export async function shouldAlert(
  store: AlertWindowStore,
  userId: string,
  key: string,
  now: number,
  windowMs: number = ALERT_WINDOW_MS,
): Promise<AlertDecision> {
  const all = await load(store, userId)
  const cur = all[key]

  if (cur && now - cur.at < windowMs) {
    all[key] = { at: cur.at, n: cur.n + 1 }
    await save(store, userId, all, now, windowMs)
    return { send: false, suppressed: 0 }
  }

  const suppressed = cur?.n ?? 0
  all[key] = { at: now, n: 0 }
  await save(store, userId, all, now, windowMs)
  return { send: true, suppressed }
}

async function load(store: AlertWindowStore, userId: string): Promise<Record<string, WindowEntry>> {
  const raw = await store.getUserSetting(userId, ALERT_WINDOW_SETTING)
  if (!raw) return {}
  try {
    const p = JSON.parse(raw) as unknown
    if (!p || typeof p !== 'object' || Array.isArray(p)) return {}
    const out: Record<string, WindowEntry> = {}
    for (const [k, v] of Object.entries(p as Record<string, unknown>)) {
      const e = v as { at?: unknown; n?: unknown }
      if (typeof e?.at === 'number' && typeof e?.n === 'number') out[k] = { at: e.at, n: e.n }
    }
    return out
  } catch {
    // 这条设置坏了不能挡住告警——读不出来就当没有窗口，照发
    return {}
  }
}

async function save(
  store: AlertWindowStore, userId: string,
  all: Record<string, WindowEntry>, now: number, windowMs: number,
): Promise<void> {
  /**
   * 顺手清掉早就过期的条目。
   *
   * 不清的话，这个 JSON 会随着「曾经失败过的渠道」单调增长，而渠道是可以
   * 反复增删的——删掉的渠道在这里留一条永不过期的垃圾。清理阈值取两倍
   * 窗口：刚过窗口的那条还留着，因为它的 `n` 还要报给下一条告警。
   */
  const keep: Record<string, WindowEntry> = {}
  for (const [k, v] of Object.entries(all)) {
    if (now - v.at < windowMs * 2) keep[k] = v
  }
  await store.setUserSetting(userId, ALERT_WINDOW_SETTING, JSON.stringify(keep))
}
