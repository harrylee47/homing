/**
 * 落库加密：AES-256-GCM（计划 §6.2）。
 *
 * 用 WebCrypto 而非 node:crypto —— 两个运行时都提供，满足运行时无关约束。
 *
 * 密文布局：[enc_ver:1][iv:12][ciphertext+tag]
 * enc_ver 内嵌在密文里，使密钥轮换不需要迁移历史数据：
 * 解密时按每条记录自己的版本选密钥。
 */

export const ENC_VER_V1 = 1
const IV_LEN = 12

/** Uint8Array → 独立 ArrayBuffer。避免 TS 5.7 起 Uint8Array 泛型与 BufferSource 的不兼容。 */
const buf = (u: Uint8Array): ArrayBuffer =>
  u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer

export interface Cipher {
  encrypt(plain: string): Promise<Uint8Array>
  decrypt(blob: Uint8Array): Promise<string>
}

/** 从 32 字节原始密钥（DEK）构造。DEK 由启动时生成或环境变量注入。 */
export async function createCipher(dek: Uint8Array, version = ENC_VER_V1): Promise<Cipher> {
  if (dek.length !== 32) throw new Error(`DEK 必须为 32 字节，收到 ${dek.length}`)
  const key = await crypto.subtle.importKey('raw', buf(dek), 'AES-GCM', false, ['encrypt', 'decrypt'])

  return {
    async encrypt(plain: string): Promise<Uint8Array> {
      const iv = crypto.getRandomValues(new Uint8Array(IV_LEN))
      const ct = new Uint8Array(
        await crypto.subtle.encrypt({ name: 'AES-GCM', iv: buf(iv) }, key, buf(new TextEncoder().encode(plain))),
      )
      const out = new Uint8Array(1 + IV_LEN + ct.length)
      out[0] = version
      out.set(iv, 1)
      out.set(ct, 1 + IV_LEN)
      return out
    },

    async decrypt(blob: Uint8Array): Promise<string> {
      if (blob.length < 1 + IV_LEN + 16) throw new Error('密文长度非法')
      const ver = blob[0]
      if (ver !== version) throw new Error(`密文版本 ${ver} 与当前密钥版本 ${version} 不匹配`)
      const iv = blob.subarray(1, 1 + IV_LEN)
      const ct = blob.subarray(1 + IV_LEN)
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf(iv) }, key, buf(ct))
      return new TextDecoder().decode(pt)
    },
  }
}

/** 生成新的 32 字节 DEK。首次启动时调用，写入 /data 并设 600 权限。 */
export const generateDek = (): Uint8Array => crypto.getRandomValues(new Uint8Array(32))

export const toHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
export function fromHex(h: string): Uint8Array {
  const clean = h.trim()
  if (!/^[0-9a-fA-F]*$/.test(clean) || clean.length % 2 !== 0) throw new Error('非法 hex 字符串')
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}

/**
 * 设备凭证哈希。服务端只存哈希，明文只在配对那一刻存在（计划 §6.1）。
 * 凭证是 32 字节高熵随机串，不是用户口令，SHA-256 足够；
 * 控制台的人类口令另走 Argon2id，不要复用这个函数。
 */
export async function hashToken(token: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', buf(new TextEncoder().encode(token)))
  return toHex(new Uint8Array(d))
}

/** 恒定时间比较，避免时序侧信道。 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
