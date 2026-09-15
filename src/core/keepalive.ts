/**
 * 保号任务（计划 §10.3）。
 *
 * 中国移动对长期零消费、长期异地漫游的号码有停机策略。定期发一条短信
 * 产生使用记录，比哪天突然收不到验证码再去补救省事得多。
 *
 * **每张卡一个任务**：保号针对的是具体某个号码，多设备时「任意挑一台在线
 * 设备」等于该保的号没保——而且失败是静默的，到停机那天才会发现。
 *
 * 时间模型用「首次执行的绝对时刻 + 间隔天数」而不是「每月第 N 天」：
 * 绝对时刻避开时区歧义（服务端在 UTC 跑、用户在东京看），
 * 间隔天数也比自然月更贴近运营商的判定窗口。
 */
import { log } from './logging.js'
import type { Store } from './store.js'

export interface KeepAliveTask {
  id: string
  enabled: boolean
  /** 用哪台设备发。空串表示任意在线设备——仅适用于单设备部署。 */
  device_id: string
  /** 目标号码。发给自己的另一个号码或常用联系人都可以 */
  to: string
  text: string
  /** 重复间隔（天），1-365 */
  interval_days: number
  /** 首次执行的绝对时刻（epoch ms）。null 表示保存后立即开始 */
  first_run_at: number | null
}

export const SETTING_KEY = 'keepalive'
const lastRunKey = (id: string): string => `keepalive_last_run_at:${id}`
const failCountKey = (id: string): string => `keepalive_fail_count:${id}`

/** 连续失败多少次触发告警。1 次可能是偶发，2 次说明有问题。 */
const ALERT_AFTER_FAILURES = 2

export const newTask = (id: string): KeepAliveTask => ({
  id, enabled: false, device_id: '', to: '', text: '保号',
  interval_days: 30, first_run_at: null,
})

export interface KeepAliveDeps {
  store: Store
  /** 当前在线的设备 id */
  onlineDevices(): string[]
  /** 下发送短信指令，返回是否已受理 */
  send(deviceId: string, to: string, text: string): Promise<boolean>
  /** 设备名，用于告警文案 */
  deviceName?(id: string): string
  alert(title: string, body: string): Promise<void>
  now?: () => number
}

const clampInt = (v: unknown, min: number, max: number, dflt: number): number => {
  const n = Number(v)
  if (!Number.isFinite(n)) return dflt
  return Math.min(Math.max(Math.round(n), min), max)
}

function normalize(raw: unknown, index: number): KeepAliveTask {
  const p = (raw ?? {}) as Record<string, unknown>
  return {
    id: typeof p.id === 'string' && p.id ? p.id : `ka_${index}`,
    enabled: p.enabled === true,
    device_id: typeof p.device_id === 'string' ? p.device_id : '',
    to: typeof p.to === 'string' ? p.to : '',
    text: typeof p.text === 'string' && p.text ? p.text : '保号',
    interval_days: clampInt(p.interval_days ?? (p.day !== undefined ? 30 : undefined), 1, 365, 30),
    first_run_at: typeof p.first_run_at === 'number' && p.first_run_at > 0 ? p.first_run_at : null,
  }
}

/** 读取任务列表。兼容早期的单任务对象格式。 */
export async function loadTasks(store: Store): Promise<KeepAliveTask[]> {
  const raw = await store.getSetting(SETTING_KEY)
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed.map(normalize)
    // 早期是单个对象：迁移成一个任务，device_id 留空即「任意在线设备」
    const single = normalize(parsed, 0)
    return single.to || single.enabled ? [single] : []
  } catch {
    return []
  }
}

export async function saveTasks(store: Store, tasks: KeepAliveTask[]): Promise<void> {
  await store.setSetting(SETTING_KEY, JSON.stringify(tasks.map((t, i) => normalize(t, i))))
}

/**
 * 下次应执行的时刻。跑过就从上次执行时间推，没跑过用首次执行时刻；
 * 两者都没有则视为立即到期。
 */
export function nextDueAt(task: KeepAliveTask, lastRunAt: number | null): number {
  if (lastRunAt !== null) return lastRunAt + task.interval_days * 86_400_000
  return task.first_run_at ?? 0
}

export interface TaskStatus extends KeepAliveTask {
  last_run_at: number | null
  next_due_at: number | null
  consecutive_failures: number
}

