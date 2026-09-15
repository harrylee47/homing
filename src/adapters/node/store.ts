/**
 * Node 适配层：SQLite 存储。
 *
 * 用内置 node:sqlite，不引入 better-sqlite3——省掉 ARM 上的原生编译。
 * SQL 限制在 D1 兼容子集（硬约束②）：无触发器、无自定义函数、无 ATTACH、
 * 检索用 LIKE 而非 FTS5。
 */
import { chmodSync, existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import type {
  ChannelRecord,
  DeviceRecord,
  EventQuery,
  InsertEventResult,
  OutboundRecord,
  MessageRefRecord,
  EventFilter,
  PairingCodeRecord,
  SessionRecord,
  TaskRecord,
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
  // 增量迁移：老库没有这一列。SQLite 没有 IF NOT EXISTS 形式的 ADD COLUMN，
  // 由 migrate() 捕获重复添加的错误
  `ALTER TABLE devices ADD COLUMN charging INTEGER`,
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
  `CREATE TABLE IF NOT EXISTS outbound (
     id          TEXT PRIMARY KEY,
     device_id   TEXT NOT NULL,
     to_number   TEXT NOT NULL,
     content_enc BLOB NOT NULL,
     sim_slot    INTEGER,
     status      TEXT NOT NULL DEFAULT 'pending',
     error       TEXT,
     created_at  INTEGER NOT NULL,
     updated_at  INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_outbound_time ON outbound(created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS settings (
     key   TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS sessions (
     token_hash TEXT PRIMARY KEY,
     ua_hash    TEXT NOT NULL,
     ip_prefix  TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL,
     revoked    INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at)`,
  `CREATE TABLE IF NOT EXISTS message_refs (
     channel_id TEXT NOT NULL,
     ref        TEXT NOT NULL,
     event_id   TEXT NOT NULL,
     sender     TEXT NOT NULL,
     device_id  TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (channel_id, ref)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_msgrefs_time ON message_refs(created_at)`,
  `CREATE TABLE IF NOT EXISTS tasks (
     id            TEXT PRIMARY KEY,
     name          TEXT NOT NULL,
     enabled       INTEGER NOT NULL DEFAULT 0,
     device_id     TEXT NOT NULL DEFAULT '',
     to_number     TEXT NOT NULL DEFAULT '',
     content_enc   BLOB NOT NULL,
     schedule_json TEXT NOT NULL,
     last_run_at   INTEGER,
     last_status   TEXT,
     fail_count    INTEGER NOT NULL DEFAULT 0,
     created_at    INTEGER NOT NULL
   )`,
]

/** 状态机的前进顺序。数字大者为更后的状态，用于拒绝倒退的回执。 */
const OUTBOUND_RANK: Record<string, number> = {
  pending: 0, accepted: 1, sent: 2, delivered: 3, failed: 4,
}

export class SqliteStore implements Store {
  private readonly db: DatabaseSync

  constructor(path: string) {
    this.db = new DatabaseSync(path)
    // 库里是全部短信（密文）与设备凭证哈希，同机其他用户不该能读（计划 §11.6）。
    // WAL 与 shm 同样包含数据页，一并收紧。
    for (const f of [path, `${path}-wal`, `${path}-shm`]) {
      if (existsSync(f)) {
        try { chmodSync(f, 0o600) } catch { /* 某些文件系统不支持，不致命 */ }
      }
    }
    // WAL 提升并发读性能；D1 侧无此概念，属适配层细节，不泄漏到 core
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA foreign_keys = ON')
  }

  async migrate(): Promise<void> {
    for (const sql of MIGRATIONS) {
      try {
        this.db.exec(sql)
      } catch (e) {
        // ALTER TABLE ADD COLUMN 在列已存在时报错，这是幂等迁移的正常路径；
        // 其余错误必须抛出，否则表结构不全会在运行时以更难懂的方式炸掉
        const msg = String(e)
        if (sql.startsWith('ALTER TABLE') && msg.includes('duplicate column')) continue
        throw e
      }
    }
  }

  async getDevice(id: string): Promise<DeviceRecord | null> {
    const row = this.db.prepare('SELECT * FROM devices WHERE id = ?').get(id)
    return row ? toDevice(row as unknown as RawDevice) : null
  }

  async listDevices(): Promise<DeviceRecord[]> {
    const rows = this.db.prepare('SELECT * FROM devices ORDER BY created_at').all() as unknown as RawDevice[]
    return rows.map(toDevice)
  }

  async createDevice(d: DeviceRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO devices (id, name, token_hash, status, last_seen_at, battery, charging, app_version, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(d.id, d.name, d.token_hash, d.status, d.last_seen_at, d.battery,
        d.charging === null ? null : d.charging ? 1 : 0, d.app_version, d.created_at)
  }

  async touchDevice(
    id: string,
    patch: Partial<Pick<DeviceRecord, 'status' | 'last_seen_at' | 'battery' | 'app_version'>>,
  ): Promise<void> {
    const cols = Object.keys(patch) as (keyof typeof patch)[]
    if (cols.length === 0) return
    const set = cols.map((c) => `${c} = ?`).join(', ')
    const vals = cols.map((c) => {
      const v = patch[c]
      // SQLite 没有布尔类型
      if (typeof v === 'boolean') return v ? 1 : 0
      return v as string | number | null
    })
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
    const { clause, args } = buildWhere(q)
    return this.db
      .prepare(`SELECT * FROM events ${clause} ORDER BY occurred_at DESC LIMIT ? OFFSET ?`)
      .all(...args, q.limit, q.offset) as unknown as StoredEvent[]
  }

  async countEvents(f: EventFilter): Promise<number> {
    const { clause, args } = buildWhere(f)
    const row = this.db.prepare(`SELECT COUNT(*) c FROM events ${clause}`).get(...args) as { c: number }
    return Number(row.c)
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

  // ── 发送任务 ──────────────────────────────────────────

  async createOutbound(o: OutboundRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO outbound (id, device_id, to_number, content_enc, sim_slot, status, error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(o.id, o.device_id, o.to_number, o.content_enc, o.sim_slot, o.status, o.error, o.created_at, o.updated_at)
  }

  async getOutbound(id: string): Promise<OutboundRecord | null> {
    const row = this.db.prepare('SELECT * FROM outbound WHERE id = ?').get(id)
    return row ? (row as unknown as OutboundRecord) : null
  }

  async listOutbound(limit: number, offset: number): Promise<OutboundRecord[]> {
    return this.db
      .prepare('SELECT * FROM outbound ORDER BY created_at DESC LIMIT ? OFFSET ?')
      .all(limit, offset) as unknown as OutboundRecord[]
  }

  /**
   * 只前进不后退：多段短信的 sent/delivered 回执顺序不保证，
   * 已经 delivered 的任务不能被后到的 sent 覆盖回去。
   * failed 是终态之外的例外——任何阶段失败都要能记录下来。
   */
  async advanceOutbound(id: string, status: OutboundRecord['status'], error: string | null, at: number): Promise<void> {
    const cur = this.db.prepare('SELECT status FROM outbound WHERE id = ?').get(id) as { status?: string } | undefined
    if (!cur?.status) return
    const from = OUTBOUND_RANK[cur.status] ?? 0
    const to = OUTBOUND_RANK[status] ?? 0
    if (status !== 'failed' && to <= from) return
    this.db
      .prepare('UPDATE outbound SET status = ?, error = ?, updated_at = ? WHERE id = ?')
      .run(status, error, at, id)
  }

  // ── 计划任务 ──────────────────────────────────────────

  async listTasks(): Promise<TaskRecord[]> {
    const rows = this.db.prepare('SELECT * FROM tasks ORDER BY created_at').all() as unknown as (Omit<TaskRecord, 'enabled'> & { enabled: number })[]
    return rows.map((r) => ({ ...r, enabled: r.enabled === 1 }))
  }

  async getTask(id: string): Promise<TaskRecord | null> {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as
      | (Omit<TaskRecord, 'enabled'> & { enabled: number }) | undefined
    return row ? { ...row, enabled: row.enabled === 1 } : null
  }

  async upsertTask(t: TaskRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO tasks (id, name, enabled, device_id, to_number, content_enc, schedule_json, last_run_at, last_status, fail_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, enabled=excluded.enabled,
           device_id=excluded.device_id, to_number=excluded.to_number,
           content_enc=excluded.content_enc, schedule_json=excluded.schedule_json`,
      )
      .run(t.id, t.name, t.enabled ? 1 : 0, t.device_id, t.to_number, t.content_enc,
        t.schedule_json, t.last_run_at, t.last_status, t.fail_count, t.created_at)
  }

  async deleteTask(id: string): Promise<void> {
    this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id)
  }

  async setTaskEnabled(id: string, enabled: boolean): Promise<void> {
    this.db.prepare('UPDATE tasks SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id)
  }

  async updateTaskRun(id: string, p: { last_run_at: number; last_status: 'ok' | 'failed'; fail_count: number }): Promise<void> {
    this.db
      .prepare('UPDATE tasks SET last_run_at = ?, last_status = ?, fail_count = ? WHERE id = ?')
      .run(p.last_run_at, p.last_status, p.fail_count, id)
  }

  // ── 推送消息映射 ──────────────────────────────────────

  async putMessageRef(r: MessageRefRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO message_refs (channel_id, ref, event_id, sender, device_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(channel_id, ref) DO UPDATE SET event_id=excluded.event_id, sender=excluded.sender`,
      )
      .run(r.channel_id, r.ref, r.event_id, r.sender, r.device_id, r.created_at)
  }

  async getMessageRef(channelId: string, ref: string): Promise<MessageRefRecord | null> {
    const row = this.db.prepare('SELECT * FROM message_refs WHERE channel_id = ? AND ref = ?').get(channelId, ref)
    return row ? (row as unknown as MessageRefRecord) : null
  }

  async cleanupMessageRefs(before: number): Promise<void> {
    this.db.prepare('DELETE FROM message_refs WHERE created_at < ?').run(before)
  }

  // ── 设置与会话 ────────────────────────────────────────

  async getSetting(key: string): Promise<string | null> {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value?: string } | undefined
    return row?.value ?? null
  }

  async setSetting(key: string, value: string): Promise<void> {
    this.db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value)
  }

  async createSession(s: SessionRecord): Promise<void> {
    this.db
      .prepare('INSERT INTO sessions (token_hash, ua_hash, ip_prefix, created_at, expires_at, revoked) VALUES (?, ?, ?, ?, ?, 0)')
      .run(s.token_hash, s.ua_hash, s.ip_prefix, s.created_at, s.expires_at)
  }

  async getSession(tokenHash: string): Promise<SessionRecord | null> {
    const row = this.db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(tokenHash) as
      | (Omit<SessionRecord, 'revoked'> & { revoked: number })
      | undefined
    return row ? { ...row, revoked: row.revoked === 1 } : null
  }

  async touchSession(tokenHash: string, expiresAt: number): Promise<void> {
    this.db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').run(expiresAt, tokenHash)
  }

  async revokeSession(tokenHash: string): Promise<void> {
    this.db.prepare('UPDATE sessions SET revoked = 1 WHERE token_hash = ?').run(tokenHash)
  }

  async revokeAllSessions(): Promise<void> {
    this.db.prepare('UPDATE sessions SET revoked = 1').run()
  }

  async cleanupSessions(now: number): Promise<void> {
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ? OR revoked = 1').run(now)
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


/** 只用索引列构造 WHERE。正文与号码是密文，SQL 搜不了。 */
function buildWhere(f: EventFilter): { clause: string; args: (string | number)[] } {
  const where: string[] = []
  const args: (string | number)[] = []
  if (f.kind) { where.push('kind = ?'); args.push(f.kind) }
  if (f.device_id) { where.push('device_id = ?'); args.push(f.device_id) }
  if (f.since !== undefined) { where.push('occurred_at >= ?'); args.push(f.since) }
  if (f.until !== undefined) { where.push('occurred_at <= ?'); args.push(f.until) }
  return { clause: where.length ? `WHERE ${where.join(' AND ')}` : '', args }
}

interface RawDevice extends Omit<DeviceRecord, 'charging'> { charging: number | null }
const toDevice = (r: RawDevice): DeviceRecord => ({
  ...r, charging: r.charging === null || r.charging === undefined ? null : r.charging === 1,
})
