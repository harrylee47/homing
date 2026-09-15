import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadConfig, SETTING_KEY, tick } from '../keepalive.js'
import { MemoryStore } from './fakes.js'

const jan5 = Date.UTC(2026, 0, 5)
const feb5 = Date.UTC(2026, 1, 5)

describe('保号任务', () => {
  let store: MemoryStore
  let send: ReturnType<typeof vi.fn>
  let alert: ReturnType<typeof vi.fn>

  const deps = (now: number, online: string | null = 'dev_1') => ({
    store, onlineDevice: () => online, send, alert, now: () => now,
  })

  const enable = async (over: Record<string, unknown> = {}) => {
    await store.setSetting(SETTING_KEY, JSON.stringify({
      enabled: true, to: '13800138000', day: 1, text: '保号', ...over,
    }))
  }

  beforeEach(() => {
    store = new MemoryStore()
    send = vi.fn(async () => true)
    alert = vi.fn(async () => {})
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

  it('到达指定日期后发送', async () => {
    await enable()
    await tick(deps(jan5))
    expect(send).toHaveBeenCalledWith('dev_1', '13800138000', '保号')
  })

  it('未到指定日期不发送', async () => {
    await enable({ day: 20 })
    await tick(deps(jan5))
    expect(send).not.toHaveBeenCalled()
  })

  it('同一个月只发一次', async () => {
    await enable()
    await tick(deps(jan5))
    await tick(deps(jan5 + 3600_000))
    await tick(deps(jan5 + 10 * 86400_000))
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('下个月会再发', async () => {
    await enable()
    await tick(deps(jan5))
    await tick(deps(feb5))
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('没有在线设备时跳过，且不占用本月名额', async () => {
    await enable()
    await tick(deps(jan5, null))
    expect(send).not.toHaveBeenCalled()
    // 设备上线后同月仍会执行
    await tick(deps(jan5 + 3600_000, 'dev_1'))
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('失败也记为本月已执行，避免每小时重发一条短信', async () => {
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
    await expect(tick(deps(jan5))).resolves.toBeUndefined()
    expect(await store.getSetting('keepalive_fail_count')).toBe('1')
  })

  it('配置损坏时回落到默认（停用），不影响其他功能', async () => {
    await store.setSetting(SETTING_KEY, '{ not json')
    expect((await loadConfig(store)).enabled).toBe(false)
    await expect(tick(deps(jan5))).resolves.toBeUndefined()
  })

  it('day 被限制在 1-28，避开月末不存在的日期', async () => {
    await store.setSetting(SETTING_KEY, JSON.stringify({ enabled: true, to: 'x', day: 31 }))
    expect((await loadConfig(store)).day).toBe(28)
    await store.setSetting(SETTING_KEY, JSON.stringify({ enabled: true, to: 'x', day: 0 }))
    expect((await loadConfig(store)).day).toBe(1)
  })

  it('写审计日志', async () => {
    await enable()
    await tick(deps(jan5))
    expect(store.audits.some((a) => a.action === 'keepalive.sent')).toBe(true)
  })
})
