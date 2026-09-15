import { beforeEach, describe, expect, it } from 'vitest'
import { createCipher, generateDek, hashToken } from '../crypto.js'
import { encodeFrame, makeFrame } from '../frames.js'
import { ErrorCode, type DownstreamFrame } from '../protocol.js'
import { DeviceSession } from '../session.js'
import { MemoryHub, MemoryStore } from './fakes.js'

const NOW = 1_757_894_400_000
const DEVICE = 'dev_test01'
const TOKEN = 'T'.repeat(32)

const helloFrame = (token = TOKEN, device = DEVICE) =>
  encodeFrame(makeFrame('hello', {
    device_id: device, token, app_version: '0.1.0',
    android_sdk: 34, battery: 87, pending_count: 0,
  }, NOW))

const eventFrame = (id: string, device = DEVICE, occurred = NOW - 10_000) =>
  encodeFrame(makeFrame('event', {
    id, device_id: device, kind: 'sms', from: '95533',
    content: '您的验证码是 123456', occurred_at: occurred, sim_slot: 0, extra: {},
  }, NOW))

const evtId = () => `evt_${crypto.randomUUID()}`

describe('会话状态机', () => {
  let store: MemoryStore
  let session: DeviceSession

  beforeEach(async () => {
    store = new MemoryStore()
    store.devices.set(DEVICE, {
      id: DEVICE, name: 'test', token_hash: await hashToken(TOKEN),
      status: 'offline', last_seen_at: null, battery: null, charging: null,
      location_enc: null, location_at: null, app_version: null, created_at: NOW,
    })
    session = new DeviceSession({
      store, hub: new MemoryHub(),
      cipher: await createCipher(generateDek()),
      now: () => NOW,
    })
  })

  const typeOf = (f: DownstreamFrame) => f.type

  it('正确凭证握手成功并置为在线', async () => {
    const a = await session.handle(helloFrame())
    expect(a.send.map(typeOf)).toEqual(['hello_ack'])
    expect(store.devices.get(DEVICE)!.status).toBe('online')
    expect(session.authenticatedDeviceId).toBe(DEVICE)
  })

  it('错误凭证被拒并关闭连接', async () => {
    const a = await session.handle(helloFrame('W'.repeat(32)))
    expect(a.send.map(typeOf)).toEqual(['hello_reject'])
    expect(a.close).toBeDefined()
    expect(session.authenticatedDeviceId).toBeNull()
  })

  it('未注册设备返回 AUTH_UNKNOWN_DEVICE', async () => {
    const a = await session.handle(helloFrame(TOKEN, 'dev_nope'))
    expect((a.send[0] as { payload: { code: string } }).payload.code).toBe(ErrorCode.AUTH_UNKNOWN_DEVICE)
  })

  it('已吊销设备被拒且 retry_after 为 null（不可重试）', async () => {
    await store.revokeDevice(DEVICE)
    const a = await session.handle(helloFrame())
    const p = (a.send[0] as { payload: { code: string; retry_after_sec: number | null } }).payload
    expect(p.code).toBe(ErrorCode.AUTH_DEVICE_REVOKED)
    expect(p.retry_after_sec).toBeNull()
  })

  it('首帧不是 hello 一律拒绝', async () => {
    const a = await session.handle(eventFrame(evtId()))
    expect(a.send.map(typeOf)).toEqual(['hello_reject'])
  })

  it('事件入库并回 stored', async () => {
    await session.handle(helloFrame())
    const id = evtId()
    const a = await session.handle(eventFrame(id))
    expect((a.send[0] as { payload: { acks: { status: string }[] } }).payload.acks[0]!.status).toBe('stored')
    expect(store.events.size).toBe(1)
  })

  it('重复上报幂等去重，仍回 ack 让 Agent 出队', async () => {
    await session.handle(helloFrame())
    const id = evtId()
    await session.handle(eventFrame(id))
    const a = await session.handle(eventFrame(id))
    expect((a.send[0] as { payload: { acks: { status: string }[] } }).payload.acks[0]!.status).toBe('duplicate')
    expect(store.events.size).toBe(1)
  })

  it('落库的是密文，不是明文', async () => {
    await session.handle(helloFrame())
    await session.handle(eventFrame(evtId()))
    const stored = [...store.events.values()][0]!
    const text = new TextDecoder().decode(stored.content_enc)
    expect(text).not.toContain('123456')
    expect(stored.enc_ver).toBe(1)
  })

  it('occurred_at 按设备上报值保留，received_at 是服务端时间', async () => {
    await session.handle(helloFrame())
    const occurred = NOW - 3 * 24 * 3600 * 1000
    await session.handle(eventFrame(evtId(), DEVICE, occurred))
    const stored = [...store.events.values()][0]!
    expect(stored.occurred_at).toBe(occurred)
    expect(stored.received_at).toBe(NOW)
  })

  it('冒用他人 device_id 的事件被拒（每帧校验绑定关系）', async () => {
    await session.handle(helloFrame())
    const a = await session.handle(eventFrame(evtId(), 'dev_other'))
    expect((a.send[0] as { payload: { acks: { status: string }[] } }).payload.acks[0]!.status).toBe('rejected')
    expect(store.events.size).toBe(0)
  })

  it('已认证后收到非法帧不断连，只丢弃', async () => {
    await session.handle(helloFrame())
    const a = await session.handle('{garbage')
    expect(a.send).toEqual([])
    expect(a.close).toBeUndefined()
    expect(session.authenticatedDeviceId).toBe(DEVICE)
  })

  it('ping 回 pong 且 seq 一致', async () => {
    await session.handle(helloFrame())
    const a = await session.handle(encodeFrame(makeFrame('ping', { seq: 7 }, NOW)))
    expect(a.send[0]).toMatchObject({ type: 'pong', payload: { seq: 7 } })
  })

  it('断开时置为离线', async () => {
    await session.handle(helloFrame())
    await session.onDisconnect()
    expect(store.devices.get(DEVICE)!.status).toBe('offline')
  })
})

