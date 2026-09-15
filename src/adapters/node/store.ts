/**
 * Node 适配层：SQLite 存储。
 *
 * 用内置 node:sqlite，不引入 better-sqlite3——省掉 ARM 上的原生编译。
 * SQL 限制在 D1 兼容子集（硬约束②）：无触发器、无自定义函数、无 ATTACH、
 * 检索用 LIKE 而非 FTS5。
 */
import { DatabaseSync } from 'node:sqlite'
import type {
  DeviceRecord,
  EventQuery,
  InsertEventResult,
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

  async close(): Promise<void> {
    this.db.close()
  }
}
