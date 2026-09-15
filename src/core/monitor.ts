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

/** 仅供测试重置。 */
export function resetAlertState(): void {
  alerted.clear()
}

export async function checkDevices(deps: MonitorDeps): Promise<void> {
  const now = deps.now?.() ?? Date.now()
  const online = new Set(deps.online())
  const devices = await deps.store.listDevices()

  for (const d of devices) {
    if (d.status === 'revoked') continue

    if (online.has(d.id)) {
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
