import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Schedule, wallTimeToEpoch } from '../schedule.js'
import { parseTask, runTask, taskNextRun, tick, type ParsedTask } from '../tasks.js'
import type { TaskRecord } from '../store.js'
import { MemoryStore } from './fakes.js'

const TZ = 'Asia/Tokyo'
const at = (y: number, mo: number, d: number, h: number, mi = 0) => wallTimeToEpoch(TZ, y, mo, d, h, mi)

describe('计划任务', () => {
  let store: MemoryStore
  let send: ReturnType<typeof vi.fn<(u: string, d: string, to: string, t: string, s: number | null) => Promise<boolean>>>
  let alert: ReturnType<typeof vi.fn<(u: string, t: string, b: string) => Promise<void>>>

  const deps = (now: number, online: string[] = ['dev_jp']) => ({
    store, timezoneFor: async () => TZ, onlineDevices: () => online, send, alert,
    deviceName: (id: string) => ({ dev_jp: '日本卡', dev_cn: '国内卡' })[id] ?? id,
    now: () => now,
  })

  const task = (over: Partial<ParsedTask> = {}): ParsedTask => ({
    id: 'task_1', user_id: 'u1', name: '保号', enabled: true, device_id: 'dev_jp',
    to: '13800138000', text: '保号', sim_slot: null,
    schedule: Schedule.parse({ type: 'daily', time: '09:00' }),
    last_run_at: null, last_status: null, fail_count: 0,
    created_at: at(2026, 9, 16, 8, 0),
    ...over,
  })

  const record = (t: ParsedTask): TaskRecord => ({
    id: t.id, user_id: t.user_id, name: t.name, enabled: t.enabled, device_id: t.device_id,
    to_number: t.to, content_enc: new TextEncoder().encode(t.text),
    sim_slot: t.sim_slot, schedule_json: JSON.stringify(t.schedule),
    last_run_at: t.last_run_at, last_status: t.last_status,
    fail_count: t.fail_count, created_at: t.created_at,
  })

  beforeEach(() => {
    store = new MemoryStore()
    send = vi.fn<(u: string, d: string, to: string, t: string, s: number | null) => Promise<boolean>>(async () => true)
    alert = vi.fn<(u: string, t: string, b: string) => Promise<void>>(async () => {})
  })

  describe('保号是按卡的事', () => {
    it('任务指定了卡槽就从那张卡发 —— 双卡机上两张卡各自都要保', async () => {
      await runTask(deps(at(2026, 9, 16, 9, 1)), task({ sim_slot: 1 }))
      expect(send).toHaveBeenCalledWith('u1', 'dev_jp', '13800138000', '保号', 1)
    })
  })

  describe('排期锚点', () => {
    it('没跑过时以创建时刻为锚点', () => {
      // 08:00 建的「每天 09:00」→ 下一次是当天 09:00
      const t = task({ created_at: at(2026, 9, 16, 8, 0) })
      expect(taskNextRun(t, TZ)).toBe(at(2026, 9, 16, 9, 0))
    })

    it('10 点建的每日 9 点任务，下一次是明天 —— 不会补跑今天已过去的', () => {
      const t = task({ created_at: at(2026, 9, 16, 10, 0) })
      expect(taskNextRun(t, TZ)).toBe(at(2026, 9, 17, 9, 0))
    })

    it('跑过之后以上次执行时刻为锚点', () => {
      const t = task({ last_run_at: at(2026, 9, 16, 9, 0) })
      expect(taskNextRun(t, TZ)).toBe(at(2026, 9, 17, 9, 0))
    })
  })

  describe('执行条件', () => {
    it('到点执行', async () => {
      await runTask(deps(at(2026, 9, 16, 9, 1)), task())
      expect(send).toHaveBeenCalledWith('u1', 'dev_jp', '13800138000', '保号', null)
    })

    it('未到点不执行', async () => {
      await runTask(deps(at(2026, 9, 16, 8, 30)), task())
      expect(send).not.toHaveBeenCalled()
    })

    it('未启用不执行', async () => {
      await runTask(deps(at(2026, 9, 16, 9, 1)), task({ enabled: false }))
      expect(send).not.toHaveBeenCalled()
    })

    it('没填号码不执行', async () => {
      await runTask(deps(at(2026, 9, 16, 9, 1)), task({ to: '' }))
      expect(send).not.toHaveBeenCalled()
    })

    it('服务端停机一天后重启只补跑一次，不会连发多条', async () => {
      const t = task({ last_run_at: at(2026, 9, 16, 9, 0) })
      await store.upsertTask(record(t))
      // 两天后才重启
      await tick(deps(at(2026, 9, 18, 12, 0)), async (e) => new TextDecoder().decode(e))
      expect(send).toHaveBeenCalledTimes(1)
    })
  })

  describe('设备选择', () => {
    it('指定设备离线时跳过，不换一台发', async () => {
      const r = await runTask(deps(at(2026, 9, 16, 9, 1), ['dev_cn']), task({ device_id: 'dev_jp' }))
      expect(send).not.toHaveBeenCalled()
      expect(r.reason).toContain('日本卡')
    })

    it('离线跳过时不推进排期，上线后会执行', async () => {
      const t = task()
      await store.upsertTask(record(t))
      await tick(deps(at(2026, 9, 16, 9, 1), []), async (e) => new TextDecoder().decode(e))
      expect(send).not.toHaveBeenCalled()
      await tick(deps(at(2026, 9, 16, 9, 2), ['dev_jp']), async (e) => new TextDecoder().decode(e))
      expect(send).toHaveBeenCalledTimes(1)
    })

    it('未指定设备时回落到任意在线设备', async () => {
      await runTask(deps(at(2026, 9, 16, 9, 1), ['dev_any']), task({ device_id: '' }))
      expect(send).toHaveBeenCalledWith('u1', 'dev_any', '13800138000', '保号', null)
    })
  })

  describe('一次性任务', () => {
    it('执行后自动停用', async () => {
      const t = task({ schedule: Schedule.parse({ type: 'once', at: at(2026, 9, 16, 9, 0) }) })
      await store.upsertTask(record(t))
      await runTask(deps(at(2026, 9, 16, 9, 1)), t)
      expect((await store.getTask('task_1', 'u1'))!.enabled).toBe(false)
    })

    it('过期的一次性任务不执行', async () => {
      const t = task({
        schedule: Schedule.parse({ type: 'once', at: at(2026, 9, 16, 9, 0) }),
        last_run_at: at(2026, 9, 16, 9, 0),
      })
      await runTask(deps(at(2026, 9, 17, 9, 0)), t)
      expect(send).not.toHaveBeenCalled()
    })
  })

  describe('失败与告警', () => {
    it('失败也推进排期，避免每分钟重发', async () => {
      send.mockResolvedValue(false)
      const t = task()
      await store.upsertTask(record(t))
      const d = (m: number) => deps(at(2026, 9, 16, 9, m))
      await tick(d(1), async (e) => new TextDecoder().decode(e))
      await tick(d(2), async (e) => new TextDecoder().decode(e))
      expect(send).toHaveBeenCalledTimes(1)
    })

    it('连续 2 次失败才告警', async () => {
      send.mockResolvedValue(false)
      await runTask(deps(at(2026, 9, 16, 9, 1)), task({ fail_count: 0 }))
      expect(alert).not.toHaveBeenCalled()
      await runTask(deps(at(2026, 9, 16, 9, 1)), task({ fail_count: 1 }))
      expect(alert).toHaveBeenCalledTimes(1)
    })

    it('告警点名任务与设备', async () => {
      send.mockResolvedValue(false)
      await runTask(deps(at(2026, 9, 16, 9, 1)), task({ fail_count: 1, name: '国内卡保号', device_id: 'dev_jp' }))
      // 第一个参数现在是「告警发给谁」——多用户下不能发给所有人
      expect(alert.mock.calls[0]![0]).toBe('u1')
      expect(alert.mock.calls[0]![1]).toContain('国内卡保号')
      expect(alert.mock.calls[0]![2]).toContain('日本卡')
    })

    it('成功后失败计数清零', async () => {
      const t = task({ fail_count: 3 })
      await store.upsertTask(record(t))
      await runTask(deps(at(2026, 9, 16, 9, 1)), t)
      expect((await store.getTask('task_1', 'u1'))!.fail_count).toBe(0)
    })
  })

  describe('立即测试', () => {
    it('忽略排期直接执行', async () => {
      expect((await runTask(deps(at(2026, 9, 16, 1, 0)), task(), true)).sent).toBe(true)
    })

    it('未启用也能测试', async () => {
      expect((await runTask(deps(at(2026, 9, 16, 1, 0)), task({ enabled: false }), true)).sent).toBe(true)
    })

    it('不推进排期，不计入失败统计', async () => {
      send.mockResolvedValue(false)
      const t = task()
      await store.upsertTask(record(t))
      await runTask(deps(at(2026, 9, 16, 9, 1)), t, true)
      const saved = (await store.getTask('task_1', 'u1'))!
      expect(saved.last_run_at).toBeNull()
      expect(saved.fail_count).toBe(0)
    })

    it('仍遵守设备限定', async () => {
      const r = await runTask(deps(at(2026, 9, 16, 9, 1), ['dev_cn']), task({ device_id: 'dev_jp' }), true)
      expect(send).not.toHaveBeenCalled()
      expect(r.sent).toBe(false)
    })
  })

  describe('容错', () => {
    it('排期配置损坏的任务被跳过，不影响其他任务', async () => {
      await store.upsertTask({ ...record(task({ id: 'bad' })), schedule_json: '{ not json' })
      await store.upsertTask(record(task({ id: 'good' })))
      await expect(tick(deps(at(2026, 9, 16, 9, 1)), async (e) => new TextDecoder().decode(e))).resolves.toBeUndefined()
      expect(send).toHaveBeenCalledTimes(1)
    })

    it('内容解密失败的任务被跳过', async () => {
      await store.upsertTask(record(task()))
      await tick(deps(at(2026, 9, 16, 9, 1)), async () => { throw new Error('bad key') })
      expect(send).not.toHaveBeenCalled()
    })

    it('parseTask 对损坏配置返回 null 而不是抛异常', () => {
      expect(parseTask({ ...record(task()), schedule_json: 'garbage' }, 'x')).toBeNull()
    })
  })

  describe('多任务', () => {
    it('各自独立排期与失败计数', async () => {
      await store.upsertTask(record(task({ id: 'a', device_id: 'dev_jp' })))
      await store.upsertTask(record(task({ id: 'b', device_id: 'dev_cn' })))
      send.mockImplementation(async (_u, d) => d !== 'dev_cn')
      await tick(deps(at(2026, 9, 16, 9, 1), ['dev_jp', 'dev_cn']), async (e) => new TextDecoder().decode(e))
      expect((await store.getTask('a', 'u1'))!.fail_count).toBe(0)
      expect((await store.getTask('b', 'u1'))!.fail_count).toBe(1)
    })

    it('一个任务抛异常不影响其他任务', async () => {
      await store.upsertTask(record(task({ id: 'a', device_id: 'dev_jp' })))
      await store.upsertTask(record(task({ id: 'b', device_id: 'dev_cn' })))
      send.mockImplementation(async (d) => {
        if (d === 'dev_jp') throw new Error('boom')
        return true
      })
      await expect(tick(deps(at(2026, 9, 16, 9, 1), ['dev_jp', 'dev_cn']), async (e) => new TextDecoder().decode(e)))
        .resolves.toBeUndefined()
      expect(send).toHaveBeenCalledTimes(2)
    })
  })
})
