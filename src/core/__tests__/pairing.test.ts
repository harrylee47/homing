import { describe, expect, it } from 'vitest'
import { createPairing, generatePairingCode, generateToken, PAIRING_TTL_MS, redeemPairing } from '../pairing.js'
import { MemoryStore } from './fakes.js'

describe('配对', () => {
  it('配对码不含易混淆字符 O/0/I/1', () => {
    for (let i = 0; i < 200; i++) {
      expect(generatePairingCode()).not.toMatch(/[O0I1]/)
    }
  })

  it('配对码长度固定为 8', () => {
    expect(generatePairingCode()).toHaveLength(8)
  })

  it('凭证是 base64url，不含需转义的字符', () => {
    for (let i = 0; i < 50; i++) {
      expect(generateToken()).toMatch(/^[A-Za-z0-9_-]+$/)
    }
  })

  it('正常流程：生成 → 兑换 → 得到设备与凭证', async () => {
    const store = new MemoryStore()
    const { code } = await createPairing(store, 'JP-Gateway-01')
    const r = await redeemPairing(store, code)
    expect(r).not.toBeNull()
    expect(r!.device_name).toBe('JP-Gateway-01')
    expect(store.devices.size).toBe(1)
  })

  it('服务端不存配对码明文，也不存凭证明文', async () => {
    const store = new MemoryStore()
    const { code } = await createPairing(store, 'x')
    expect([...store.pairings.keys()]).not.toContain(code)

    const r = await redeemPairing(store, code)
    const device = [...store.devices.values()][0]!
    expect(device.token_hash).not.toBe(r!.token)
    expect(device.token_hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('配对码只能用一次', async () => {
    const store = new MemoryStore()
    const { code } = await createPairing(store, 'x')
    expect(await redeemPairing(store, code)).not.toBeNull()
    expect(await redeemPairing(store, code)).toBeNull()
    expect(store.devices.size).toBe(1)
  })

  it('过期的配对码无效', async () => {
    const store = new MemoryStore()
    const t0 = 1_000_000
    const { code } = await createPairing(store, 'x', t0)
    expect(await redeemPairing(store, code, t0 + PAIRING_TTL_MS + 1)).toBeNull()
  })

  it('临过期前仍可用', async () => {
    const store = new MemoryStore()
    const t0 = 1_000_000
    const { code } = await createPairing(store, 'x', t0)
    expect(await redeemPairing(store, code, t0 + PAIRING_TTL_MS - 1000)).not.toBeNull()
  })

  it('不存在的配对码返回 null 而非抛错', async () => {
    const store = new MemoryStore()
    expect(await redeemPairing(store, 'ZZZZZZZZ')).toBeNull()
  })

  it('大小写与空格不敏感，便于人工抄写', async () => {
    const store = new MemoryStore()
    const { code } = await createPairing(store, 'x')
    expect(await redeemPairing(store, `  ${code.toLowerCase()}  `)).not.toBeNull()
  })

  it('每台设备拿到不同的 id 与凭证', async () => {
    const store = new MemoryStore()
    const a = await redeemPairing(store, (await createPairing(store, 'a')).code)
    const b = await redeemPairing(store, (await createPairing(store, 'b')).code)
    expect(a!.device_id).not.toBe(b!.device_id)
    expect(a!.token).not.toBe(b!.token)
  })

  it('留下审计记录', async () => {
    const store = new MemoryStore()
    const { code } = await createPairing(store, 'x')
    await redeemPairing(store, code)
    expect(store.audits.map((a) => a.action)).toEqual(['pairing.create', 'pairing.redeem'])
  })
})
