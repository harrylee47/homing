/**
 * 账号到期必须在**每一条**鉴权路径上都生效。
 *
 * 这个文件盯的是同一类漏洞的第二次出现：吊销设备那次，A 处判了、B 处把它
 * 覆盖回去，结果吊销恰好在设备在线时失效。到期也一样有四条互不相交的路径，
 * 漏一条就等于没做——而漏掉的那条，恰恰是「用户登不进控制台但 Bark 还在响」。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { createCipher, generateDek, hashToken, type Cipher } from '../crypto.js'
import { daysLeft, inactiveReason, userActive } from '../users.js'
import { DeviceSession } from '../session.js'
import { encodeFrame, makeFrame } from '../frames.js'
import { MemoryHub, MemoryStore } from './fakes.js'
import { runTask, tick } from '../tasks.js'
import { checkDevices, resetAlertState } from '../monitor.js'
import type { UserRecord } from '../store.js'

const NOW = 1_800_000_000_000
const DAY = 86_400_000

const user = (o: Partial<UserRecord> = {}): UserRecord => ({
  id: 'u1', name: 'u1', password_hash: '', totp_secret: '',
  role: 'member', bot_token: '', disabled: false,
  expires_at: null, agreed_version: null, agreed_at: null, created_at: 0, ...o,
})

describe('账号状态判定', () => {
  it('没到期就能用', () => {
    expect(userActive(user({ expires_at: NOW + DAY }), NOW)).toBe(true)
  })

  it('永久账号（expires_at 为 null）能用', () => {
    expect(userActive(user(), NOW)).toBe(true)
  })

  it('到期即失效，到期那一刻算失效', () => {
    expect(userActive(user({ expires_at: NOW }), NOW)).toBe(false)
    expect(userActive(user({ expires_at: NOW - 1 }), NOW)).toBe(false)
  })

  it('停用优先于有效期', () => {
    expect(userActive(user({ disabled: true, expires_at: NOW + 999 * DAY }), NOW)).toBe(false)
  })

  it('账号不存在（被删了）当作不可用 —— 不能宽容，否则删号后设备还在跑', () => {
    expect(userActive(null, NOW)).toBe(false)
    expect(userActive(undefined, NOW)).toBe(false)
  })

  it('区分停用与到期：用户的下一步动作不同', () => {
    expect(inactiveReason(user({ disabled: true }), NOW)).toBe('disabled')
    expect(inactiveReason(user({ expires_at: NOW - 1 }), NOW)).toBe('expired')
    expect(inactiveReason(user(), NOW)).toBeNull()
  })

  it('剩余天数向上取整 —— 还剩几小时要显示成 1 天而不是 0 天', () => {
    expect(daysLeft(user({ expires_at: NOW + DAY * 3 }), NOW)).toBe(3)
    expect(daysLeft(user({ expires_at: NOW + 3600_000 }), NOW)).toBe(1)
    expect(daysLeft(user(), NOW)).toBeNull()
    expect(daysLeft(user({ expires_at: NOW - DAY }), NOW)).toBe(-1)
  })
})

describe('到期后设备连不上 —— 否则「服务停止」是假的', () => {
  let store: MemoryStore
  let cipher: Cipher
  const TOKEN = 'tok_' + 'x'.repeat(28)

  // handle() 收的是线上的原始帧，不是对象——直接传对象会被判「非法 JSON」，
  // 那样每个用例都会"通过"到 reject 分支，测出来的其实是解析失败
  const hello = () => encodeFrame(makeFrame('hello', {
    device_id: 'dev_1', token: TOKEN, app_version: '1', android_sdk: 34,
    battery: 50, pending_count: 0,
  }, NOW))

  beforeEach(async () => {
    store = new MemoryStore()
    cipher = await createCipher(generateDek())
    store.devices.set('dev_1', {
      id: 'dev_1', user_id: 'u1', name: 'd', token_hash: await hashToken(TOKEN),
      status: 'offline', last_seen_at: null, battery: null, charging: null, net_json: null,
      location_enc: null, location_at: null, app_version: null, created_at: 0,
    })
  })

  const handshake = async () => {
    const s = new DeviceSession({ store, cipher, hub: new MemoryHub(), now: () => NOW })
    return s.handle(hello())
  }

  it('账号正常时握手通过', async () => {
    const r = await handshake()

    expect((r.send[0] as { type: string }).type).toBe('hello_ack')
  })

  it('账号到期后握手被拒', async () => {
    store.users.set('u1', user({ expires_at: NOW - 1 }))
    const r = await handshake()
    expect((r.send[0] as { type: string }).type).toBe('hello_reject')
  })

  it('账号停用后握手被拒', async () => {
    store.users.set('u1', user({ disabled: true }))
    const r = await handshake()
    expect((r.send[0] as { type: string }).type).toBe('hello_reject')
  })

  it('账号被删后握手被拒 —— 设备凭证还有效，但人已经没了', async () => {
    store.users.delete('u1')
    const r = await handshake()
    expect((r.send[0] as { type: string }).type).toBe('hello_reject')
  })
})

describe('到期后后台循环也停', () => {
  let store: MemoryStore

  beforeEach(() => {
    store = new MemoryStore()
    resetAlertState()
  })

  it('保号任务不再发 —— 这是真花钱的', async () => {
    const sent: string[] = []
    store.tasks.set('t1', {
      id: 't1', user_id: 'u1', name: '保号', enabled: true, device_id: 'dev_jp',
      to_number: '138', content_enc: new TextEncoder().encode('保号'), sim_slot: null,
      schedule_json: JSON.stringify({ type: 'daily', time: '00:00' }),
      last_run_at: null, last_status: null, fail_count: 0, created_at: 0,
    })
    store.users.set('u1', user({ expires_at: NOW - 1 }))
    await tick({
      store, timezoneFor: async () => 'UTC', onlineDevices: () => ['dev_jp'],
      send: async (_u, d) => { sent.push(d); return true },
      alert: async () => {}, now: () => NOW,
    }, async (e) => new TextDecoder().decode(e))
    expect(sent).toEqual([])
  })

  it('离线告警不再发 —— 过期账号的手机掉不掉线已经不关网关的事', async () => {
    const alerts: string[] = []
    store.devices.set('dev_1', {
      id: 'dev_1', user_id: 'u1', name: 'd', token_hash: 'h', status: 'online',
      last_seen_at: NOW - 3600_000, battery: 50, charging: false, net_json: null,
      location_enc: null, location_at: null, app_version: null, created_at: 0,
    })
    store.users.set('u1', user({ expires_at: NOW - 1 }))
    await checkDevices({
      store, online: () => [], now: () => NOW,
      channels: async () => { alerts.push('x'); return [] },
    })
    expect(alerts).toEqual([])
  })
})