describe('历史导入的去重', () => {
  const OCCURRED = NOW - 3_600_000

  /** 建一个已认证的会话，并给它一个可控的 store 与 cipher */
  const authed = async () => {
    const store = new MemoryStore()
    const cipher = await createCipher(generateDek())
    store.devices.set(DEVICE, {
      id: DEVICE, name: 'test', token_hash: await hashToken(TOKEN),
      status: 'offline', last_seen_at: null, battery: null, charging: null,
      location_enc: null, location_at: null, app_version: null, created_at: NOW,
    })
    const session = new DeviceSession({
      store, hub: new MemoryHub(), cipher, now: () => NOW,
      // 不跑推送管线，这组用例只关心入库与去重
      onStored: () => {},
    })
    await session.handle(helloFrame())
    return { session, store, cipher }
  }

  const importFrame = (over: Record<string, unknown> = {}) => encodeFrame(makeFrame('event', {
    id: 'evt_imp_sms_42', device_id: DEVICE, kind: 'sms',
    from: '95533', content: '【建设银行】您的验证码是 902431',
    occurred_at: OCCURRED, extra: { imported: true },
    ...over,
  }, NOW))

  /** 往库里塞一条「实时捕获过」的记录 */
  const seedLive = async (
    store: MemoryStore, cipher: Awaited<ReturnType<typeof createCipher>>,
    content: string, occurred: number,
  ) => {
    store.events.set('evt_live', {
      id: 'evt_live', device_id: DEVICE, kind: 'sms', direction: 'in',
      sender_enc: await cipher.encrypt('95533'),
      content_enc: await cipher.encrypt(content),
      enc_ver: 1, occurred_at: occurred, received_at: NOW,
      matched_rules: null, created_at: NOW,
    })
  }

  const ackStatus = (a: { send: DownstreamFrame[] }) =>
    (a.send[0]!.payload as { acks: { status: string }[] }).acks[0]!.status

  it('实时捕获过的同一条不会再进来一次', async () => {
    const { session, store, cipher } = await authed()
    // 实时那条 id 是随机 UUID、时间差一秒，按 id 去重完全挡不住
    await seedLive(store, cipher, '【建设银行】您的验证码是 902431', OCCURRED + 1000)
    const a = await session.handle(importFrame())
    expect(ackStatus(a)).toBe('duplicate')
    expect(store.events.size).toBe(1)
  })

  it('内容不同就正常入库', async () => {
    const { session, store, cipher } = await authed()
    await seedLive(store, cipher, '另一条完全不同的短信', OCCURRED + 1000)
    await session.handle(importFrame())
    expect(store.events.size).toBe(2)
  })

  it('时间隔得远的相同内容不算重复——真的可能收到两条一样的短信', async () => {
    const { session, store, cipher } = await authed()
    await seedLive(store, cipher, '【建设银行】您的验证码是 902431', OCCURRED - 60_000)
    await session.handle(importFrame())
    expect(store.events.size).toBe(2)
  })

  it('非导入的事件不走这条检查——实时链路不该为此多付解密开销', async () => {
    const { session, store, cipher } = await authed()
    await seedLive(store, cipher, '【建设银行】您的验证码是 902431', OCCURRED + 1000)
    await session.handle(importFrame({ id: evtId(), extra: {} }))
    expect(store.events.size).toBe(2)
  })

  it('重复导入同一条（id 相同）仍然是幂等的', async () => {
    const { session, store } = await authed()
    await session.handle(importFrame())
    const a = await session.handle(importFrame())
    expect(ackStatus(a)).toBe('duplicate')
    expect(store.events.size).toBe(1)
  })
})

