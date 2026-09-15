import { beforeEach, describe, expect, it } from 'vitest'
import { createCipher, generateDek, hashToken } from '../crypto.js'
import { encodeFrame, makeFrame } from '../frames.js'
import { DeviceSession } from '../session.js'
import type { Cipher } from '../crypto.js'
import { MemoryHub, MemoryStore } from './fakes.js'

const NOW = 1_757_894_400_000
const DEVICE = 'dev_test01'
const TOKEN = 'T'.repeat(32)
const CMD = `cmd_${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}`

describe('发送任务状态机', () => {
  let store: MemoryStore
  let session: DeviceSession
  let cipher: Cipher

  const seed = async (status: 'pending' | 'accepted' | 'sent' | 'delivered' = 'pending') => {
    await store.createOutbound({
      id: CMD, device_id: DEVICE, to_number: '13800138000',
      content_enc: await cipher.encrypt('测试'), sim_slot: null,
      status, error: null, created_at: NOW, updated_at: NOW,
    })
  }

  const result = (status: string, error: string | null = null) =>
    encodeFrame(makeFrame('cmd_result', { cmd_id: CMD, status, error, detail: null }, NOW))

  beforeEach(async () => {
    store = new MemoryStore()
    cipher = await createCipher(generateDek())
    store.devices.set(DEVICE, {
      id: DEVICE, name: 't', token_hash: await hashToken(TOKEN), status: 'offline',
      last_seen_at: null, battery: null, charging: null, app_version: null, created_at: NOW,
    })
    session = new DeviceSession({ store, cipher, hub: new MemoryHub(), now: () => NOW, onStored: () => {} })
    await session.handle(encodeFrame(makeFrame('hello', {
      device_id: DEVICE, token: TOKEN, app_version: '0.1.0',
      android_sdk: 31, battery: 50, pending_count: 0,
    }, NOW)))
  })

  it('完整流转 accepted → sent → delivered', async () => {
    await seed()
    for (const s of ['accepted', 'sent', 'delivered']) {
      await session.handle(result(s))
      expect(store.outbound.get(CMD)!.status).toBe(s)
    }
  })

  it('乱序回执不会让状态倒退', async () => {
    // 多段短信的 sent / delivered 回执顺序不保证
    await seed()
    await session.handle(result('delivered'))
    await session.handle(result('sent'))
    expect(store.outbound.get(CMD)!.status).toBe('delivered')
  })

  it('重复回执不改变状态', async () => {
    await seed('sent')
    await session.handle(result('sent'))
    expect(store.outbound.get(CMD)!.status).toBe('sent')
  })

  it('任何阶段都能转 failed 并记录原因', async () => {
    await seed('sent')
    await session.handle(result('failed', '无服务'))
    const o = store.outbound.get(CMD)!
    expect(o.status).toBe('failed')
    expect(o.error).toBe('无服务')
  })

  it('已送达后仍可标记失败（运营商后置回执）', async () => {
    await seed('delivered')
    await session.handle(result('failed', '送达失败'))
    expect(store.outbound.get(CMD)!.status).toBe('failed')
  })

  it('未知 cmd_id 的回执被忽略，不创建记录', async () => {
    await session.handle(result('sent'))
    expect(store.outbound.size).toBe(0)
  })

  it('内容加密存储，库里搜不到明文', async () => {
    await seed()
    const o = store.outbound.get(CMD)!
    expect(new TextDecoder().decode(o.content_enc)).not.toContain('测试')
    expect(await cipher.decrypt(o.content_enc)).toBe('测试')
  })
})
