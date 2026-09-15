/**
 * 保号任务（计划 §10.3）。
 *
 * 中国移动对长期零消费、长期异地漫游的号码有停机策略。定期发一条短信
 * 产生使用记录，比哪天突然收不到验证码再去补救省事得多。
 *
 * 时间模型用「首次执行的绝对时刻 + 间隔天数」，而不是「每月第 N 天」：
 *  - 绝对时刻避开了时区歧义。服务端在 UTC 跑，用户在东京看，
 *    「每月 1 日」到底指谁的 1 日是说不清的
 *  - 间隔天数比「每月」更通用：运营商的判定窗口不一定是自然月
 *
 * 连续失败要告警：这个任务失败是静默的——号码被停机之前不会有任何征兆。
 */
import { log } from './logging.js'
import type { Store } from './store.js'

export interface KeepAliveConfig {
  enabled: boolean
  /** 目标号码。发给自己的另一个号码或常用联系人都可以 */
  to: string
  text: string
  /** 重复间隔（天）。1-365 */
  interval_days: number
  /** 首次执行的绝对时刻（epoch ms）。留 null 表示「保存后立即开始计时」 */
  first_run_at: number | null
}

export const DEFAULT_KEEPALIVE: KeepAliveConfig = {
  enabled: false,
  to: '',
  text: '保号',
  interval_days: 30,
  first_run_at: null,
}

export const SETTING_KEY = 'keepalive'
export const LAST_RUN_KEY = 'keepalive_last_run_at'
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

const clampInt = (v: unknown, min: number, max: number, dflt: number): number => {
  const n = Number(v)
  if (!Number.isFinite(n)) return dflt
  return Math.min(Math.max(Math.round(n), min), max)
}

export async function loadConfig(store: Store): Promise<KeepAliveConfig> {
  const raw = await store.getSetting(SETTING_KEY)
  if (!raw) return DEFAULT_KEEPALIVE
  try {
    const p = JSON.parse(raw) as Record<string, unknown>
    return {
      enabled: p.enabled === true,
      to: typeof p.to === 'string' ? p.to : '',
      text: typeof p.text === 'string' && p.text ? p.text : DEFAULT_KEEPALIVE.text,
      interval_days: clampInt(
        // 兼容旧配置：原来是「每月第 day 天」，语义上最接近 30 天一次
        p.interval_days ?? (p.day !== undefined ? 30 : undefined),
        1, 365, DEFAULT_KEEPALIVE.interval_days,
      ),
      first_run_at: typeof p.first_run_at === 'number' && p.first_run_at > 0 ? p.first_run_at : null,
    }
  } catch {
    return DEFAULT_KEEPALIVE
  }
}

/**
 * 下次应执行的时刻。
 *
 * 跑过就从上次执行时间推，没跑过就用首次执行时刻；两者都没有
 * （老配置或没设首次时间）则视为立即到期。
 */
export function nextDueAt(cfg: KeepAliveConfig, lastRunAt: number | null): number {
  if (lastRunAt !== null) return lastRunAt + cfg.interval_days * 86_400_000
  return cfg.first_run_at ?? 0
}

export interface KeepAliveStatus {
  last_run_at: number | null
  next_due_at: number | null
  consecutive_failures: number
}

export async function status(store: Store): Promise<KeepAliveStatus> {
  const cfg = await loadConfig(store)
  const lastRaw = await store.getSetting(LAST_RUN_KEY)
  const lastRunAt = lastRaw ? Number(lastRaw) : null
  return {
    last_run_at: Number.isFinite(lastRunAt) ? lastRunAt : null,
    next_due_at: cfg.enabled ? nextDueAt(cfg, lastRunAt) : null,
    consecutive_failures: Number((await store.getSetting(FAIL_COUNT_KEY)) ?? 0),
  }
}

/**
 * 检查并在需要时执行。适配层每小时调用一次即可。
 *
 * @param force 忽略排期立即发送一次（控制台的「立即测试」）。
 *              不推进排期——测试不该顶掉正常的下一次。
 */
export async function tick(deps: KeepAliveDeps, force = false): Promise<{ sent: boolean; reason?: string }> {
  const now = deps.now?.() ?? Date.now()
  const cfg = await loadConfig(deps.store)

  if (!force) {
    if (!cfg.enabled) return { sent: false, reason: '未启用' }
    if (!cfg.to) return { sent: false, reason: '未设置目标号码' }

    const lastRaw = await deps.store.getSetting(LAST_RUN_KEY)
    const lastRunAt = lastRaw ? Number(lastRaw) : null
    if (now < nextDueAt(cfg, Number.isFinite(lastRunAt) ? lastRunAt : null)) {
      return { sent: false, reason: '未到执行时间' }
    }
  } else if (!cfg.to) {
    return { sent: false, reason: '未设置目标号码' }
  }

  const device = deps.onlineDevice()
  if (!device) {
    // 不推进排期：设备上线后会重试。漏一次比乱发一次好处理
    if (!force) log.warn('保号任务：没有在线设备，稍后重试')
    return { sent: false, reason: '没有在线设备' }
  }

  const ok = await deps.send(device, cfg.to, cfg.text).catch(() => false)

  if (force) {
    // 测试发送不写排期、不计入失败统计，纯粹验证链路是否通
    log.info('保号任务手动测试', { ok })
    return { sent: ok, ...(ok ? {} : { reason: '下发失败' }) }
  }

  // 无论成败都推进排期，避免失败时每小时重发一条短信
  await deps.store.setSetting(LAST_RUN_KEY, String(now))

  const fails = Number((await deps.store.getSetting(FAIL_COUNT_KEY)) ?? 0)
  if (ok) {
    if (fails > 0) await deps.store.setSetting(FAIL_COUNT_KEY, '0')
    log.info('保号短信已下发')
    await deps.store.audit({ actor: 'keepalive', action: 'keepalive.sent', detail: null, ip: null, created_at: now })
    return { sent: true }
  }

  const n = fails + 1
  await deps.store.setSetting(FAIL_COUNT_KEY, String(n))
  log.error('保号短信下发失败', { consecutive_failures: n })
  await deps.store.audit({ actor: 'keepalive', action: 'keepalive.failed', detail: `连续第 ${n} 次`, ip: null, created_at: now })

  if (n >= ALERT_AFTER_FAILURES) {
    await deps.alert(
      '⚠️ 保号任务连续失败',
      `保号短信已连续 ${n} 次未能发出。号码长期零消费可能被停机，届时验证码将完全收不到，且不会有任何提示。请检查设备与话费余额。`,
    )
  }
  return { sent: false, reason: '下发失败' }
}
