import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadTasks, newTask, nextDueAt, runTask, saveTasks, SETTING_KEY, status, tick, type KeepAliveTask } from '../keepalive.js'
import { MemoryStore } from './fakes.js'

const jan5 = Date.UTC(2026, 0, 5)
const DAY = 86_400_000

describe('保号任务', () => {
  let store: MemoryStore
  let send: ReturnType<typeof vi.fn<(deviceId: string, to: string, text: string) => Promise<boolean>>>
  let alert: ReturnType<typeof vi.fn<(title: string, body: string) => Promise<void>>>

  const deps = (now: number, online: string[] = ['dev_jp']) => ({
    store, onlineDevices: () => online, send, alert,
    deviceName: (id: string) => ({ dev_jp: '日本卡', dev_cn: '国内卡' })[id] ?? id,
    now: () => now,
  })

  const task = (over: Partial<KeepAliveTask> = {}): KeepAliveTask => ({
    ...newTask('ka_1'), enabled: true, to: '13800138000',
    interval_days: 30, first_run_at: jan5, ...over,
  })

  beforeEach(() => {
    store = new MemoryStore()
    send = vi.fn<(deviceId: string, to: string, text: string) => Promise<boolean>>(async () => true)
    alert = vi.fn<(title: string, body: string) => Promise<void>>(async () => {})
  })

  describe('排期', () => {
    it('到达首次执行时刻后发送', async () => {
      await runTask(deps(jan5), task())
      expect(send).toHaveBeenCalledWith('dev_jp', '13800138000', '保号')
    })

    it('未到首次执行时刻不发送', async () => {
      await runTask(deps(jan5), task({ first_run_at: jan5 + 10 * DAY }))
      expect(send).not.toHaveBeenCalled()
    })

    it('间隔期内不重复', async () => {
      const t = task()
      await runTask(deps(jan5), t)
      await runTask(deps(jan5 + 29 * DAY), t)
      expect(send).toHaveBeenCalledTimes(1)
    })

    it('到达间隔后再发', async () => {
      const t = task()
      await runTask(deps(jan5), t)
      await runTask(deps(jan5 + 30 * DAY), t)
      expect(send).toHaveBeenCalledTimes(2)
    })

    it('支持任意间隔，不限于整月', async () => {
      const t = task({ interval_days: 7 })
      await runTask(deps(jan5), t)
      await runTask(deps(jan5 + 7 * DAY), t)
      expect(send).toHaveBeenCalledTimes(2)
    })

    it('未设首次时刻则立即到期', async () => {
      await runTask(deps(jan5), task({ first_run_at: null }))
      expect(send).toHaveBeenCalledTimes(1)
    })

    it('未启用不发送', async () => {
      await runTask(deps(jan5), task({ enabled: false }))
      expect(send).not.toHaveBeenCalled()
    })

    it('没填号码不发送', async () => {
      await runTask(deps(jan5), task({ to: '' }))
      expect(send).not.toHaveBeenCalled()
    })
  })

  describe('设备选择', () => {
    it('指定了设备就必须用它 —— 保号针对的是那张卡', async () => {
      await runTask(deps(jan5, ['dev_jp', 'dev_cn']), task({ device_id: 'dev_cn' }))
      expect(send).toHaveBeenCalledWith('dev_cn', '13800138000', '保号')
    })

    it('指定的设备不在线则跳过，不会换一台发', async () => {
      const r = await runTask(deps(jan5, ['dev_jp']), task({ device_id: 'dev_cn' }))
      expect(send).not.toHaveBeenCalled()
      expect(r.reason).toContain('国内卡')
    })

    it('指定设备不在线时不推进排期，上线后会重试', async () => {
      const t = task({ device_id: 'dev_cn' })
      await runTask(deps(jan5, ['dev_jp']), t)
      await runTask(deps(jan5 + 3600_000, ['dev_jp', 'dev_cn']), t)
      expect(send).toHaveBeenCalledTimes(1)
    })

    it('未指定设备时回落到任意在线设备（单设备部署）', async () => {
      await runTask(deps(jan5, ['dev_only']), task({ device_id: '' }))
      expect(send).toHaveBeenCalledWith('dev_only', '13800138000', '保号')
    })

    it('没有任何设备在线时跳过', async () => {
      const r = await runTask(deps(jan5, []), task())
      expect(send).not.toHaveBeenCalled()
      expect(r.sent).toBe(false)
    })
  })

  describe('多任务', () => {
    it('每张卡各自独立排期，互不影响', async () => {
      const jp = task({ id: 'ka_jp', device_id: 'dev_jp', interval_days: 30 })
      const cn = task({ id: 'ka_cn', device_id: 'dev_cn', interval_days: 7 })
      await saveTasks(store, [jp, cn])

      await tick(deps(jan5, ['dev_jp', 'dev_cn']))
      expect(send).toHaveBeenCalledTimes(2)

      // 7 天后只有国内卡那条到期
      send.mockClear()
      await tick(deps(jan5 + 7 * DAY, ['dev_jp', 'dev_cn']))
      expect(send).toHaveBeenCalledTimes(1)
      expect(send).toHaveBeenCalledWith('dev_cn', '13800138000', '保号')
    })

    it('失败计数按任务分开统计', async () => {
      const jp = task({ id: 'ka_jp', device_id: 'dev_jp' })
      const cn = task({ id: 'ka_cn', device_id: 'dev_cn' })
      send.mockImplementation(async (dev) => dev !== 'dev_cn')
      await saveTasks(store, [jp, cn])
      await tick(deps(jan5, ['dev_jp', 'dev_cn']))

      expect(await store.getSetting('keepalive_fail_count:ka_jp')).toBeNull()
      expect(await store.getSetting('keepalive_fail_count:ka_cn')).toBe('1')
    })

    it('一个任务异常不影响其他任务', async () => {
      await saveTasks(store, [task({ id: 'a', device_id: 'dev_jp' }), task({ id: 'b', device_id: 'dev_cn' })])
      send.mockImplementation(async (dev) => {
        if (dev === 'dev_jp') throw new Error('boom')
        return true
      })
      await expect(tick(deps(jan5, ['dev_jp', 'dev_cn']))).resolves.toBeUndefined()
      expect(send).toHaveBeenCalledTimes(2)
    })
  })

  describe('失败与告警', () => {
    it('失败也推进排期，避免每小时重发', async () => {
      send.mockResolvedValue(false)
      const t = task()
      await runTask(deps(jan5), t)
      await runTask(deps(jan5 + 3600_000), t)
      expect(send).toHaveBeenCalledTimes(1)
    })

    it('连续 2 次失败才告警', async () => {
      send.mockResolvedValue(false)
      const t = task()
      await runTask(deps(jan5), t)
      expect(alert).not.toHaveBeenCalled()
      await runTask(deps(jan5 + 30 * DAY), t)
      expect(alert).toHaveBeenCalledTimes(1)
    })

    it('告警里点名是哪张卡', async () => {
      send.mockResolvedValue(false)
      const t = task({ device_id: 'dev_cn' })
      await runTask(deps(jan5, ['dev_cn']), t)
      await runTask(deps(jan5 + 30 * DAY, ['dev_cn']), t)
      expect(alert.mock.calls[0]![1]).toContain('国内卡')
      expect(alert.mock.calls[0]![1]).toContain('停机')
    })

    it('成功后失败计数清零', async () => {
      const t = task()
      send.mockResolvedValue(false)
      await runTask(deps(jan5), t)
      send.mockResolvedValue(true)
      await runTask(deps(jan5 + 30 * DAY), t)
      expect(await store.getSetting('keepalive_fail_count:ka_1')).toBe('0')
    })
  })

  describe('立即测试', () => {
    it('忽略排期直接发送', async () => {
      const r = await runTask(deps(jan5), task({ first_run_at: jan5 + 100 * DAY }), true)
      expect(r.sent).toBe(true)
    })

    it('未启用也能测试 —— 配置过程中就要能验证链路', async () => {
      expect((await runTask(deps(jan5), task({ enabled: false }), true)).sent).toBe(true)
    })

    it('不推进排期，不顶掉正常的下一次', async () => {
      const t = task()
      await runTask(deps(jan5), t, true)
      expect(await store.getSetting('keepalive_last_run_at:ka_1')).toBeNull()
      await runTask(deps(jan5), t)
      expect(send).toHaveBeenCalledTimes(2)
    })

    it('不计入失败统计', async () => {
      send.mockResolvedValue(false)
      await runTask(deps(jan5), task(), true)
      expect(await store.getSetting('keepalive_fail_count:ka_1')).toBeNull()
      expect(alert).not.toHaveBeenCalled()
    })

    it('测试也遵守设备限定，不会换一台发', async () => {
      const r = await runTask(deps(jan5, ['dev_jp']), task({ device_id: 'dev_cn' }), true)
      expect(send).not.toHaveBeenCalled()
      expect(r.sent).toBe(false)
    })
  })

  describe('配置读写', () => {
    it('空配置返回空列表', async () => {
      expect(await loadTasks(store)).toEqual([])
    })

    it('损坏的配置返回空列表而不是抛异常', async () => {
      await store.setSetting(SETTING_KEY, '{ not json')
      expect(await loadTasks(store)).toEqual([])
    })

    it('间隔天数被限制在 1-365', async () => {
      await saveTasks(store, [task({ interval_days: 9999 }), task({ id: 'b', interval_days: 0 })])
      const ts = await loadTasks(store)
      expect(ts[0]!.interval_days).toBe(365)
      expect(ts[1]!.interval_days).toBe(1)
    })

    it('兼容早期的单任务对象格式', async () => {
      await store.setSetting(SETTING_KEY, JSON.stringify({
        enabled: true, to: '13800138000', day: 1, text: '保号',
      }))
      const ts = await loadTasks(store)
      expect(ts).toHaveLength(1)
      expect(ts[0]!.interval_days).toBe(30)
      expect(ts[0]!.device_id).toBe('')
    })

    it('status 返回每个任务的下次执行时刻', async () => {
      await saveTasks(store, [task({ interval_days: 10 })])
      await store.setSetting('keepalive_last_run_at:ka_1', String(jan5))
      const st = await status(store)
      expect(st[0]!.next_due_at).toBe(jan5 + 10 * DAY)
    })

    it('停用的任务不返回下次执行时刻', async () => {
      await saveTasks(store, [task({ enabled: false })])
      expect((await status(store))[0]!.next_due_at).toBeNull()
    })
  })

  describe('排期计算', () => {
    it('跑过之后从上次执行时间推', () => {
      expect(nextDueAt(task({ interval_days: 7 }), jan5)).toBe(jan5 + 7 * DAY)
    })

    it('没跑过则用首次执行时刻', () => {
      expect(nextDueAt(task({ first_run_at: jan5 }), null)).toBe(jan5)
    })
  })
})
