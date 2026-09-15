/**
 * 设备在线监控与告警（计划 §10.1）。
 *
 * 核心约束：**告警必须走独立于设备的通道**。用掉线的设备去通知自己掉线
 * 是没有意义的——服务端直接发，不经过手机。
 *
 * 运行时无关：定时器由适配层驱动，这里只做判定与发送。
 */
import { log } from './logging.js'
import { crossChannelAlert, dispatch, type ChannelConfig } from './notifier.js'
import { OFFLINE_ALERT_SEC } from './protocol.js'
import type { Store } from './store.js'

/**
 * 电量告警配置。
 *
 * 阈值设为 0 表示关闭该项——用一个值同时表达「阈值」和「开关」，
 * 比额外加一个 enabled 字段少一处可能不一致的状态。
 */
export interface BatteryConfig {
  /** 低于此电量告警。0 = 关闭 */
  low: number
  /** 充电时高于此电量提醒拔电（长期满电伤电池）。0 = 关闭 */
  full: number
  /** 充电状态变化时通知。默认关闭——插拔电源是日常操作，会很吵 */
  notify_charging_change: boolean
}

export const DEFAULT_BATTERY: BatteryConfig = { low: 20, full: 0, notify_charging_change: false }
export const BATTERY_SETTING_KEY = 'battery_alerts'

export async function loadBatteryConfig(store: Store): Promise<BatteryConfig> {
  const raw = await store.getSetting(BATTERY_SETTING_KEY)
  if (!raw) return DEFAULT_BATTERY
  try {
    const p = JSON.parse(raw) as Partial<BatteryConfig>
    const clamp = (v: unknown, d: number) => {
      const n = Number(v)
      return Number.isFinite(n) && n >= 0 && n <= 100 ? Math.round(n) : d
    }
    return {
      low: clamp(p.low, DEFAULT_BATTERY.low),
      full: clamp(p.full, DEFAULT_BATTERY.full),
      notify_charging_change: p.notify_charging_change === true,
    }
  } catch {
    return DEFAULT_BATTERY
  }
}

export interface MonitorDeps {
  store: Store
  /** 已解密的启用渠道。由适配层提供，避免 core 触碰加密细节的生命周期。 */
  channels(): Promise<ChannelConfig[]>
  /** 当前在线的 device_id */
  online(): string[]
  baseUrl?: string | null
  now?: () => number
}

/**
 * 告警去重状态。
 *
 * 放内存即可：重启后最多多发一条告警，而漏发才是不可接受的
 * ——宁可吵一次，不可静默。
 */
const alerted = new Set<string>()
const batteryAlerted = new Set<string>()
const lastCharging = new Map<string, boolean>()

/** 仅供测试重置。 */
export function resetAlertState(): void {
  alerted.clear()
  batteryAlerted.clear()
  lastCharging.clear()
}

export async function checkDevices(deps: MonitorDeps): Promise<void> {
  const now = deps.now?.() ?? Date.now()
  const online = new Set(deps.online())
  const devices = await deps.store.listDevices()
  const battery = await loadBatteryConfig(deps.store)

  for (const d of devices) {
    if (d.status === 'revoked') continue

    if (online.has(d.id)) {
      await checkBattery(deps, d, battery)
      // 恢复：如果之前告警过，补一条恢复通知，让人知道不用管了
      if (alerted.delete(d.id)) {
        log.info('设备已恢复在线', { device_id: d.id })
        await notify(deps, {
          title: '✅ 设备已恢复',
          body: `${d.name} 重新连接上了。`,
          priority: 'normal',
        })
      }
      continue
    }

    // 从未连接过的设备不告警：那是还没配对，不是掉线
    if (d.last_seen_at === null) continue

    const offlineSec = Math.floor((now - d.last_seen_at) / 1000)
    if (offlineSec < OFFLINE_ALERT_SEC) continue
    if (alerted.has(d.id)) continue

    alerted.add(d.id)
    log.error('设备离线超过阈值', { device_id: d.id, offline_sec: offlineSec })
    await deps.store.audit({
      actor: 'monitor', action: 'device.offline',
      detail: `${d.id} 离线 ${offlineSec}s`, ip: null, created_at: now,
    })
    await notify(deps, {
      title: '⚠️ 设备离线',
      body: `${d.name} 已离线 ${Math.floor(offlineSec / 60)} 分钟。` +
        `期间的短信会暂存在设备本地，恢复后自动补传；但若设备关机或断电，验证码将无法送达。`,
      priority: 'high',
    })
  }
}

