/**
 * 计划任务。
 *
 * 保号只是其中一种用法——定期发短信产生使用记录。同一套机制也能做
 * 每日提醒、每周汇报之类的事，所以做成通用的。
 *
 * 每个任务绑定设备：收件人看到的号码取决于用哪张卡，挑错等于用错身份。
 * 指定设备离线时**跳过并等它上线**，不换设备、不推进排期。
 */
import { log } from './logging.js'
import { describe, nextRun, Schedule } from './schedule.js'
import type { Store, TaskRecord } from './store.js'

export interface TaskDeps {
  store: Store
  /** 用户时区，IANA 名称如 Asia/Tokyo */
  timezone: string
  onlineDevices(): string[]
  send(userId: string, deviceId: string, to: string, text: string, simSlot: number | null): Promise<boolean>
  deviceName?(id: string): string
  /** 告警发给任务的主人，不是发给所有人 */
  alert(userId: string, title: string, body: string): Promise<void>
  now?: () => number
}

/** 连续失败多少次触发告警。1 次可能是偶发，2 次说明有问题。 */
const ALERT_AFTER_FAILURES = 2

/**
 * 可执行的任务：存储记录 + 解析后的排期 + 解密后的内容。
 *
 * 短信正文是加密落库的，解密发生在适配层——core 不持有密钥生命周期。
 */
export interface ParsedTask extends Omit<TaskRecord, 'schedule_json' | 'content_enc' | 'to_number'> {
  schedule: Schedule
  to: string
  text: string
}

/** 解析失败的任务会被跳过：一条坏配置不该让所有任务停摆。 */
export function parseTask(r: TaskRecord, text: string): ParsedTask | null {
  try {
    const { schedule_json, content_enc, to_number, ...rest } = r
    void content_enc
    return { ...rest, to: to_number, text, schedule: Schedule.parse(JSON.parse(schedule_json)) }
  } catch (e) {
    log.error('任务配置无法解析，已跳过', { task_id: r.id, error: String(e) })
    return null
  }
}

/**
 * 下次执行时刻。
 *
 * 没跑过时以创建时刻为锚点：早上 10 点建的「每天 9 点」任务，
 * 下一次应该是明天 9 点，而不是今天已经过去的 9 点。
 */
export function taskNextRun(task: ParsedTask, tz: string): number | null {
  const anchor = task.last_run_at ?? task.created_at
  return nextRun(task.schedule, anchor, tz, task.last_run_at)
}

export const describeTask = (task: ParsedTask): string => describe(task.schedule)

export interface RunResult { sent: boolean; reason?: string }

/**
 * 挑执行设备。指定了就必须用它；没指定（单设备部署）才回落到任意在线设备。
 */
function pickDevice(task: ParsedTask, online: string[]): string | null {
  if (task.device_id) return online.includes(task.device_id) ? task.device_id : null
  return online[0] ?? null
}

/** 执行一个任务。force=true 忽略排期立即执行（控制台的「立即测试」）。 */
export async function runTask(deps: TaskDeps, task: ParsedTask, force = false): Promise<RunResult> {
  const now = deps.now?.() ?? Date.now()

  if (!task.to) return { sent: false, reason: '未设置目标号码' }
  if (!force) {
    if (!task.enabled) return { sent: false, reason: '未启用' }
    const due = taskNextRun(task, deps.timezone)
    if (due === null) return { sent: false, reason: '没有后续执行' }
    if (now < due) return { sent: false, reason: '未到执行时间' }
  }

  const device = pickDevice(task, deps.onlineDevices())
  if (!device) {
    const which = task.device_id ? (deps.deviceName?.(task.device_id) ?? task.device_id) : '任意设备'
    // 不推进排期：设备上线后会重试。漏一次比用错卡发一次好收拾
    if (!force) log.warn('计划任务：指定设备不在线，稍后重试', { task_id: task.id, device: which })
    return { sent: false, reason: `设备不在线（${which}）` }
  }

  const ok = await deps.send(task.user_id, device, task.to, task.text, task.sim_slot).catch(() => false)

  if (force) {
    log.info('计划任务手动测试', { task_id: task.id, ok })
    return { sent: ok, ...(ok ? {} : { reason: '下发失败' }) }
  }

  // 无论成败都推进排期，避免失败时每分钟重发
  await deps.store.updateTaskRun(task.id, {
    last_run_at: now,
    last_status: ok ? 'ok' : 'failed',
    fail_count: ok ? 0 : task.fail_count + 1,
  })

  // 一次性任务执行后自动停用，避免它永远挂在列表里显示「没有后续执行」
  if (task.schedule.type === 'once') {
    await deps.store.setTaskEnabled(task.id, task.user_id, false)
  }

  if (ok) {
    log.info('计划任务已执行', { task_id: task.id, name: task.name })
    await deps.store.audit({ actor: 'task', action: 'task.sent', detail: task.name, ip: null, created_at: now })
    return { sent: true }
  }

  const n = task.fail_count + 1
  log.error('计划任务执行失败', { task_id: task.id, name: task.name, consecutive_failures: n })
  await deps.store.audit({ actor: 'task', action: 'task.failed', detail: `${task.name} 连续第 ${n} 次`, ip: null, created_at: now })

  if (n >= ALERT_AFTER_FAILURES) {
    const which = task.device_id ? (deps.deviceName?.(task.device_id) ?? task.device_id) : '设备'
    await deps.alert(
      task.user_id,
      `⚠️ 计划任务「${task.name}」连续失败`,
      `${which} 上的任务已连续 ${n} 次未能执行。` +
      `若这是保号任务，号码长期零消费可能被停机，届时验证码将完全收不到且不会有任何提示。` +
      `请检查设备与话费余额。`,
    )
  }
  return { sent: false, reason: '下发失败' }
}

/**
 * 检查全部任务。适配层每分钟调用一次——每日任务精确到分钟。
 *
 * @param decrypt 解密任务正文。放在参数里而不是 deps 里，是为了让
 *                「core 不碰密钥」这件事在签名上就看得见。
 */
export async function tick(
  deps: TaskDeps,
  decrypt: (enc: Uint8Array) => Promise<string>,
): Promise<void> {
  // 调度器要跑所有人的任务，作用域在每条任务自己的 user_id 上
  for (const row of await deps.store.listAllTasks()) {
    const text = await decrypt(row.content_enc).catch(() => null)
    if (text === null) {
      log.error('任务内容解密失败，已跳过', { task_id: row.id })
      continue
    }
    const task = parseTask(row, text)
    if (!task) continue
    await runTask(deps, task).catch((e: unknown) =>
      log.error('计划任务异常', { task_id: task.id, error: String(e) }),
    )
  }
}