export async function status(store: Store): Promise<TaskStatus[]> {
  const tasks = await loadTasks(store)
  return Promise.all(tasks.map(async (t) => {
    const lastRaw = await store.getSetting(lastRunKey(t.id))
    const lastRunAt = lastRaw !== null && Number.isFinite(Number(lastRaw)) ? Number(lastRaw) : null
    return {
      ...t,
      last_run_at: lastRunAt,
      next_due_at: t.enabled ? nextDueAt(t, lastRunAt) : null,
      consecutive_failures: Number((await store.getSetting(failCountKey(t.id))) ?? 0),
    }
  }))
}

export interface RunResult { sent: boolean; reason?: string }

/**
 * 挑执行设备。
 *
 * 指定了设备就必须用它——保号针对的是那张卡，换一台发等于没保。
 * 没指定（单设备部署）才回落到任意在线设备。
 */
function pickDevice(task: KeepAliveTask, online: string[]): string | null {
  if (task.device_id) return online.includes(task.device_id) ? task.device_id : null
  return online[0] ?? null
}

/** 执行单个任务。force=true 表示忽略排期立即发送（控制台的「立即测试」）。 */
export async function runTask(deps: KeepAliveDeps, task: KeepAliveTask, force = false): Promise<RunResult> {
  const now = deps.now?.() ?? Date.now()

  if (!task.to) return { sent: false, reason: '未设置目标号码' }

  if (!force) {
    if (!task.enabled) return { sent: false, reason: '未启用' }
    const lastRaw = await deps.store.getSetting(lastRunKey(task.id))
    const lastRunAt = lastRaw !== null && Number.isFinite(Number(lastRaw)) ? Number(lastRaw) : null
    if (now < nextDueAt(task, lastRunAt)) return { sent: false, reason: '未到执行时间' }
  }

  const online = deps.onlineDevices()
  const device = pickDevice(task, online)
  if (!device) {
    const which = task.device_id ? (deps.deviceName?.(task.device_id) ?? task.device_id) : '任意设备'
    // 不推进排期：设备上线后会重试。漏一次比用错卡发一次好处理
    if (!force) log.warn('保号任务：指定设备不在线，稍后重试', { task: task.id, device: which })
    return { sent: false, reason: `设备不在线（${which}）` }
  }

  const ok = await deps.send(device, task.to, task.text).catch(() => false)

  if (force) {
    // 测试不写排期、不计入失败统计，纯粹验证链路
    log.info('保号任务手动测试', { task: task.id, ok })
    return { sent: ok, ...(ok ? {} : { reason: '下发失败' }) }
  }

  // 无论成败都推进排期，避免失败时每小时重发一条短信
  await deps.store.setSetting(lastRunKey(task.id), String(now))

  const fails = Number((await deps.store.getSetting(failCountKey(task.id))) ?? 0)
  if (ok) {
    if (fails > 0) await deps.store.setSetting(failCountKey(task.id), '0')
    log.info('保号短信已下发', { task: task.id })
    await deps.store.audit({ actor: 'keepalive', action: 'keepalive.sent', detail: task.id, ip: null, created_at: now })
    return { sent: true }
  }

  const n = fails + 1
  await deps.store.setSetting(failCountKey(task.id), String(n))
  log.error('保号短信下发失败', { task: task.id, consecutive_failures: n })
  await deps.store.audit({ actor: 'keepalive', action: 'keepalive.failed', detail: `${task.id} 连续第 ${n} 次`, ip: null, created_at: now })

  if (n >= ALERT_AFTER_FAILURES) {
    const which = task.device_id ? (deps.deviceName?.(task.device_id) ?? task.device_id) : '设备'
    await deps.alert(
      '⚠️ 保号任务连续失败',
      `${which} 的保号短信已连续 ${n} 次未能发出。号码长期零消费可能被停机，` +
      `届时验证码将完全收不到，且不会有任何提示。请检查设备与话费余额。`,
    )
  }
  return { sent: false, reason: '下发失败' }
}

/** 检查全部任务。适配层每小时调用一次即可。 */
export async function tick(deps: KeepAliveDeps): Promise<void> {
  for (const task of await loadTasks(deps.store)) {
    await runTask(deps, task).catch((e: unknown) =>
      log.error('保号任务异常', { task: task.id, error: String(e) }),
    )
  }
}
