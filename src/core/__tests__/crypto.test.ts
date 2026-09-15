import { describe, expect, it } from 'vitest'
import { createCipher, fromHex, generateDek, hashToken, timingSafeEqual, toHex } from '../crypto.js'

describe('加密', () => {
  it('加解密往返', async () => {
    const c = await createCipher(generateDek())
    const plain = '【建设银行】您的验证码是 123456，5 分钟内有效'
    expect(await c.decrypt(await c.encrypt(plain))).toBe(plain)
  })

  it('相同明文两次加密得到不同密文（IV 随机）', async () => {
    const c = await createCipher(generateDek())
    const a = await c.encrypt('123456')
    const b = await c.encrypt('123456')
    expect(toHex(a)).not.toBe(toHex(b))
  })

  it('密文首字节是 enc_ver，支持将来轮换', async () => {
    const c = await createCipher(generateDek())
    expect((await c.encrypt('x'))[0]).toBe(1)
  })

  it('换密钥解不开', async () => {
    const a = await createCipher(generateDek())
    const b = await createCipher(generateDek())
    await expect(b.decrypt(await a.encrypt('secret'))).rejects.toThrow()
  })

  it('密文被篡改即失败（GCM 完整性）', async () => {
    const c = await createCipher(generateDek())
    const blob = await c.encrypt('123456')
    blob[blob.length - 1] = (blob.at(-1)! ^ 0xff) & 0xff
    await expect(c.decrypt(blob)).rejects.toThrow()
  })

  it('DEK 必须 32 字节', async () => {
    await expect(createCipher(new Uint8Array(16))).rejects.toThrow(/32 字节/)
  })

  it('hex 往返', () => {
    const k = generateDek()
    expect(toHex(fromHex(toHex(k)))).toBe(toHex(k))
    expect(() => fromHex('zz')).toThrow()
  })

  it('token 哈希稳定且恒定时间比较正确', async () => {
    const h = await hashToken('abc')
    expect(await hashToken('abc')).toBe(h)
    expect(timingSafeEqual(h, h)).toBe(true)
    expect(timingSafeEqual(h, await hashToken('abd'))).toBe(false)
  })
})
