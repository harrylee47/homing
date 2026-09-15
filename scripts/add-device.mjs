/**
 * 临时配对工具：直接往库里写一台设备并打印凭证。
 * M1 的扫码配对流程上线后即可删除。
 *
 *   node --experimental-strip-types scripts/add-device.mjs "JP-Gateway-01"
 */
import { DatabaseSync } from 'node:sqlite'
import { randomUUID, webcrypto as wc } from 'node:crypto'

const name = process.argv[2] ?? 'JP-Gateway-01'
const dbPath = process.env.GW_DB_PATH ?? './data/gateway.db'

const token = Buffer.from(wc.getRandomValues(new Uint8Array(32))).toString('base64url')
const digest = await wc.subtle.digest('SHA-256', new TextEncoder().encode(token))
const tokenHash = Buffer.from(digest).toString('hex')
const id = `dev_${randomUUID().replaceAll('-', '').slice(0, 16)}`

const db = new DatabaseSync(dbPath)
db.prepare(
  `INSERT INTO devices (id, name, token_hash, status, last_seen_at, battery, app_version, created_at)
   VALUES (?, ?, ?, 'offline', NULL, NULL, NULL, ?)`,
).run(id, name, tokenHash, Date.now())
db.close()

console.log(`设备已创建\n  device_id: ${id}\n  token:     ${token}\n\n凭证只显示这一次，服务端仅存哈希。`)
