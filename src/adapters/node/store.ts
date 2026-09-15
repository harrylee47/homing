/**
 * Node 适配层：SQLite 存储。
 *
 * 用内置 node:sqlite，不引入 better-sqlite3——省掉 ARM 上的原生编译。
 * SQL 限制在 D1 兼容子集（硬约束②）：无触发器、无自定义函数、无 ATTACH、
 * 检索用 LIKE 而非 FTS5。
 */
import { DatabaseSync } from 'node:sqlite'
import type {
  ChannelRecord,
  DeviceRecord,
  EventQuery,
  InsertEventResult,
  PairingCodeRecord,
  RuleRecord,
  Store,
  StoredEvent,
} from '../../core/store.js'

const MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS devices (
     id           TEXT PRIMARY KEY,
     name         TEXT NOT NULL,
     token_hash   TEXT NOT NULL,
     status       TEXT NOT NULL DEFAULT 'offline',
     last_seen_at INTEGER,
     battery      INTEGER,
     app_version  TEXT,
     created_at   INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS events (
     id            TEXT PRIMARY KEY,
     device_id     TEXT NOT NULL REFERENCES devices(id),
     kind          TEXT NOT NULL,
     sender_enc    BLOB NOT NULL,
     content_enc   BLOB NOT NULL,
     enc_ver       INTEGER NOT NULL DEFAULT 1,
     occurred_at   INTEGER NOT NULL,
     received_at   INTEGER NOT NULL,
     matched_rules TEXT,
     created_at    INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_events_time ON events(occurred_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind, occurred_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_events_device ON events(device_id, occurred_at DESC)`,
  `CREATE TABLE IF NOT EXISTS channels (
     id         TEXT PRIMARY KEY,
     type       TEXT NOT NULL,
     name       TEXT NOT NULL,
     config_enc BLOB NOT NULL,
     enabled    INTEGER NOT NULL DEFAULT 1,
     created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS rules (
     id          TEXT PRIMARY KEY,
     name        TEXT NOT NULL,
     priority    INTEGER NOT NULL DEFAULT 100,
     enabled     INTEGER NOT NULL DEFAULT 1,
     match_json  TEXT NOT NULL,
     action_json TEXT NOT NULL,
     created_at  INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_rules_priority ON rules(priority)`,
  `CREATE TABLE IF NOT EXISTS pairing_codes (
     code_hash   TEXT PRIMARY KEY,
     device_name TEXT NOT NULL,
     expires_at  INTEGER NOT NULL,
     used_at     INTEGER,
     created_at  INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS audit_log (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     actor      TEXT,
     action     TEXT NOT NULL,
     detail     TEXT,
     ip         TEXT,
     created_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_log(created_at DESC)`,
]

export class SqliteStore implements Store {
  private readonly db: DatabaseSync

  constructor(path: string) {
    this.db = new DatabaseSync(path)
    // WAL 提升并发读性能；D1 侧无此概念，属适配层细节，不泄漏到 core
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA foreign_keys = ON')
  }

  async migrate(): Promise<void> {
    for (const sql of MIGRATIONS) this.db.exec(sql)
  }

  async getDevice(id: string): Promise<DeviceRecord | null> {
    const row = this.db.prepare('SELECT * FROM devices WHERE id = ?').get(id)
    return row ? (row as unknown as DeviceRecord) : null
  }

  async listDevices(): Promise<DeviceRecord[]> {
    return this.db.prepare('SELECT * FROM devices ORDER BY created_at').all() as unknown as DeviceRecord[]
  }

  async createDevice(d: DeviceRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO devices (id, name, token_hash, status, last_seen_at, battery, app_version, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(d.id, d.name, d.token_hash, d.status, d.last_seen_at, d.battery, d.app_version, d.created_at)
  }

  async touchDevice(
    id: string,
    patch: Partial<Pick<DeviceRecord, 'status' | 'last_seen_at' | 'battery' | 'app_version'>>,
  ): Promise<void> {
    const cols = Object.keys(patch) as (keyof typeof patch)[]
    if (cols.length === 0) return
    const set = cols.map((c) => `${c} = ?`).join(', ')
    const vals = cols.map((c) => patch[c] as string | number | null)
    this.db.prepare(`UPDATE devices SET ${set} WHERE id = ?`).run(...vals, id)
  }

  async revokeDevice(id: string): Promise<void> {
    this.db.prepare(`UPDATE devices SET status = 'revoked' WHERE id = ?`).run(id)
  }

  /**
   * 幂等写入：INSERT OR IGNORE + changes 判断是否实际插入。
   * 这是断网补传不产生重复记录的唯一保证（计划 §5.4）。
   */
  async insertEvent(e: StoredEvent): Promise<InsertEventResult> {
    const r = this.db
      .prepare(
        `INSERT OR IGNORE INTO events
           (id, device_id, kind, sender_enc, content_enc, enc_ver, occurred_at, received_at, matched_rules, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        e.id, e.device_id, e.kind, e.sender_enc, e.content_enc,
        e.enc_ver, e.occurred_at, e.received_at, e.matched_rules, e.created_at,
      )
    return Number(r.changes) > 0 ? 'stored' : 'duplicate'
  }

  async getEvent(id: string): Promise<StoredEvent | null> {
    const row = this.db.prepare('SELECT * FROM events WHERE id = ?').get(id)
    return row ? (row as unknown as StoredEvent) : null
  }

  async listEvents(q: EventQuery): Promise<StoredEvent[]> {
    const where: string[] = []
    const args: (string | number)[] = []
    if (q.kind) { where.push('kind = ?'); args.push(q.kind) }
    if (q.device_id) { where.push('device_id = ?'); args.push(q.device_id) }
    if (q.since !== undefined) { where.push('occurred_at >= ?'); args.push(q.since) }
    if (q.until !== undefined) { where.push('occurred_at <= ?'); args.push(q.until) }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
    return this.db
      .prepare(`SELECT * FROM events ${clause} ORDER BY occurred_at DESC LIMIT ? OFFSET ?`)
      .all(...args, q.limit, q.offset) as unknown as StoredEvent[]
  }

  async setMatchedRules(eventId: string, ruleIds: string[]): Promise<void> {
    this.db.prepare('UPDATE events SET matched_rules = ? WHERE id = ?').run(JSON.stringify(ruleIds), eventId)
  }

  // ── 渠道 ──────────────────────────────────────────────

  async listChannels(): Promise<ChannelRecord[]> {
    const rows = this.db.prepare('SELECT * FROM channels ORDER BY created_at').all() as unknown as RawChannel[]
    return rows.map(toChannel)
  }

  async getChannel(id: string): Promise<ChannelRecord | null> {
    const row = this.db.prepare('SELECT * FROM channels WHERE id = ?').get(id) as unknown as RawChannel | undefined
    return row ? toChannel(row) : null
  }

  async upsertChannel(c: ChannelRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO channels (id, type, name, config_enc, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET type=excluded.type, name=excluded.name,
           config_enc=excluded.config_enc, enabled=excluded.enabled`,
      )
      .run(c.id, c.type, c.name, c.config_enc, c.enabled ? 1 : 0, c.created_at)
  }

  async deleteChannel(id: string): Promise<void> {
    this.db.prepare('DELETE FROM channels WHERE id = ?').run(id)
  }

  // ── 规则 ──────────────────────────────────────────────

  async listRules(): Promise<RuleRecord[]> {
    const rows = this.db.prepare('SELECT * FROM rules ORDER BY priority, id').all() as unknown as RawRule[]
    return rows.map((r) => ({ ...r, enabled: r.enabled === 1 }))
  }

  async upsertRule(r: RuleRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO rules (id, name, priority, enabled, match_json, action_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, priority=excluded.priority,
           enabled=excluded.enabled, match_json=excluded.match_json, action_json=excluded.action_json`,
      )
      .run(r.id, r.name, r.priority, r.enabled ? 1 : 0, r.match_json, r.action_json, r.created_at)
  }

  async deleteRule(id: string): Promise<void> {
    this.db.prepare('DELETE FROM rules WHERE id = ?').run(id)
  }

  // ── 配对码 ────────────────────────────────────────────

  async createPairingCode(p: PairingCodeRecord): Promise<void> {
    this.db
      .prepare('INSERT INTO pairing_codes (code_hash, device_name, expires_at, used_at, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(p.code_hash, p.device_name, p.expires_at, p.used_at, p.created_at)
  }

  /**
   * 取用配对码：UPDATE...WHERE used_at IS NULL 的 changes 数决定是否取用成功，
   * 这样并发请求下只有一个能成功，不需要额外加锁。
   */
  async takePairingCode(codeHash: string, now: number): Promise<PairingCodeRecord | null> {
    const r = this.db
      .prepare('UPDATE pairing_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?')
      .run(now, codeHash, now)
    if (Number(r.changes) === 0) return null
    const row = this.db.prepare('SELECT * FROM pairing_codes WHERE code_hash = ?').get(codeHash)
    return (row as unknown as PairingCodeRecord) ?? null
  }

  // ── 审计 ──────────────────────────────────────────────

  async audit(e: { actor: string | null; action: string; detail: string | null; ip: string | null; created_at: number }): Promise<void> {
    this.db
      .prepare('INSERT INTO audit_log (actor, action, detail, ip, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(e.actor, e.action, e.detail, e.ip, e.created_at)
  }

  async close(): Promise<void> {
    this.db.close()
  }
}


// SQLite 没有布尔类型，存的是 0/1，出库时统一转换
interface RawChannel extends Omit<ChannelRecord, 'enabled'> { enabled: number }
interface RawRule extends Omit<RuleRecord, 'enabled'> { enabled: number }

const toChannel = (r: RawChannel): ChannelRecord => ({ ...r, enabled: r.enabled === 1 })
