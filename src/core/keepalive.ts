/**
 * 保号任务（计划 §10.3）。
 *
 * 中国移动对长期零消费、长期异地漫游的号码有停机策略。定期发一条短信
 * 产生使用记录，比哪天突然收不到验证码再去补救省事得多。
 *
 * 连续失败要告警：这个任务失败是静默的——号码被停机之前不会有任何征兆。
 */
import { log } from './logging.js'
import type { Store } from './store.js'

export interface KeepAliveConfig {
  enabled: boolean
  /** 目标号码。发给自己的另一个号码或常用联系人都可以 */
  to: string
  /** 每月的第几天执行，1-28（避开月末不存在的日期） */
  day: number
  text: string
}

export const DEFAULT_KEEPALIVE: KeepAliveConfig = {
  enabled: false,
  to: '',
  day: 1,
  text: '保号',
}

export const SETTING_KEY = 'keepalive'
const LAST_RUN_KEY = 'keepalive_last_run'
const FAIL_COUNT_KEY = 'keepalive_fail_count'

/** 连续失败多少次触发告警。1 次可能是偶发，2 次说明有问题。 */
const ALERT_AFTER_FAILURES = 2

export interface KeepAliveDeps {
  store: Store
  /** 返回在线设备 id；没有在线设备就跳过本次 */
  onlineDevice(): string | null
  /** 下发送短信指令，返回是否已受理 */
  send(deviceId: string, to: string, text: string): Promise<boolean>
  alert(title: string, body: string): Promise<void>
  now?: () => number
}

export async function loadConfig(store: Store): Promise<KeepAliveConfig> {
  const raw = await store.getSetting(SETTING_KEY)
  if (!raw) return DEFAULT_KEEPALIVE
  try {
    const p = JSON.parse(raw) as Partial<KeepAliveConfig>
    return {
      enabled: p.enabled === true,
      to: typeof p.to === 'string' ? p.to : '',
      day: Math.min(Math.max(Number(p.day) || 1, 1), 28),
      text: typeof p.text === 'string' && p.text ? p.text : DEFAULT_KEEPALIVE.text,
    }
  } catch {
    return DEFAULT_KEEPALIVE
  }
}

/** yyyy-mm，用于「这个月是否已经跑过」的判断。 */
const monthKey = (ts: number): string => {
  const d = new Date(ts)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

/**
 * 检查并在需要时执行。适配层每小时调用一次即可。
 *
 * 用「本月是否已执行」而不是「今天是几号」判断，这样即便服务端在当天
 * 停机数小时，重启后仍会补上——错过一个月才是真的风险。
 */
export async function tick(deps: KeepAliveDeps): Promise<void> {
  const now = deps.now?.() ?? Date.now()
  const cfg = await loadConfig(deps.store)
  if (!cfg.enabled || !cfg.to) return

  const today = new Date(now).getUTCDate()
  if (today < cfg.day) return

  const thisMonth = monthKey(now)
  if ((await deps.store.getSetting(LAST_RUN_KEY)) === thisMonth) return

  const device = deps.onlineDevice()
  if (!device) {
    // 不标记本月已执行：设备上线后会重试
    log.warn('保号任务：没有在线设备，稍后重试')
    return
  }

  const ok = await deps.send(device, cfg.to, cfg.text).catch(() => false)
  // 无论成败都记为本月已执行，避免失败时每小时重发一条短信
  await deps.store.setSetting(LAST_RUN_KEY, thisMonth)

  const fails = Number((await deps.store.getSetting(FAIL_COUNT_KEY)) ?? 0)
  if (ok) {
    if (fails > 0) await deps.store.setSetting(FAIL_COUNT_KEY, '0')
    log.info('保号短信已下发', { month: thisMonth })
    await deps.store.audit({ actor: 'keepalive', action: 'keepalive.sent', detail: thisMonth, ip: null, created_at: now })
    return
  }

  const n = fails + 1
  await deps.store.setSetting(FAIL_COUNT_KEY, String(n))
  log.error('保号短信下发失败', { month: thisMonth, consecutive_failures: n })
  await deps.store.audit({ actor: 'keepalive', action: 'keepalive.failed', detail: `连续第 ${n} 次`, ip: null, created_at: now })

  if (n >= ALERT_AFTER_FAILURES) {
    await deps.alert(
      '⚠️ 保号任务连续失败',
      `保号短信已连续 ${n} 个月未能发出。号码长期零消费可能被停机，届时验证码将完全收不到，且不会有任何提示。请检查设备与话费余额。`,
    )
  }
}
