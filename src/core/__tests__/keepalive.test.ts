import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LAST_RUN_KEY, loadConfig, nextDueAt, SETTING_KEY, status, tick } from '../keepalive.js'
import { MemoryStore } from './fakes.js'

const jan5 = Date.UTC(2026, 0, 5)
const feb5 = Date.UTC(2026, 1, 5)
const DAY = 86_400_000

describe('保号任务', () => {
  let store: MemoryStore
  // vitest 5 的 vi.fn 不再从赋值推断签名，要显式给出函数类型
  let send: ReturnType<typeof vi.fn<(deviceId: string, to: string, text: string) => Promise<boolean>>>
  let alert: ReturnType<typeof vi.fn<(title: string, body: string) => Promise<void>>>

  const deps = (now: number, online: string | null = 'dev_1') => ({
    store, onlineDevice: () => online, send, alert, now: () => now,
  })

  const enable = async (over: Record<string, unknown> = {}) => {
    await store.setSetting(SETTING_KEY, JSON.stringify({
      enabled: true, to: '13800138000', text: '保号',
      interval_days: 30, first_run_at: jan5, ...over,
    }))
  }

  beforeEach(() => {
    store = new MemoryStore()
    send = vi.fn<(deviceId: string, to: string, text: string) => Promise<boolean>>(async () => true)
    alert = vi.fn<(title: string, body: string) => Promise<void>>(async () => {})
  })

  it('未启用时不发送', async () => {
    await tick(deps(jan5))
    expect(send).not.toHaveBeenCalled()
  })

  it('启用但没填号码时不发送', async () => {
    await enable({ to: '' })
    await tick(deps(jan5))
    expect(send).not.toHaveBeenCalled()
  })

  it('到达首次执行时刻后发送', async () => {
    await enable()
    await tick(deps(jan5))
    expect(send).toHaveBeenCalledWith('dev_1', '13800138000', '保号')
  })

  it('未到首次执行时刻不发送', async () => {
    await enable({ first_run_at: jan5 + 10 * DAY })
    await tick(deps(jan5))
    expect(send).not.toHaveBeenCalled()
  })

  it('间隔期内不重复发送', async () => {
    await enable({ interval_days: 30 })
    await tick(deps(jan5))
    await tick(deps(jan5 + 3600_000))
    await tick(deps(jan5 + 29 * DAY))
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('到达间隔后再发', async () => {
    await enable({ interval_days: 30 })
    await tick(deps(jan5))
    await tick(deps(jan5 + 30 * DAY))
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('支持任意间隔天数，不限于整月', async () => {
    await enable({ interval_days: 7 })
    await tick(deps(jan5))
    await tick(deps(jan5 + 7 * DAY))
    await tick(deps(jan5 + 14 * DAY))
    expect(send).toHaveBeenCalledTimes(3)
  })

  it('未设首次时刻则视为立即到期', async () => {
    await enable({ first_run_at: null })
    await tick(deps(jan5))
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('没有在线设备时跳过，且不占用本月名额', async () => {
    await enable()
    await tick(deps(jan5, null))
    expect(send).not.toHaveBeenCalled()
    // 设备上线后同月仍会执行
    await tick(deps(jan5 + 3600_000, 'dev_1'))
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('失败也推进排期，避免每小时重发一条短信', async () => {
    await enable()
    send.mockResolvedValue(false)
    await tick(deps(jan5))
    await tick(deps(jan5 + 3600_000))
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('连续失败 2 次才告警 —— 1 次可能是偶发', async () => {
    await enable()
    send.mockResolvedValue(false)
    await tick(deps(jan5))
    expect(alert).not.toHaveBeenCalled()
    await tick(deps(feb5))
    expect(alert).toHaveBeenCalledTimes(1)
    expect(alert.mock.calls[0]![0]).toContain('保号任务连续失败')
  })

  it('告警说明后果：停机后验证码完全收不到且无提示', async () => {
    await enable()
    send.mockResolvedValue(false)
    await tick(deps(jan5))
    await tick(deps(feb5))
    expect(alert.mock.calls[0]![1]).toContain('停机')
    expect(alert.mock.calls[0]![1]).toContain('收不到')
  })

  it('成功后失败计数清零', async () => {
    await enable()
    send.mockResolvedValue(false)
    await tick(deps(jan5))
    send.mockResolvedValue(true)
    await tick(deps(feb5))
    expect(await store.getSetting('keepalive_fail_count')).toBe('0')
  })

  it('send 抛异常按失败处理，不中断定时器', async () => {
    await enable()
    send.mockRejectedValue(new Error('boom'))
    const r = await tick(deps(jan5))
    expect(r.sent).toBe(false)
    expect(await store.getSetting('keepalive_fail_count')).toBe('1')
  })

  it('配置损坏时回落到默认（停用），不影响其他功能', async () => {
    await store.setSetting(SETTING_KEY, '{ not json')
    expect((await loadConfig(store)).enabled).toBe(false)
    expect((await tick(deps(jan5))).sent).toBe(false)
  })

  it('间隔天数被限制在 1-365', async () => {
    await store.setSetting(SETTING_KEY, JSON.stringify({ enabled: true, to: 'x', interval_days: 9999 }))
    expect((await loadConfig(store)).interval_days).toBe(365)
    await store.setSetting(SETTING_KEY, JSON.stringify({ enabled: true, to: 'x', interval_days: 0 }))
    expect((await loadConfig(store)).interval_days).toBe(1)
  })

  it('旧配置（每月第 N 天）迁移为 30 天间隔', async () => {
    await store.setSetting(SETTING_KEY, JSON.stringify({ enabled: true, to: 'x', day: 1, text: '保号' }))
    const cfg = await loadConfig(store)
    expect(cfg.interval_days).toBe(30)
    expect(cfg.enabled).toBe(true)
  })

  describe('立即测试', () => {
    it('忽略排期直接发送', async () => {
      await enable({ first_run_at: jan5 + 100 * DAY })
      const r = await tick(deps(jan5), true)
      expect(r.sent).toBe(true)
      expect(send).toHaveBeenCalledTimes(1)
    })

    it('未启用时也能测试 —— 配置过程中就要能验证链路', async () => {
      await store.setSetting(SETTING_KEY, JSON.stringify({ enabled: false, to: '13800138000' }))
      expect((await tick(deps(jan5), true)).sent).toBe(true)
    })

    it('不推进排期，不顶掉正常的下一次', async () => {
      await enable()
      await tick(deps(jan5), true)
      expect(await store.getSetting(LAST_RUN_KEY)).toBeNull()
      // 正常执行仍会发生
      await tick(deps(jan5))
      expect(send).toHaveBeenCalledTimes(2)
    })

    it('不计入失败统计', async () => {
      await enable()
      send.mockResolvedValue(false)
      await tick(deps(jan5), true)
      expect(await store.getSetting('keepalive_fail_count')).toBeNull()
      expect(alert).not.toHaveBeenCalled()
    })

    it('没填号码时明确告知，而不是假装成功', async () => {
      await store.setSetting(SETTING_KEY, JSON.stringify({ enabled: false, to: '' }))
      const r = await tick(deps(jan5), true)
      expect(r.sent).toBe(false)
      expect(r.reason).toContain('号码')
    })
  })

  describe('排期计算', () => {
    it('跑过之后从上次执行时间推', () => {
      const cfg = { enabled: true, to: 'x', text: 'y', interval_days: 7, first_run_at: jan5 }
      expect(nextDueAt(cfg, jan5)).toBe(jan5 + 7 * DAY)
    })

    it('没跑过则用首次执行时刻', () => {
      const cfg = { enabled: true, to: 'x', text: 'y', interval_days: 7, first_run_at: feb5 }
      expect(nextDueAt(cfg, null)).toBe(feb5)
    })

    it('status 返回下次执行时刻', async () => {
      await enable({ interval_days: 10 })
      await store.setSetting(LAST_RUN_KEY, String(jan5))
      expect((await status(store)).next_due_at).toBe(jan5 + 10 * DAY)
    })

    it('停用时不返回下次执行时刻', async () => {
      await enable({ enabled: false })
      expect((await status(store)).next_due_at).toBeNull()
    })
  })

  it('写审计日志', async () => {
    await enable()
    await tick(deps(jan5))
    expect(store.audits.some((a) => a.action === 'keepalive.sent')).toBe(true)
  })
})