/**
 * 电量相关告警。
 *
 * 只对在线设备判断：离线设备的电量是过期数据，拿它告警只会误报。
 */
async function checkBattery(
  deps: MonitorDeps,
  d: { id: string; name: string; battery: number | null; charging: boolean | null },
  cfg: BatteryConfig,
): Promise<void> {
  if (d.battery === null) return

  // 充电状态变化
  if (d.charging !== null) {
    const prev = lastCharging.get(d.id)
    if (prev !== undefined && prev !== d.charging && cfg.notify_charging_change) {
      await notify(deps, {
        title: d.charging ? '🔌 已接通电源' : '🔋 已断开电源',
        body: `${d.name} ${d.charging ? '开始充电' : '拔掉了电源'}，当前电量 ${d.battery}%。`,
        priority: 'normal',
      })
    }
    lastCharging.set(d.id, d.charging)
  }

  const lowKey = `${d.id}:low`
  const fullKey = `${d.id}:full`

  // 低电量。充电中不告警——正在充就说明人已经知道了
  if (cfg.low > 0 && d.battery <= cfg.low && d.charging !== true) {
    if (!batteryAlerted.has(lowKey)) {
      batteryAlerted.add(lowKey)
      await deps.store.audit({
        actor: 'monitor', action: 'device.battery_low',
        detail: `${d.id} ${d.battery}%`, ip: null, created_at: deps.now?.() ?? Date.now(),
      })
      await notify(deps, {
        title: '🪫 设备电量低',
        body: `${d.name} 仅剩 ${d.battery}% 且未在充电。电量耗尽关机后，验证码将完全收不到，` +
          `而且不会有任何告警——因为告警也要靠它上报。请尽快接上电源。`,
        priority: 'high',
      })
    }
  } else if (d.battery > cfg.low + 5 || d.charging === true) {
    // 留 5% 回差，避免在阈值附近反复告警
    batteryAlerted.delete(lowKey)
  }

  // 充满提醒：长期满电对锂电池不友好，而这台机器是常年插电的
  if (cfg.full > 0 && d.charging === true && d.battery >= cfg.full) {
    if (!batteryAlerted.has(fullKey)) {
      batteryAlerted.add(fullKey)
      await notify(deps, {
        title: '🔌 可以拔掉电源了',
        body: `${d.name} 已充到 ${d.battery}%。长期保持满电会加速电池老化，建议拔掉电源。`,
        priority: 'normal',
      })
    }
  } else if (d.charging !== true || d.battery < cfg.full - 5) {
    batteryAlerted.delete(fullKey)
  }
}

async function notify(
  deps: MonitorDeps,
  msg: { title: string; body: string; priority: 'normal' | 'high' },
): Promise<void> {
  const channels = await deps.channels()
  if (channels.length === 0) {
    log.error('没有可用渠道，离线告警无法送出', { title: msg.title })
    return
  }
  const results = await dispatch(channels, {
    ...msg, code: null, eventId: '', occurredAt: Date.now(),
    consoleUrl: deps.baseUrl ?? null,
  })
  const failed = results.filter((r) => !r.ok)
  if (failed.length > 0 && failed.length < results.length) {
    await crossChannelAlert(channels, failed, '离线告警发送失败')
  }
}
