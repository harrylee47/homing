/**
 * 记录指纹：用来判断「手机上那条」和「网关里这条」是不是同一条。
 *
 * 为什么不能直接比 id：实时捕获的事件 id 是随机 UUID，手机本地库里没有这个 id；
 * 历史导入的 id 才带行号。两条采集路径的产物必须能互相认出来，否则镜像同步
 * 会把实时捕获的记录当成「手机上已删除」而删掉。
 *
 * 为什么不能比时间戳：同一条短信，实时捕获记的是广播到达时刻，手机库里记的是
 * 消息时间，差几百毫秒到一两秒。所以时间只用于**框定范围**，不参与相等判断。
 */

/** 号码归一：不同采集路径拿到的号码可能带空格或连字符。 */
const normalizeNumber = (n: string): string => n.replace(/[\s\-()]/g, '')

/**
 * 计算指纹。两端必须用同一套规则，改动要同步 Kotlin 侧的 HistoryImporter。
 *
 * **通话不把正文计入**：同一通电话经三条路径生成的描述文字不一样
 * （实时是「已接来电」，导入是「已接来电 · 通话 1分20秒」），
 * 把它算进去会让同一通电话的指纹对不上，于是被误判成「手机已删除」。
 * 通话靠「号码 + 时间窗」就足以区分——同一号码 5 秒内两通独立来电不存在。
 */
export async function eventFingerprint(
  kind: string,
  from: string,
  content: string,
): Promise<string> {
  const material = kind === 'call'
    ? `call|${normalizeNumber(from)}`
    : `${kind}|${normalizeNumber(from)}|${content}`
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material))
  // 取前 16 个十六进制字符：碰撞概率远低于「同一号码同一秒两条不同短信」的概率，
  // 而几千条指纹的传输体积能小一半
  return [...new Uint8Array(digest)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** 手机上报的一条记录的指纹与时刻。 */
export interface PhoneFingerprint {
  fp: string
  at: number
}

export interface ReconcilePlan {
  /** 网关里有、手机上已经没有的事件 id —— 这些要删 */
  stale: string[]
  /** 实际参与比对的时间范围，界面上要说清楚删的是哪一段 */
  window: { since: number; until: number } | null
  /** 为什么没有可删的（或没法判断） */
  reason?: string
}

export interface GatewayEvent {
  id: string
  kind: string
  occurred_at: number
  fp: string
}

/**
 * 算出「网关里该删掉哪些」。
 *
 * 三条安全约束，每条都对应一种会误删的情形：
 *
 * 1. **只在手机列表覆盖的时间段里删**。手机的短信库通常只留几个月，而网关是
 *    长期归档。超出手机最老那条记录的部分，我们无从判断是「手机删了」还是
 *    「手机从来没存过」，一律不动。
 * 2. **手机一条都没报时直接放弃**。那多半是权限没给或者读库失败，
 *    而不是「用户把手机短信清空了」——按前者处理只会少删，按后者处理会清空归档。
 * 3. 时间戳只用于配对（±5 秒），不参与相等判断。
 */
export function planReconcile(
  gatewayEvents: GatewayEvent[],
  phone: PhoneFingerprint[],
  opts: { toleranceMs?: number; until: number },
): ReconcilePlan {
  const tolerance = opts.toleranceMs ?? 5000

  if (phone.length === 0) {
    return {
      stale: [],
      window: null,
      reason: '手机没有报告任何记录，无法判断哪些是被删掉的——为安全起见不做删除',
    }
  }

  // 下界取手机最老那条：再往前我们没有证据（见约束 1）
  const since = Math.min(...phone.map((p) => p.at))
  // 上界由调用方给（通常是「现在往前留一点余量」）。
  // 不能取「手机最新那条」——用户删掉的恰恰常常是最新几条，
  // 那样这些永远同步不掉；也不能取「现在」——刚收到还没落进手机库的那条会被误删。
  const until = opts.until

  // 按指纹分组，比对时只在同组里找时间接近的
  const byFp = new Map<string, number[]>()
  for (const p of phone) {
    const list = byFp.get(p.fp)
    if (list) list.push(p.at)
    else byFp.set(p.fp, [p.at])
  }

  const stale: string[] = []
  for (const e of gatewayEvents) {
    // 超出手机列表覆盖范围的不碰（约束 1）
    if (e.occurred_at < since - tolerance || e.occurred_at > until + tolerance) continue
    const candidates = byFp.get(e.fp)
    if (candidates?.some((at) => Math.abs(at - e.occurred_at) <= tolerance)) continue
    stale.push(e.id)
  }

  return { stale, window: { since, until } }
}
