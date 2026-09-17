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
import { ErrorCode, FATAL_ERROR_CODES } from '../protocol.js'
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

  /** 拒绝帧里真正决定 Agent 行为的两个字段 */
  const rejection = (r: Awaited<ReturnType<typeof handshake>>) =>
    r.send[0] as { type: string; payload: { code: string; retry_after_sec: number | null } }

  it('账号到期后握手被拒', async () => {
    store.users.set('u1', user({ expires_at: NOW - 1 }))
    const r = await handshake()
    expect(rejection(r).type).toBe('hello_reject')
  })

  it('账号停用后握手被拒', async () => {
    store.users.set('u1', user({ disabled: true }))
    const r = await handshake()
    expect(rejection(r).type).toBe('hello_reject')
  })

  /**
   * 到期用的错误码**必须可重试**。
   *
   * 踩过的坑：一开始复用了 AUTH_DEVICE_REVOKED，而它在 FATAL_ERROR_CODES 里，
   * Agent 收到后进 ConnState.Fatal 永久停止重连——于是续完期手机也不回来，
   * 必须跑到手机跟前重新配对。等于「续期」这个功能根本不存在，
   * 而且到期那天手机多半正在线，问题当场发作。
   */
  it('到期用的是可重试的错误码，不是「去重新配对」', async () => {
    store.users.set('u1', user({ expires_at: NOW - 1 }))
    const p = rejection(await handshake()).payload
    expect(p.code).toBe(ErrorCode.ACCOUNT_INACTIVE)
    expect(FATAL_ERROR_CODES).not.toContain(p.code)
    expect(p.retry_after_sec).not.toBeNull()
  })

  it('停用同理 —— 管理员点回启用，手机自己就回来了', async () => {
    store.users.set('u1', user({ disabled: true }))
    const p = rejection(await handshake()).payload
    expect(p.code).toBe(ErrorCode.ACCOUNT_INACTIVE)
    expect(p.retry_after_sec).not.toBeNull()
  })

  it('续期之后同一台设备用原凭证就能连回来', async () => {
    store.users.set('u1', user({ expires_at: NOW - 1 }))
    expect(rejection(await handshake()).type).toBe('hello_reject')

    // 管理员续期 / 用户拿邀请码自助续期
    store.users.set('u1', user({ expires_at: NOW + 30 * DAY }))
    expect((await handshake()).send[0]!.type).toBe('hello_ack')
  })

  it('设备被吊销仍然是不可重试的 —— 那才是真要人动手的', async () => {
    await store.revokeDevice('dev_1', 'u1')
    const p = rejection(await handshake()).payload
    expect(p.code).toBe(ErrorCode.AUTH_DEVICE_REVOKED)
    expect(p.retry_after_sec).toBeNull()
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

/**
 * 连接日志要记下**握手被拒**的那几次。
 *
 * 那几条恰恰是最该看到的：设备突然连不上了，日志里得说清是凭证被吊销、
 * 凭证不对，还是账号到期。而它们发生在会话记下 device_id **之前**——
 * 第一版靠成员变量取 id，于是这三条一条都没记上。
 */
describe('连接日志记下了被拒的原因', () => {
  const TOKEN = 'tok_' + 'y'.repeat(28)
  const hello = () => encodeFrame(makeFrame('hello', {
    device_id: 'dev_1', token: TOKEN, app_version: '1.2.3', android_sdk: 34,
    battery: 55, pending_count: 3,
  }, NOW))

  const fresh = async () => {
    const store = new MemoryStore()
    const cipher = await createCipher(generateDek())
    store.devices.set('dev_1', {
      id: 'dev_1', user_id: 'u1', name: 'd', token_hash: await hashToken(TOKEN),
      status: 'offline', last_seen_at: null, battery: null, charging: null, net_json: null,
      location_enc: null, location_at: null, app_version: null, created_at: 0,
    })
    store.users.set('u1', user({}))
    const s = new DeviceSession({ store, cipher, hub: new MemoryHub(), now: () => NOW })
    return { store, session: s }
  }

  it('上线记一条，带版本与电量，且不含任何凭证', async () => {
    const { store, session } = await fresh()
    await session.handle(hello())
    const logs = await store.listDeviceLogs('dev_1', 'u1', 10, 0)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({ level: 'info', event: 'online' })
    expect(logs[0]!.detail).toContain('1.2.3')
    expect(logs[0]!.detail).toContain('待补传 3 条')
    expect(JSON.stringify(logs[0])).not.toContain(TOKEN)
  })

  it('凭证不对记成 error，说清要重新配对', async () => {
    const { store, session } = await fresh()
    await session.handle(encodeFrame(makeFrame('hello', {
      device_id: 'dev_1', token: 'W'.repeat(32), app_version: '1', android_sdk: 34,
      battery: 50, pending_count: 0,
    }, NOW)))
    const logs = await store.listDeviceLogs('dev_1', 'u1', 10, 0)
    expect(logs[0]).toMatchObject({ level: 'error', event: 'auth_failed' })
    expect(logs[0]!.detail).toContain('重新配对')
  })

  it('已吊销与账号到期各记各的原因，不混成一句「连不上」', async () => {
    const a = await fresh()
    await a.store.revokeDevice('dev_1', 'u1')
    await a.session.handle(hello())
    expect((await a.store.listDeviceLogs('dev_1', 'u1', 10, 0))[0]).toMatchObject({ event: 'auth_revoked' })

    const b = await fresh()
    b.store.users.set('u1', user({ expires_at: NOW - 1 }))
    await b.session.handle(hello())
    expect((await b.store.listDeviceLogs('dev_1', 'u1', 10, 0))[0]).toMatchObject({ event: 'account_inactive' })
  })

  it('断开记一条 offline', async () => {
    const { store, session } = await fresh()
    await session.handle(hello())
    await session.onDisconnect()
    const logs = await store.listDeviceLogs('dev_1', 'u1', 10, 0)
    expect(logs.map((l) => l.event)).toEqual(['offline', 'online'])
  })

  it('别人查不到这台设备的日志', async () => {
    const { store, session } = await fresh()
    await session.handle(hello())
    expect(await store.listDeviceLogs('dev_1', '别的用户', 10, 0)).toEqual([])
  })
})
