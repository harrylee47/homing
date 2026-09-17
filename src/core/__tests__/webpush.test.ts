/**
 * Web Push 的密码学。
 *
 * **这段代码写错了是静默失败**：推送服务照样回 201，浏览器那边解不开、
 * 什么都不显示，服务端日志里没有任何异常。靠跑一遍看不出对错，
 * 只能对着 RFC 里的测试向量核。
 *
 * 向量取自 RFC 8291 §5「Push Message Encryption Example」。
 */
import { describe, expect, it } from 'vitest'
import {
  audienceOf, b64uDecode, b64uEncode, encryptPayload, generateVapidKeys, signVapid,
} from '../webpush.js'

/** RFC 8291 §5 的输入 */
const V = {
  plaintext: 'When I grow up, I want to be a watermelon',
  // 客户端（浏览器）那一侧
  ua_public: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth_secret: 'BTBZMqHH6r4Tts7J_aSIgg',
  // 服务端这次用的临时密钥与 salt（正常是随机的，这里为了复现向量固定住）
  as_public: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  as_private: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  // 期望的完整密文体（salt‖rs‖idlen‖keyid‖ciphertext）
  expected: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml'
    + 'mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT'
    + 'pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
}

/**
 * 把 RFC 给的原始私钥标量 + 公钥点拼成 WebCrypto 能 import 的 JWK。
 * 未压缩点是 0x04 ‖ X(32) ‖ Y(32)。
 */
const importServerKeys = async () => {
  const pub = b64uDecode(V.as_public)
  const jwk = {
    kty: 'EC', crv: 'P-256',
    x: b64uEncode(pub.slice(1, 33)),
    y: b64uEncode(pub.slice(33, 65)),
    d: V.as_private,
    ext: true,
  }
  const privateKey = await crypto.subtle.importKey(
    'jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'],
  )
  const publicKey = await crypto.subtle.importKey(
    'jwk', { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, ext: true },
    { name: 'ECDH', namedCurve: 'P-256' }, true, [],
  )
  return { publicKey, privateKey }
}

describe('载荷加密对得上 RFC 8291 的测试向量', () => {
  it('同样的输入产出同样的密文，一个字节不差', async () => {
    const out = await encryptPayload(
      { endpoint: 'https://push.example.net/x', p256dh: V.ua_public, auth: V.auth_secret },
      V.plaintext,
      b64uDecode(V.salt),
      await importServerKeys(),
    )
    expect(b64uEncode(out)).toBe(V.expected)
  })

  it('信封头部的结构对：salt(16) ‖ rs(4)=4096 ‖ idlen(1)=65 ‖ 公钥(65)', async () => {
    const out = await encryptPayload(
      { endpoint: 'https://push.example.net/x', p256dh: V.ua_public, auth: V.auth_secret },
      'hi',
    )
    expect(out.slice(0, 16).length).toBe(16)
    expect(new DataView(out.buffer, out.byteOffset + 16, 4).getUint32(0)).toBe(4096)
    expect(out[20]).toBe(65)
    expect(out[21]).toBe(0x04)  // 未压缩点的前缀
  })

  /** 复用临时密钥等于放弃前向保密，而且是看不出来的那种放弃 */
  it('每次加密用不同的临时密钥与 salt', async () => {
    const sub = { endpoint: 'https://push.example.net/x', p256dh: V.ua_public, auth: V.auth_secret }
    const a = await encryptPayload(sub, '同样的正文')
    const b = await encryptPayload(sub, '同样的正文')
    expect(b64uEncode(a)).not.toBe(b64uEncode(b))
    expect(b64uEncode(a.slice(0, 16))).not.toBe(b64uEncode(b.slice(0, 16)))
    expect(b64uEncode(a.slice(21, 86))).not.toBe(b64uEncode(b.slice(21, 86)))
  })

  it('中文正文不会被截断或错位', async () => {
    const long = '【建设银行】您的验证码是 902431，5 分钟内有效，请勿泄露给任何人。'
    const sub = { endpoint: 'https://push.example.net/x', p256dh: V.ua_public, auth: V.auth_secret }
    const out = await encryptPayload(sub, long)
    // 明文 + 1 字节分隔符 + 16 字节 GCM tag
    const overhead = 16 + 4 + 1 + 65
    expect(out.length - overhead).toBe(new TextEncoder().encode(long).length + 1 + 16)
  })
})

describe('base64url', () => {
  it('来回转换不丢字节，且不带 = 号', () => {
    for (const n of [0, 1, 2, 3, 16, 31, 32, 65, 100]) {
      const b = crypto.getRandomValues(new Uint8Array(n))
      const s = b64uEncode(b)
      expect(s).not.toContain('=')
      expect(s).not.toContain('+')
      expect(s).not.toContain('/')
      expect([...b64uDecode(s)]).toEqual([...b])
    }
  })
})

describe('VAPID', () => {
  it('生成的公钥是 65 字节未压缩点 —— 浏览器的 applicationServerKey 只认这个', async () => {
    const k = await generateVapidKeys()
    const pub = b64uDecode(k.publicKey)
    expect(pub.length).toBe(65)
    expect(pub[0]).toBe(0x04)
  })

  it('JWT 三段式，头部声明 ES256', async () => {
    const k = await generateVapidKeys()
    const jwt = await signVapid(k, 'https://fcm.googleapis.com', 'mailto:a@example.com')
    const [h, c, sig] = jwt.split('.')
    expect(JSON.parse(new TextDecoder().decode(b64uDecode(h!)))).toEqual({ typ: 'JWT', alg: 'ES256' })
    // ES256 的签名是 r‖s，固定 64 字节；若拿到的是 DER 就说明格式错了，推送服务会回 401
    expect(b64uDecode(sig!).length).toBe(64)
    const claims = JSON.parse(new TextDecoder().decode(b64uDecode(c!))) as Record<string, unknown>
    expect(claims.aud).toBe('https://fcm.googleapis.com')
    expect(claims.sub).toBe('mailto:a@example.com')
  })

  it('签名能用自己的公钥验过', async () => {
    const k = await generateVapidKeys()
    const jwt = await signVapid(k, 'https://push.example.net', 'mailto:a@example.com')
    const [h, c, sig] = jwt.split('.')
    const pub = await crypto.subtle.importKey(
      'raw', b64uDecode(k.publicKey).slice().buffer as ArrayBuffer,
      { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'],
    )
    const ok = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' }, pub,
      b64uDecode(sig!).slice().buffer as ArrayBuffer,
      new TextEncoder().encode(`${h}.${c}`).slice().buffer as ArrayBuffer,
    )
    expect(ok).toBe(true)
  })

  /** exp 超过 24 小时推送服务直接 401，这是能看见但容易忘的一条 */
  it('有效期不超过 24 小时', async () => {
    const now = 1_700_000_000_000
    const k = await generateVapidKeys()
    const jwt = await signVapid(k, 'https://push.example.net', 'mailto:a@example.com', now)
    const claims = JSON.parse(new TextDecoder().decode(b64uDecode(jwt.split('.')[1]!))) as { exp: number }
    expect(claims.exp - now / 1000).toBeLessThanOrEqual(24 * 3600)
    expect(claims.exp).toBeGreaterThan(now / 1000)
  })

  it('aud 取的是 endpoint 的 origin，不是整条地址', () => {
    expect(audienceOf('https://fcm.googleapis.com/fcm/send/abc123?x=1')).toBe('https://fcm.googleapis.com')
    expect(audienceOf('https://web.push.apple.com/QF1..../more')).toBe('https://web.push.apple.com')
  })
})
