/**
 * Web Push 的两套密码学：载荷加密（RFC 8291 / aes128gcm）与 VAPID 签名（RFC 8292）。
 *
 * 全部用 WebCrypto，不引依赖、运行时无关——Workers 上同样能跑。
 *
 * **这段代码写错了是静默失败**：推送发出去，推送服务返回 201，
 * 而浏览器那边解不开、什么都不显示，日志里也不会有任何异常。
 * 所以两条链路都对着 RFC 里的测试向量做了单测（webpush.test.ts），
 * 改动之后那几条必须仍然通过。
 */

/**
 * WebCrypto 的密钥类型。
 *
 * tsconfig 的 lib 是 ES2023、types 只有 node，全局拿不到 `CryptoKey` 这个名字，
 * 所以从 importKey 的返回类型推出来——比给 core 层加一个 DOM lib 干净。
 */
type WcKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>

// ── base64url ──────────────────────────────────────────────

export function b64uEncode(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function b64uDecode(s: string): Uint8Array {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(pad + '='.repeat((4 - (pad.length % 4)) % 4))
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.length }
  return out
}

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)

/** 长度前缀（2 字节大端），RFC 8291 拼 info 串时要用 */
const u16 = (n: number): Uint8Array => new Uint8Array([(n >> 8) & 0xff, n & 0xff])

// ── HKDF（RFC 5869，SHA-256）────────────────────────────────

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, len: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm.slice().buffer as ArrayBuffer, 'HKDF', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: salt.slice().buffer as ArrayBuffer, info: info.slice().buffer as ArrayBuffer },
    key, len * 8,
  )
  return new Uint8Array(bits)
}

// ── 载荷加密（RFC 8291）────────────────────────────────────

/** 浏览器 subscribe() 之后给出的三样东西 */
export interface PushSubscription {
  endpoint: string
  /** 客户端公钥，base64url 的未压缩 P-256 点（65 字节） */
  p256dh: string
  /** 客户端认证密钥，base64url 的 16 字节 */
  auth: string
}

/**
 * 按 aes128gcm 加密一条载荷。
 *
 * 结构（RFC 8188 §2.1）：salt(16) ‖ rs(4) ‖ idlen(1) ‖ keyid ‖ ciphertext
 * 其中 keyid 放服务端这次用的临时公钥，所以客户端不需要额外通道就能解。
 *
 * @param salt 与 @param serverKeys 仅供测试注入；线上一律随机生成。
 */
export async function encryptPayload(
  sub: PushSubscription,
  plaintext: string,
  salt: Uint8Array = crypto.getRandomValues(new Uint8Array(16)),
  serverKeys?: { publicKey: WcKey; privateKey: WcKey },
): Promise<Uint8Array> {
  const clientPub = b64uDecode(sub.p256dh)
  const authSecret = b64uDecode(sub.auth)

  // 每条消息一对临时密钥（ECDHE）。复用等于放弃前向保密
  const keys = serverKeys ?? (await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'],
  ) as { publicKey: WcKey; privateKey: WcKey })
  const serverPub = new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey))

  const clientKey = await crypto.subtle.importKey(
    'raw', clientPub.slice().buffer as ArrayBuffer, { name: 'ECDH', namedCurve: 'P-256' }, false, [],
  )
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: clientKey }, keys.privateKey, 256),
  )

  // 第一次 HKDF 用 auth secret 当 salt，info 里绑定双方公钥——
  // 这一步把「这条消息是发给这个订阅的」钉死
  const prkInfo = concat(utf8('WebPush: info\0'), clientPub, serverPub)
  const ikm = await hkdf(authSecret, shared, prkInfo, 32)

  const cek = await hkdf(salt, ikm, utf8('Content-Encoding: aes128gcm\0'), 16)
  const nonce = await hkdf(salt, ikm, utf8('Content-Encoding: nonce\0'), 12)

  // aes128gcm 要求明文后面跟一个分隔符：最后一条记录用 0x02，其余用 0x01。
  // 我们只发一条记录，所以是 0x02。写成 0x01 的话浏览器会一直等下一条记录
  const padded = concat(utf8(plaintext), new Uint8Array([0x02]))
  const aesKey = await crypto.subtle.importKey('raw', cek.slice().buffer as ArrayBuffer, 'AES-GCM', false, ['encrypt'])
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce.slice().buffer as ArrayBuffer }, aesKey, padded.slice().buffer as ArrayBuffer,
  ))

  const rs = new Uint8Array(4)
  new DataView(rs.buffer).setUint32(0, 4096)
  return concat(salt, rs, new Uint8Array([serverPub.length]), serverPub, ct)
}

// ── VAPID（RFC 8292）───────────────────────────────────────

export interface VapidKeys {
  /** base64url 的未压缩 P-256 公钥（65 字节），要交给浏览器的 applicationServerKey */
  publicKey: string
  /** base64url 的 PKCS#8 私钥 */
  privateKey: string
}

export async function generateVapidKeys(): Promise<VapidKeys> {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  return {
    publicKey: b64uEncode(new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey))),
    privateKey: b64uEncode(new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey))),
  }
}

/**
 * 签一个 VAPID JWT，作为 Authorization 头发给推送服务。
 *
 * aud 必须是推送服务的 origin（不是整个 endpoint），sub 必须是 mailto: 或 https:，
 * exp 不能超过 24 小时——三条里错一条推送服务就回 401，而那是能看见的失败，
 * 比载荷加密错了要好排查。
 */
export async function signVapid(
  keys: VapidKeys, audience: string, subject: string, now = Date.now(),
): Promise<string> {
  const header = b64uEncode(utf8(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const claims = b64uEncode(utf8(JSON.stringify({
    aud: audience,
    exp: Math.floor(now / 1000) + 12 * 3600,
    sub: subject,
  })))
  const signingInput = `${header}.${claims}`

  const key = await crypto.subtle.importKey(
    'pkcs8', b64uDecode(keys.privateKey).slice().buffer as ArrayBuffer,
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'],
  )
  // WebCrypto 直接给出 JOSE 要的 r‖s 原始格式，不需要拆 DER
  const sig = new Uint8Array(await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, key, utf8(signingInput).slice().buffer as ArrayBuffer,
  ))
  return `${signingInput}.${b64uEncode(sig)}`
}

/** endpoint 的 origin，VAPID 的 aud 用它 */
export function audienceOf(endpoint: string): string {
  const u = new URL(endpoint)
  return `${u.protocol}//${u.host}`
}
