/**
 * 设备配对（计划 §6.1）。
 *
 * 不使用静态永久 token：控制台生成一次性配对码（TTL 5 分钟），
 * Agent 用它换取长期凭证；凭证与配对码服务端都只存哈希。
 */
import { hashToken, timingSafeEqual } from './crypto.js'
import { log } from './logging.js'
import type { DeviceRecord, Store } from './store.js'

export const PAIRING_TTL_MS = 5 * 60 * 1000

/** 配对码用大写字母+数字，去掉容易混淆的 O/0/I/1，便于人工抄写。 */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const CODE_LEN = 8

export function generatePairingCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LEN))
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('')
}

/** 长期凭证：32 字节随机，base64url。 */
export function generateToken(): string {
  const b = crypto.getRandomValues(new Uint8Array(32))
  let bin = ''
  for (const x of b) bin += String.fromCharCode(x)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function newDeviceId(): string {
  return `dev_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`
}

export interface PairingResult {
  device_id: string
  token: string
  device_name: string
}

/** 控制台调用：生成配对码。返回明文，只显示这一次。 */
export async function createPairing(
  store: Store, userId: string, deviceName: string, now = Date.now(),
): Promise<{ code: string; expires_at: number }> {
  const code = generatePairingCode()
  const expires_at = now + PAIRING_TTL_MS
  await store.createPairingCode({
    // 配对码归属谁，兑换出来的设备就归属谁——设备是一切数据归属的源头
    user_id: userId,
    code_hash: await hashToken(code),
    device_name: deviceName,
    expires_at,
    used_at: null,
    created_at: now,
  })
  await store.audit({ user_id: userId, actor: 'console', action: 'pairing.create', detail: deviceName, ip: null, created_at: now })
  return { code, expires_at }
}

/**
 * Agent 调用：用配对码换取长期凭证。
 *
 * 失败一律返回 null 而不区分「码不存在 / 已用 / 过期」——
 * 这个接口是未认证可达的，区分原因等于给暴力枚举提供反馈。
 */
export async function redeemPairing(
  store: Store,
  code: string,
  now = Date.now(),
): Promise<PairingResult | null> {
  const hash = await hashToken(code.trim().toUpperCase())
  const record = await store.takePairingCode(hash, now)
  if (!record) {
    log.warn('配对码无效或已过期')
    return null
  }
  if (!timingSafeEqual(hash, record.code_hash)) return null

  const token = generateToken()
  const device: DeviceRecord = {
    id: newDeviceId(),
    user_id: record.user_id,
    name: record.device_name,
    token_hash: await hashToken(token),
    status: 'offline',
    last_seen_at: null,
    battery: null,
    charging: null,
    net_json: null,
    location_enc: null,
    location_at: null,
    app_version: null,
    created_at: now,
  }
  await store.createDevice(device)
  await store.audit({ user_id: device.user_id, actor: 'agent', action: 'pairing.redeem', detail: device.id, ip: null, created_at: now })
  log.info('设备配对成功', { device_id: device.id, name: device.name })

  return { device_id: device.id, token, device_name: device.name }
}
