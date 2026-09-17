import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { BATTERY_SETTING_KEY, checkDevices, resetAlertState } from '../monitor.js'
import { registerProvider } from '../notifier.js'
import { OFFLINE_ALERT_SEC } from '../protocol.js'
import type { NotifyMessage, Provider } from '../providers/types.js'
import { MemoryStore } from './fakes.js'

const sent: NotifyMessage[] = []
/** 置为 true 时这个渠道一直发不出去，用来验「告警发失败后还会不会再告警」 */
let stubBroken = false
const stub: Provider<Record<string, never>> = {
  type: 'monitorstub',
  configSchema: z.object({}),
  async send(_c, msg) {
    sent.push(msg)
    if (stubBroken) throw new Error('渠道挂了')
  },
}
registerProvider(stub as unknown as Provider<never>)

const NOW = 1_757_894_400_000
const channels = async () => [{ id: 'ch', user_id: 'u1', type: 'monitorstub', name: 'ch', config: {}, enabled: true }]

describe('掉线告警', () => {
  let store: MemoryStore

  const device = (over: Record<string, unknown> = {}) => {
    store.devices.set('dev_1', {
      id: 'dev_1', user_id: 'u1', name: 'JP-Gateway-01', token_hash: 'h', status: 'offline',
      last_seen_at: NOW - (OFFLINE_ALERT_SEC + 60) * 1000,
      battery: 50, charging: null, location_enc: null, location_at: null, app_version: '0.1.0', created_at: 0, ...over,
    } as never)
  }

  beforeEach(() => {
    store = new MemoryStore()
    sent.length = 0
    stubBroken = false
    resetAlertState()
  })

  /**
   * 去重集合必须等告警**真的送出去**才记。
   *
   * 原来 `alerted.add(d.id)` 排在 notify() 之前，而 notify 内部的 dispatch
   * 从不抛——于是渠道故障时这台设备在进程活着的这几周里再也不会告警。
   * 而「告警发不出去」与「设备离线」往往同源（都在家里那条网线上），
   * 这个洞恰好在最需要告警的时候张开。
   */
  it('告警一条都没发出去时，下一轮还会再试', async () => {
    device()
    const tick = async () => {
      const before = sent.length
      await checkDevices({ store, channels, online: () => [], now: () => NOW })
      return sent.length - before
    }

    // 渠道挂着：发了（会重试几次），但不能因此记进去重集合
    stubBroken = true
    expect(await tick()).toBeGreaterThan(0)

    // 渠道恢复：这一轮必须还会再发 —— 说明上一轮没被记成「已告警」
    stubBroken = false
    expect(await tick()).toBe(1)

    // 这一条送到了，从此闭嘴
    expect(await tick()).toBe(0)
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

describe('电量告警', () => {
  let store: MemoryStore

  const dev = (over: Record<string, unknown> = {}) => {
    store.devices.set('dev_1', {
      id: 'dev_1', user_id: 'u1', name: 'JP-Gateway-01', token_hash: 'h', status: 'online',
      last_seen_at: Date.now(), battery: 50, charging: false, location_enc: null, location_at: null,
      app_version: '0.1.0', created_at: 0, ...over,
    } as never)
  }
  const run = () => checkDevices({ store, channels, online: () => ['dev_1'], now: () => NOW })
  // 阈值按用户存：设备的主人是谁，就读谁的阈值
  const setCfg = (c: Record<string, unknown>) => store.setUserSetting('u1', BATTERY_SETTING_KEY, JSON.stringify(c))

  beforeEach(() => {
    store = new MemoryStore()
    sent.length = 0
    resetAlertState()
  })

  it('低于阈值且未充电时告警', async () => {
    await setCfg({ low: 20, full: 0 })
    dev({ battery: 15, charging: false })
    await run()
    expect(sent).toHaveLength(1)
    expect(sent[0]!.title).toContain('电量低')
    expect(sent[0]!.priority).toBe('high')
  })

  it('低电量但正在充电时不告警 —— 正在充说明人已经知道了', async () => {
    await setCfg({ low: 20, full: 0 })
    dev({ battery: 15, charging: true })
    await run()
    expect(sent).toHaveLength(0)
  })

  it('告警只发一次', async () => {
    await setCfg({ low: 20, full: 0 })
    dev({ battery: 15, charging: false })
    await run(); await run(); await run()
    expect(sent).toHaveLength(1)
  })

  it('阈值附近有 5% 回差，不会反复告警', async () => {
    await setCfg({ low: 20, full: 0 })
    dev({ battery: 15, charging: false })
    await run()
    // 回到 22%（仍在回差区内）不重置
    dev({ battery: 22, charging: false })
    await run()
    dev({ battery: 15, charging: false })
    await run()
    expect(sent).toHaveLength(1)

    // 超过 25% 才重置
    dev({ battery: 30, charging: false })
    await run()
    dev({ battery: 15, charging: false })
    await run()
    expect(sent).toHaveLength(2)
  })

  it('阈值为 0 表示关闭', async () => {
    await setCfg({ low: 0, full: 0 })
    dev({ battery: 1, charging: false })
    await run()
    expect(sent).toHaveLength(0)
  })

  it('告警文案说明后果：关机后连告警都收不到', async () => {
    await setCfg({ low: 20, full: 0 })
    dev({ battery: 5, charging: false })
    await run()
    expect(sent[0]!.body).toContain('关机')
    expect(sent[0]!.body).toContain('告警也要靠它上报')
  })

  it('充电到满电阈值时提醒拔电', async () => {
    await setCfg({ low: 20, full: 90 })
    dev({ battery: 95, charging: true })
    await run()
    expect(sent).toHaveLength(1)
    expect(sent[0]!.title).toContain('拔掉电源')
    expect(sent[0]!.priority).toBe('normal')
  })

  it('未充电时不发满电提醒', async () => {
    await setCfg({ low: 0, full: 90 })
    dev({ battery: 95, charging: false })
    await run()
    expect(sent).toHaveLength(0)
  })

  it('充电状态变化默认不通知 —— 插拔电源是日常操作，会很吵', async () => {
    await setCfg({ low: 0, full: 0, notify_charging_change: false })
    dev({ battery: 50, charging: false })
    await run()
    dev({ battery: 50, charging: true })
    await run()
    expect(sent).toHaveLength(0)
  })

  it('开启后才通知充电状态变化', async () => {
    await setCfg({ low: 0, full: 0, notify_charging_change: true })
    dev({ battery: 50, charging: false })
    await run()
    dev({ battery: 50, charging: true })
    await run()
    expect(sent).toHaveLength(1)
    expect(sent[0]!.title).toContain('接通电源')
  })

  it('首次见到设备不发充电状态通知 —— 那不是变化', async () => {
    await setCfg({ low: 0, full: 0, notify_charging_change: true })
    dev({ battery: 50, charging: true })
    await run()
    expect(sent).toHaveLength(0)
  })

  it('离线设备不做电量判断 —— 电量是过期数据', async () => {
    await setCfg({ low: 20, full: 0 })
    dev({ battery: 5, charging: false })
    await checkDevices({ store, channels, online: () => [], now: () => NOW })
    // 只有离线告警，没有电量告警
    expect(sent.filter((m) => m.title.includes('电量'))).toHaveLength(0)
  })

  it('未上报充电状态的老设备不因此崩溃', async () => {
    await setCfg({ low: 20, full: 90, notify_charging_change: true })
    dev({ battery: 15, charging: null })
    await expect(run()).resolves.toBeUndefined()
    expect(sent).toHaveLength(1)
  })

  it('没有电量数据时跳过', async () => {
    await setCfg({ low: 20, full: 0 })
    dev({ battery: null })
    await run()
    expect(sent).toHaveLength(0)
  })
})