describe('吊销必须真的吊销得掉', () => {
  /**
   * 这一组针对一条完整的绕回路径：
   * 吊销 → 踢掉连接 → 断线回调写 status=offline 把 revoked 覆盖 →
   * Agent 拿原 token 重连 → 握手看到的是 offline → 验证通过，设备又活了。
   *
   * 也就是说吊销恰好在「设备在线」时失效——而手机丢了要紧急吊销时它多半在线。
   */
  const fresh = async () => {
    const store = new MemoryStore()
    store.devices.set(DEVICE, {
      id: DEVICE, name: 'test', token_hash: await hashToken(TOKEN),
      status: 'offline', last_seen_at: null, battery: null, charging: null,
      location_enc: null, location_at: null, app_version: null, created_at: NOW,
    })
    const session = new DeviceSession({
      store, hub: new MemoryHub(),
      cipher: await createCipher(generateDek()),
      now: () => NOW, onStored: () => {},
    })
    return { store, session }
  }

  it('断线不会把吊销状态改回离线', async () => {
    const { store, session } = await fresh()
    await session.handle(helloFrame())
    await store.revokeDevice(DEVICE)
    await session.onDisconnect()
    expect(store.devices.get(DEVICE)!.status).toBe('revoked')
  })

  it('吊销后原凭证无法再握手——哪怕状态被改回去了', async () => {
    const { store, session } = await fresh()
    await store.revokeDevice(DEVICE)
    // 模拟「状态被某条路径覆盖回 offline」这种最坏情况
    store.devices.set(DEVICE, { ...store.devices.get(DEVICE)!, status: 'offline' })

    const a = await session.handle(helloFrame())
    expect(a.send[0]!.type).toBe('hello_reject')
    expect(session.authenticatedDeviceId).toBeNull()
  })

  it('吊销后正常路径也拒绝，且给出的是吊销这个原因', async () => {
    const { store, session } = await fresh()
    await store.revokeDevice(DEVICE)
    const a = await session.handle(helloFrame())
    expect((a.send[0]!.payload as { code: string }).code).toBe(ErrorCode.AUTH_DEVICE_REVOKED)
  })
})
