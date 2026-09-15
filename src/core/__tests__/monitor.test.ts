import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { checkDevices, resetAlertState } from '../monitor.js'
import { registerProvider } from '../notifier.js'
import { OFFLINE_ALERT_SEC } from '../protocol.js'
import type { NotifyMessage, Provider } from '../providers/types.js'
import { MemoryStore } from './fakes.js'

const sent: NotifyMessage[] = []
const stub: Provider<Record<string, never>> = {
  type: 'monitorstub',
  configSchema: z.object({}),
  async send(_c, msg) { sent.push(msg) },
}
registerProvider(stub as unknown as Provider<never>)

const NOW = 1_757_894_400_000
const channels = async () => [{ id: 'ch', type: 'monitorstub', name: 'ch', config: {}, enabled: true }]

describe('掉线告警', () => {
  let store: MemoryStore

  const device = (over: Record<string, unknown> = {}) => {
    store.devices.set('dev_1', {
      id: 'dev_1', name: 'JP-Gateway-01', token_hash: 'h', status: 'offline',
      last_seen_at: NOW - (OFFLINE_ALERT_SEC + 60) * 1000,
      battery: 50, app_version: '0.1.0', created_at: 0, ...over,
    } as never)
  }

  beforeEach(() => {
    store = new MemoryStore()
    sent.length = 0
    resetAlertState()
  })

  it('离线超过阈值时告警', async () => {
    device()
    await checkDevices({ store, channels, online: () => [], now: () => NOW })
    expect(sent).toHaveLength(1)
    expect(sent[0]!.title).toContain('设备离线')
    expect(sent[0]!.priority).toBe('high')
  })

  it('告警只发一次，不会每分钟刷屏', async () => {
    device()
    const deps = { store, channels, online: () => [], now: () => NOW }
    await checkDevices(deps)
    await checkDevices(deps)
    await checkDevices(deps)
    expect(sent).toHaveLength(1)
  })

  it('未超过阈值不告警', async () => {
    device({ last_seen_at: NOW - (OFFLINE_ALERT_SEC - 60) * 1000 })
    await checkDevices({ store, channels, online: () => [], now: () => NOW })
    expect(sent).toHaveLength(0)
  })

  it('在线设备不告警', async () => {
    device()
    await checkDevices({ store, channels, online: () => ['dev_1'], now: () => NOW })
    expect(sent).toHaveLength(0)
  })

  it('从未连接过的设备不告警 —— 那是还没配对，不是掉线', async () => {
    device({ last_seen_at: null })
    await checkDevices({ store, channels, online: () => [], now: () => NOW })
    expect(sent).toHaveLength(0)
  })

  it('已吊销的设备不告警', async () => {
    device({ status: 'revoked' })
    await checkDevices({ store, channels, online: () => [], now: () => NOW })
    expect(sent).toHaveLength(0)
  })

  it('恢复在线后补一条恢复通知', async () => {
    device()
    const base = { store, channels, now: () => NOW }
    await checkDevices({ ...base, online: () => [] })
    await checkDevices({ ...base, online: () => ['dev_1'] })
    expect(sent).toHaveLength(2)
    expect(sent[1]!.title).toContain('已恢复')
    expect(sent[1]!.priority).toBe('normal')
  })

  it('恢复后再次掉线会重新告警', async () => {
    device()
    const base = { store, channels, now: () => NOW }
    await checkDevices({ ...base, online: () => [] })
    await checkDevices({ ...base, online: () => ['dev_1'] })
    await checkDevices({ ...base, online: () => [] })
    expect(sent.filter((m) => m.title.includes('离线'))).toHaveLength(2)
  })

  it('写审计日志', async () => {
    device()
    await checkDevices({ store, channels, online: () => [], now: () => NOW })
    expect(store.audits.some((a) => a.action === 'device.offline')).toBe(true)
  })

  it('没有渠道时不抛异常（但会记错误日志）', async () => {
    device()
    await expect(
      checkDevices({ store, channels: async () => [], online: () => [], now: () => NOW }),
    ).resolves.toBeUndefined()
  })

  it('告警文案说明事件会补传，但关机则收不到', async () => {
    device()
    await checkDevices({ store, channels, online: () => [], now: () => NOW })
    expect(sent[0]!.body).toContain('补传')
    expect(sent[0]!.body).toContain('关机')
  })
})
