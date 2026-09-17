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
  DeviceLogRecord,
  DeviceRecord,
  EventQuery,
  InsertEventResult,
  OutboundFilter,
  OutboundRecord,
  MessageRefRecord,
  EventFilter,
  PairingCodeRecord,
  InviteRecord,
  SessionRecord,
  TaskRecord,
  UserRecord,
  RuleRecord,
  Store,
  StoredEvent,
} from '../../core/store.js'

const MIGRATIONS: string[] = [
  // ── 多用户 ──────────────────────────────────────────────
  // 每个用户一套完全独立的数据。管理员的特权只有建号删号，
  // 管理员在控制台里读不到别人的消息，但他能重置口令从而以对方身份登录——
  // 「不会顺手看到」不等于「拿不到」，面向用户的文案要按后者写
  `CREATE TABLE IF NOT EXISTS users (
     id            TEXT PRIMARY KEY,
     name          TEXT NOT NULL,
     password_hash TEXT NOT NULL,
     totp_secret   TEXT NOT NULL,
     role          TEXT NOT NULL DEFAULT 'member',
     bot_token     TEXT NOT NULL DEFAULT '',
     disabled      INTEGER NOT NULL DEFAULT 0,
     created_at    INTEGER NOT NULL
   )`,
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
  // 按用户的配置。与全局 settings 分开建表而不是给它加一列：
  // 全局表的主键就是 key，SQLite 改不了主键，而这两类配置的语义本来就不同
  `CREATE TABLE IF NOT EXISTS user_settings (
     user_id TEXT NOT NULL,
     key     TEXT NOT NULL,
     value   TEXT NOT NULL,
     PRIMARY KEY (user_id, key)
   )`,
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
  `CREATE TABLE IF NOT EXISTS message_refs (
     channel_id TEXT NOT NULL,
     ref        TEXT NOT NULL,
     event_id   TEXT NOT NULL,
     sender     TEXT NOT NULL,
     device_id  TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (channel_id, ref)
   )`,
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

  /**
   * 设备连接日志。
   *
   * 只存结构化字段（level / event / detail），不含任何用户内容——
   * 它会经控制台展示给人看，脱敏标准与日志输出相同。
   *
   * 带 user_id 是为了让查询能按作用域过滤：device_id 虽然已经蕴含归属，
   * 但按 CLAUDE.md 那条「作用域是类型强制的」，查询要能自己带上它。
   */
  `CREATE TABLE IF NOT EXISTS device_logs (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     device_id  TEXT NOT NULL,
     user_id    TEXT NOT NULL,
     level      TEXT NOT NULL,
     event      TEXT NOT NULL,
     detail     TEXT,
     created_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_device_logs_dev ON device_logs(device_id, created_at DESC)`,

  // ── 增量迁移 ──────────────────────────────────────────
  // 全部放在建表之后：SQLite 没有 IF NOT EXISTS 形式的 ADD COLUMN，
  // 而 ALTER 排在对应的 CREATE 之前时，全新库上会直接报「no such table」——
  // 这条崩的是**新装**而不是升级，测不出来，装的人只看到容器起不来
  // 增量迁移：老库没有这一列。SQLite 没有 IF NOT EXISTS 形式的 ADD COLUMN，
  // 由 migrate() 捕获重复添加的错误
  `ALTER TABLE devices ADD COLUMN charging INTEGER`,
  `ALTER TABLE devices ADD COLUMN location_enc BLOB`,
  `ALTER TABLE devices ADD COLUMN location_at INTEGER`,
  `ALTER TABLE events ADD COLUMN direction TEXT`,
  // 双卡：这条是哪张卡收到的。不建索引——它只用于展示与规则匹配，
  // 而规则匹配发生在内存里（正文本来就是密文，一样要逐条过）
  `ALTER TABLE events ADD COLUMN sim_slot INTEGER`,
  `ALTER TABLE devices ADD COLUMN net_json TEXT`,
  `ALTER TABLE sessions ADD COLUMN trusted INTEGER NOT NULL DEFAULT 0`,
  // 回复要用原消息那张卡，不只是原设备
  `ALTER TABLE message_refs ADD COLUMN sim_slot INTEGER`,

  // 归属列。老库里这一列为空，由 main.ts 的 backfillOwner 一次性认领给首个管理员
  `ALTER TABLE devices ADD COLUMN user_id TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE events ADD COLUMN user_id TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE channels ADD COLUMN user_id TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE rules ADD COLUMN user_id TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE tasks ADD COLUMN user_id TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE outbound ADD COLUMN user_id TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE sessions ADD COLUMN user_id TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE message_refs ADD COLUMN user_id TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE pairing_codes ADD COLUMN user_id TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE audit_log ADD COLUMN user_id TEXT`,
  `ALTER TABLE users ADD COLUMN expires_at INTEGER`,
  `ALTER TABLE users ADD COLUMN agreed_version TEXT`,
  `ALTER TABLE users ADD COLUMN agreed_at INTEGER`,
  // 保号是按卡的事：双卡机上两张卡各自都要定期产生使用记录
  `ALTER TABLE tasks ADD COLUMN sim_slot INTEGER`,

  `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_name ON users(LOWER(name))`,
  // 邀请码。语义等同配对码：在有效期内拿到码就能开一个能看银行验证码的账号，
  // 所以同样只存哈希、同样用「取出即标记已用」保证并发下只能兑一次
  `CREATE TABLE IF NOT EXISTS invites (
     code_hash  TEXT PRIMARY KEY,
     created_by TEXT NOT NULL,
     note       TEXT,
     valid_days INTEGER,
     expires_at INTEGER NOT NULL,
     used_at    INTEGER,
     used_by    TEXT,
     created_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_events_time ON events(occurred_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind, occurred_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_events_device ON events(device_id, occurred_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_rules_priority ON rules(priority)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_log(created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_outbound_time ON outbound(created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at)`,
  `CREATE INDEX IF NOT EXISTS idx_msgrefs_time ON message_refs(created_at)`,
  // 每一次列表查询都带 user_id，索引跟上
  `CREATE INDEX IF NOT EXISTS idx_events_user ON events(user_id, occurred_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_outbound_user ON outbound(user_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id)`,
]

/** 状态机的前进顺序。数字大者为更后的状态，用于拒绝倒退的回执。 */
const OUTBOUND_RANK: Record<string, number> = {
  pending: 0, accepted: 1, sent: 2, delivered: 3, failed: 4,
}

/**
 * 发送记录的 WHERE 拼装。收件人是明文列，模糊匹配用 LIKE——号码里不会出现
 * % 与 _ 之外的通配语义，但仍要转义，否则用户输入 % 会变成「查全部」。
 */
function outboundWhere(f: OutboundFilter): { where: string; args: (string | number)[] } {
  // 同 buildWhere：作用域条件永远在第一位
  const parts: string[] = ['user_id = ?']
  const args: (string | number)[] = [f.user_id]
  if (f?.device_id) { parts.push('device_id = ?'); args.push(f.device_id) }
  if (f?.status) { parts.push('status = ?'); args.push(f.status) }
  if (f?.to) {
    parts.push("to_number LIKE ? ESCAPE '\\'")
    args.push(`%${f.to.replace(/[\\%_]/g, (c) => `\\${c}`)}%`)
  }
  return { where: parts.length ? `WHERE ${parts.join(' AND ')}` : '', args }
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

  // ── 用户 ──────────────────────────────────────────────

  async listUsers(): Promise<UserRecord[]> {
    const rows = this.db.prepare('SELECT * FROM users ORDER BY created_at').all() as unknown as RawUser[]
    return rows.map(toUser)
  }

  async getUser(id: string): Promise<UserRecord | null> {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id)
    return row ? toUser(row as unknown as RawUser) : null
  }

  async getUserByName(name: string): Promise<UserRecord | null> {
    const row = this.db.prepare('SELECT * FROM users WHERE LOWER(name) = LOWER(?)').get(name)
    return row ? toUser(row as unknown as RawUser) : null
  }

  async getUserByBotToken(token: string): Promise<UserRecord | null> {
    if (!token) return null
    const row = this.db.prepare('SELECT * FROM users WHERE bot_token = ?').get(token)
    return row ? toUser(row as unknown as RawUser) : null
  }

  async upsertUser(u: UserRecord): Promise<void> {
    this.db
      .prepare(
        // SET 是手写列清单：加了列忘了加进这里，表现是「停用再启用，有效期被重置」
        // ——不报错，几天后才发现
        `INSERT INTO users (id, name, password_hash, totp_secret, role, bot_token, disabled,
                            expires_at, agreed_version, agreed_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, password_hash=excluded.password_hash,
           totp_secret=excluded.totp_secret, role=excluded.role, bot_token=excluded.bot_token,
           disabled=excluded.disabled, expires_at=excluded.expires_at,
           agreed_version=excluded.agreed_version, agreed_at=excluded.agreed_at`,
      )
      .run(u.id, u.name, u.password_hash, u.totp_secret, u.role, u.bot_token, u.disabled ? 1 : 0,
        u.expires_at, u.agreed_version, u.agreed_at, u.created_at)
  }

  /**
   * 删号连数据一起删。
   *
   * 留着数据不删的话，下一个同名用户会继承上一个人的短信——
   * 而「删了账号但消息还在库里」本身就违背了多用户的初衷。
   */
  async deleteUser(id: string): Promise<Record<string, number>> {
    const n: Record<string, number> = {}
    for (const t of ['events', 'outbound', 'message_refs', 'tasks', 'rules', 'channels', 'devices', 'pairing_codes', 'sessions', 'user_settings']) {
      n[t] = Number(this.db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).run(id).changes)
    }
    this.db.prepare('DELETE FROM users WHERE id = ?').run(id)
    return n
  }

  async getDevice(id: string): Promise<DeviceRecord | null> {
    const row = this.db.prepare('SELECT * FROM devices WHERE id = ?').get(id)
    return row ? toDevice(row as unknown as RawDevice) : null
  }

  async listDevices(userId: string): Promise<DeviceRecord[]> {
    const rows = this.db.prepare('SELECT * FROM devices WHERE user_id = ? ORDER BY created_at')
      .all(userId) as unknown as RawDevice[]
    return rows.map(toDevice)
  }

  async listAllDevices(): Promise<DeviceRecord[]> {
    const rows = this.db.prepare('SELECT * FROM devices ORDER BY created_at').all() as unknown as RawDevice[]
    return rows.map(toDevice)
  }

  async createDevice(d: DeviceRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO devices (id, user_id, name, token_hash, status, last_seen_at, battery, charging, app_version, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(d.id, d.user_id, d.name, d.token_hash, d.status, d.last_seen_at, d.battery,
        d.charging === null ? null : d.charging ? 1 : 0, d.app_version, d.created_at)
    // location_* 由 setDeviceLocation 写入，创建时留空
  }

  async touchDevice(
    id: string,
    patch: Partial<Pick<DeviceRecord, 'status' | 'last_seen_at' | 'battery' | 'app_version' | 'net_json'>>,
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
    // 吊销是终态：断线时写入的 status='offline' 不能把它改回去（见 revokeDevice）
    this.db.prepare(`UPDATE devices SET ${set} WHERE id = ? AND status != 'revoked'`).run(...vals, id)
  }

  async deleteDevice(id: string, userId: string): Promise<boolean> {
    return Number(this.db.prepare('DELETE FROM devices WHERE id = ? AND user_id = ?')
      .run(id, userId).changes) > 0
  }

  async deleteOutboundByDevice(deviceId: string, userId: string): Promise<number> {
    return Number(this.db.prepare('DELETE FROM outbound WHERE device_id = ? AND user_id = ?')
      .run(deviceId, userId).changes)
  }

  /**
   * 吊销设备。
   *
   * **必须同时作废凭证**。只改状态的话有一条完整的绕回路径：
   * 吊销 → 服务端踢掉连接 → Agent 的 onDisconnect 走 touchDevice({status:'offline'})
   * 把 revoked 覆盖掉 → Agent 拿着原来的 token 重连 → 握手时看到的状态是 offline
   * → 验证通过，设备又活了。
   *
   * 也就是说，吊销恰好在「设备在线」这个最要紧的场景下无效——而手机丢了要紧急
   * 吊销时，它多半正在线。
   */
  async revokeDevice(id: string, userId: string): Promise<void> {
    this.db.prepare(`UPDATE devices SET status = 'revoked', token_hash = '' WHERE id = ? AND user_id = ?`)
      .run(id, userId)
  }

  /**
   * 幂等写入：INSERT OR IGNORE + changes 判断是否实际插入。
   * 这是断网补传不产生重复记录的唯一保证（计划 §5.4）。
   */
  async insertEvent(e: StoredEvent): Promise<InsertEventResult> {
    const r = this.db
      .prepare(
        `INSERT OR IGNORE INTO events
           (id, user_id, device_id, kind, direction, sim_slot, sender_enc, content_enc, enc_ver, occurred_at, received_at, matched_rules, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        e.id, e.user_id, e.device_id, e.kind, e.direction, e.sim_slot, e.sender_enc, e.content_enc,
        e.enc_ver, e.occurred_at, e.received_at, e.matched_rules, e.created_at,
      )
    return Number(r.changes) > 0 ? 'stored' : 'duplicate'
  }

  async getEvent(id: string, userId: string): Promise<StoredEvent | null> {
    const row = this.db.prepare('SELECT * FROM events WHERE id = ? AND user_id = ?').get(id, userId)
    return row ? ({ sim_slot: null, ...(row as object) } as unknown as StoredEvent) : null
  }

  async listEvents(q: EventQuery): Promise<StoredEvent[]> {
    const { clause, args } = buildWhere(q)
    return this.db
      // id 做次序补充：occurred_at 相同时 SQLite 不保证稳定顺序，
      // 翻页就会出现「同一条出现两次、另一条从没出现」
      .prepare(`SELECT * FROM events ${clause} ORDER BY occurred_at DESC, id DESC LIMIT ? OFFSET ?`)
      .all(...args, q.limit, q.offset) as unknown as StoredEvent[]
  }

  async countEvents(f: EventFilter): Promise<number> {
    const { clause, args } = buildWhere(f)
    const row = this.db.prepare(`SELECT COUNT(*) c FROM events ${clause}`).get(...args) as { c: number }
    return Number(row.c)
  }

  async deleteEvent(id: string, userId: string): Promise<boolean> {
    // user_id 必须进 SQL。签名带了参数、类型检查通过、实现却没用上——
    // 这正是 CLAUDE.md 那条「作用域是类型强制的」防不住的形状，
    // 所以同目录的每个 delete 都要照着 deleteOutbound 的写法核一遍
    const r = this.db.prepare('DELETE FROM events WHERE id = ? AND user_id = ?').run(id, userId)
    return Number(r.changes) > 0
  }

  async deleteEvents(f: EventFilter): Promise<number> {
    const { clause, args } = buildWhere(f)
    // 没有任何条件时 clause 为空 —— 那是「清空全部」，调用方必须自己确认过
    const r = this.db.prepare(`DELETE FROM events ${clause}`).run(...args)
    return Number(r.changes)
  }

  async setMatchedRules(eventId: string, ruleIds: string[]): Promise<void> {
    this.db.prepare('UPDATE events SET matched_rules = ? WHERE id = ?').run(JSON.stringify(ruleIds), eventId)
  }

  // ── 渠道 ──────────────────────────────────────────────

  async listAllChannels(): Promise<ChannelRecord[]> {
    const rows = this.db.prepare('SELECT * FROM channels ORDER BY created_at').all() as unknown as RawChannel[]
    return rows.map(toChannel)
  }

  async listChannels(userId: string): Promise<ChannelRecord[]> {
    const rows = this.db.prepare('SELECT * FROM channels WHERE user_id = ? ORDER BY created_at')
      .all(userId) as unknown as RawChannel[]
    return rows.map(toChannel)
  }

  async getChannel(id: string, userId: string): Promise<ChannelRecord | null> {
    const row = this.db.prepare('SELECT * FROM channels WHERE id = ? AND user_id = ?')
      .get(id, userId) as unknown as RawChannel | undefined
    return row ? toChannel(row) : null
  }

  async upsertChannel(c: ChannelRecord): Promise<void> {
    this.db
      .prepare(
        // 归属列必须写：漏了它，新建的渠道 user_id 是空串，
        // 列表里查不到（作用域按 user_id 过滤），推送也永远发不出去
        `INSERT INTO channels (id, user_id, type, name, config_enc, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET type=excluded.type, name=excluded.name,
           config_enc=excluded.config_enc, enabled=excluded.enabled, user_id=excluded.user_id`,
      )
      .run(c.id, c.user_id, c.type, c.name, c.config_enc, c.enabled ? 1 : 0, c.created_at)
  }

  async deleteChannel(id: string, userId: string): Promise<void> {
    this.db.prepare('DELETE FROM channels WHERE id = ? AND user_id = ?').run(id, userId)
  }

  // ── 规则 ──────────────────────────────────────────────

  async listRules(userId: string): Promise<RuleRecord[]> {
    const rows = this.db.prepare('SELECT * FROM rules WHERE user_id = ? ORDER BY priority, id')
      .all(userId) as unknown as RawRule[]
    return rows.map((r) => ({ ...r, enabled: r.enabled === 1 }))
  }

  async upsertRule(r: RuleRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO rules (id, user_id, name, priority, enabled, match_json, action_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, priority=excluded.priority,
           enabled=excluded.enabled, match_json=excluded.match_json,
           action_json=excluded.action_json, user_id=excluded.user_id`,
      )
      .run(r.id, r.user_id, r.name, r.priority, r.enabled ? 1 : 0, r.match_json, r.action_json, r.created_at)
  }

  async deleteRule(id: string, userId: string): Promise<void> {
    this.db.prepare('DELETE FROM rules WHERE id = ? AND user_id = ?').run(id, userId)
  }

  // ── 邀请码 ────────────────────────────────────────────

  async listInvites(): Promise<InviteRecord[]> {
    return this.db.prepare('SELECT * FROM invites ORDER BY created_at DESC')
      .all() as unknown as InviteRecord[]
  }

  async createInvite(i: InviteRecord): Promise<void> {
    this.db
      .prepare(`INSERT INTO invites (code_hash, created_by, note, valid_days, expires_at, used_at, used_by, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(i.code_hash, i.created_by, i.note, i.valid_days, i.expires_at, i.used_at, i.used_by, i.created_at)
  }

  async peekInvite(codeHash: string, now: number): Promise<InviteRecord | null> {
    const row = this.db
      .prepare('SELECT * FROM invites WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?')
      .get(codeHash, now)
    return row ? (row as unknown as InviteRecord) : null
  }

  /**
   * 取用邀请码。
   *
   * 照抄 takePairingCode 的写法：UPDATE ... WHERE used_at IS NULL 的 changes
   * 决定是否取用成功，这样并发请求下只有一个能成功，不需要额外加锁。
   * 分成「先查再更新」两步的话，两个人同时用同一个码能开出两个账号。
   */
  async takeInvite(codeHash: string, userId: string, now: number): Promise<InviteRecord | null> {
    const r = this.db
      .prepare(`UPDATE invites SET used_at = ?, used_by = ?
                WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?`)
      .run(now, userId, codeHash, now)
    if (Number(r.changes) === 0) return null
    return this.db.prepare('SELECT * FROM invites WHERE code_hash = ?')
      .get(codeHash) as unknown as InviteRecord
  }

  async deleteInvite(codeHash: string): Promise<boolean> {
    return Number(this.db.prepare('DELETE FROM invites WHERE code_hash = ? AND used_at IS NULL')
      .run(codeHash).changes) > 0
  }

  // ── 配对码 ────────────────────────────────────────────

  async createPairingCode(p: PairingCodeRecord): Promise<void> {
    this.db
      .prepare('INSERT INTO pairing_codes (code_hash, user_id, device_name, expires_at, used_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(p.code_hash, p.user_id, p.device_name, p.expires_at, p.used_at, p.created_at)
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
        `INSERT INTO outbound (id, user_id, device_id, to_number, content_enc, sim_slot, status, error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(o.id, o.user_id, o.device_id, o.to_number, o.content_enc, o.sim_slot, o.status, o.error, o.created_at, o.updated_at)
  }

  async getOutbound(id: string, userId: string): Promise<OutboundRecord | null> {
    const row = this.db.prepare('SELECT * FROM outbound WHERE id = ? AND user_id = ?').get(id, userId)
    return row ? (row as unknown as OutboundRecord) : null
  }

  async listOutbound(limit: number, offset: number, filter: OutboundFilter): Promise<OutboundRecord[]> {
    const { where, args } = outboundWhere(filter)
    return this.db
      .prepare(`SELECT * FROM outbound ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
      .all(...args, limit, offset) as unknown as OutboundRecord[]
  }

  async deleteOutbound(id: string, userId: string): Promise<boolean> {
    return Number(this.db.prepare('DELETE FROM outbound WHERE id = ? AND user_id = ?')
      .run(id, userId).changes) > 0
  }

  async countOutbound(filter: OutboundFilter): Promise<number> {
    const { where, args } = outboundWhere(filter)
    const r = this.db.prepare(`SELECT COUNT(*) AS n FROM outbound ${where}`).get(...args) as { n: number }
    return r.n
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

  async listTasks(userId: string): Promise<TaskRecord[]> {
    const rows = this.db.prepare('SELECT * FROM tasks WHERE user_id = ? ORDER BY created_at')
      .all(userId) as unknown as (Omit<TaskRecord, 'enabled'> & { enabled: number })[]
    return rows.map((r) => ({ ...r, enabled: r.enabled === 1, sim_slot: r.sim_slot ?? null }))
  }

  async listAllTasks(): Promise<TaskRecord[]> {
    const rows = this.db.prepare('SELECT * FROM tasks ORDER BY created_at').all() as unknown as (Omit<TaskRecord, 'enabled'> & { enabled: number })[]
    return rows.map((r) => ({ ...r, enabled: r.enabled === 1, sim_slot: r.sim_slot ?? null }))
  }

  async getTask(id: string, userId: string): Promise<TaskRecord | null> {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').get(id, userId) as
      | (Omit<TaskRecord, 'enabled'> & { enabled: number }) | undefined
    return row ? { ...row, enabled: row.enabled === 1, sim_slot: row.sim_slot ?? null } : null
  }

  async upsertTask(t: TaskRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO tasks (id, user_id, name, enabled, device_id, to_number, content_enc, sim_slot, schedule_json, last_run_at, last_status, fail_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, enabled=excluded.enabled,
           device_id=excluded.device_id, to_number=excluded.to_number,
           content_enc=excluded.content_enc, sim_slot=excluded.sim_slot,
           schedule_json=excluded.schedule_json, user_id=excluded.user_id`,
      )
      .run(t.id, t.user_id, t.name, t.enabled ? 1 : 0, t.device_id, t.to_number, t.content_enc, t.sim_slot,
        t.schedule_json, t.last_run_at, t.last_status, t.fail_count, t.created_at)
  }

  async deleteTask(id: string, userId: string): Promise<void> {
    this.db.prepare('DELETE FROM tasks WHERE id = ? AND user_id = ?').run(id, userId)
  }

  async setDeviceLocation(id: string, enc: Uint8Array, at: number): Promise<void> {
    this.db.prepare('UPDATE devices SET location_enc = ?, location_at = ? WHERE id = ?').run(enc, at, id)
  }

  async setTaskEnabled(id: string, userId: string, enabled: boolean): Promise<void> {
    this.db.prepare('UPDATE tasks SET enabled = ? WHERE id = ? AND user_id = ?').run(enabled ? 1 : 0, id, userId)
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
        `INSERT INTO message_refs (channel_id, ref, event_id, user_id, sender, device_id, sim_slot, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(channel_id, ref) DO UPDATE SET event_id=excluded.event_id,
           sender=excluded.sender, sim_slot=excluded.sim_slot, user_id=excluded.user_id`,
      )
      .run(r.channel_id, r.ref, r.event_id, r.user_id, r.sender, r.device_id, r.sim_slot, r.created_at)
  }

  async getMessageRef(channelId: string, ref: string): Promise<MessageRefRecord | null> {
    const row = this.db.prepare('SELECT * FROM message_refs WHERE channel_id = ? AND ref = ?').get(channelId, ref)
    return row ? ({ sim_slot: null, ...(row as object) } as unknown as MessageRefRecord) : null
  }

  async cleanupMessageRefs(before: number): Promise<void> {
    this.db.prepare('DELETE FROM message_refs WHERE created_at < ?').run(before)
  }

  // ── 设置与会话 ────────────────────────────────────────

  async listUserSettings(userId: string): Promise<Record<string, string>> {
    const rows = this.db.prepare('SELECT key, value FROM user_settings WHERE user_id = ?')
      .all(userId) as unknown as { key: string; value: string }[]
    return Object.fromEntries(rows.map((r) => [r.key, r.value]))
  }

  async appendDeviceLog(r: DeviceLogRecord): Promise<void> {
    this.db.prepare(
      'INSERT INTO device_logs (device_id, user_id, level, event, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(r.device_id, r.user_id, r.level, r.event, r.detail, r.created_at)
  }

  async listDeviceLogs(deviceId: string, userId: string, limit: number): Promise<DeviceLogRecord[]> {
    return this.db.prepare(
      'SELECT device_id, user_id, level, event, detail, created_at FROM device_logs'
      + ' WHERE device_id = ? AND user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?',
    ).all(deviceId, userId, limit) as unknown as DeviceLogRecord[]
  }

  async cleanupDeviceLogs(before: number): Promise<void> {
    this.db.prepare('DELETE FROM device_logs WHERE created_at < ?').run(before)
  }

  async getUserSetting(userId: string, key: string): Promise<string | null> {
    const row = this.db.prepare('SELECT value FROM user_settings WHERE user_id = ? AND key = ?')
      .get(userId, key) as { value: string } | undefined
    return row?.value ?? null
  }

  async setUserSetting(userId: string, key: string, value: string): Promise<void> {
    this.db
      .prepare(`INSERT INTO user_settings (user_id, key, value) VALUES (?, ?, ?)
                ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`)
      .run(userId, key, value)
  }

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
      .prepare('INSERT INTO sessions (token_hash, user_id, ua_hash, ip_prefix, created_at, expires_at, revoked, trusted) VALUES (?, ?, ?, ?, ?, ?, 0, ?)')
      .run(s.token_hash, s.user_id, s.ua_hash, s.ip_prefix, s.created_at, s.expires_at, s.trusted ? 1 : 0)
  }

  async getSession(tokenHash: string): Promise<SessionRecord | null> {
    const row = this.db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(tokenHash) as
      | (Omit<SessionRecord, 'revoked' | 'trusted'> & { revoked: number; trusted: number })
      | undefined
    return row ? { ...row, revoked: row.revoked === 1, trusted: row.trusted === 1 } : null
  }

  async touchSession(tokenHash: string, expiresAt: number): Promise<void> {
    this.db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').run(expiresAt, tokenHash)
  }

  async revokeSession(tokenHash: string): Promise<void> {
    this.db.prepare('UPDATE sessions SET revoked = 1 WHERE token_hash = ?').run(tokenHash)
  }

  async revokeAllSessions(userId: string): Promise<void> {
    this.db.prepare('UPDATE sessions SET revoked = 1 WHERE user_id = ?').run(userId)
  }

  async cleanupSessions(now: number): Promise<void> {
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ? OR revoked = 1').run(now)
  }

  // ── 审计 ──────────────────────────────────────────────

  async audit(e: { user_id?: string | null; actor: string | null; action: string; detail: string | null; ip: string | null; created_at: number }): Promise<void> {
    this.db
      .prepare('INSERT INTO audit_log (user_id, actor, action, detail, ip, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(e.user_id ?? null, e.actor, e.action, e.detail, e.ip, e.created_at)
  }

  /**
   * 把老库里没有归属的数据认领给第一个管理员。
   *
   * 多用户之前，所有数据都只属于「那个人」。升级时不认领的话，
   * 他打开控制台会看到空空如也——设备、规则、几千条历史消息全在库里，
   * 只是 user_id 是空串，谁都查不到。
   *
   * 只认领空串：已经有主的数据一律不动。
   */
  async claimOrphans(userId: string): Promise<Record<string, number>> {
    const n: Record<string, number> = {}
    for (const t of ['devices', 'events', 'channels', 'rules', 'tasks', 'outbound', 'message_refs', 'pairing_codes']) {
      n[t] = Number(this.db.prepare(`UPDATE ${t} SET user_id = ? WHERE user_id = '' OR user_id IS NULL`).run(userId).changes)
    }
    // 老库里这几项是全局的，语义上本来就属于「那个人」，一并搬过去。
    // 不搬的话升级后他的时区、短信指令口令、通知捕获范围会静默回到默认值
    for (const k of ['timezone', 'sms_command', 'notification_capture', 'battery_alerts']) {
      const v = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(k) as { value: string } | undefined
      if (v) {
        this.db.prepare(`INSERT INTO user_settings (user_id, key, value) VALUES (?, ?, ?)
                         ON CONFLICT(user_id, key) DO NOTHING`).run(userId, k, v.value)
        n[`setting:${k}`] = 1
      }
    }
    // 会话不认领：让升级后所有人重新登录一次，顺便把「谁是谁」重新确认一遍
    this.db.prepare(`DELETE FROM sessions WHERE user_id = '' OR user_id IS NULL`).run()
    return n
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
  // user_id 永远在第一个条件上。它不是可选项——多用户下漏掉它，
  // 就是把别人的银行验证码摆到你眼前
  const where: string[] = ['user_id = ?']
  const args: (string | number)[] = [f.user_id]
  if (f.kind) { where.push('kind = ?'); args.push(f.kind) }
  if (f.device_id) { where.push('device_id = ?'); args.push(f.device_id) }
  // 升级前入库的记录 direction 为 NULL，语义上就是「收到的」
  if (f.direction === 'in') where.push("(direction = 'in' OR direction IS NULL)")
  else if (f.direction === 'out') where.push("direction = 'out'")
  if (f.since !== undefined) { where.push('occurred_at >= ?'); args.push(f.since) }
  if (f.until !== undefined) { where.push('occurred_at <= ?'); args.push(f.until) }
  return { clause: where.length ? `WHERE ${where.join(' AND ')}` : '', args }
}

interface RawUser extends Omit<UserRecord, 'disabled'> { disabled: number }
const toUser = (r: RawUser): UserRecord => ({
  ...r,
  disabled: r.disabled === 1,
  // 老库升级后这三列是 undefined 而不是 null，透传出去会让 `== null` 之外的判断出错
  expires_at: r.expires_at ?? null,
  agreed_version: r.agreed_version ?? null,
  agreed_at: r.agreed_at ?? null,
})

interface RawDevice extends Omit<DeviceRecord, 'charging'> { charging: number | null }
const toDevice = (r: RawDevice): DeviceRecord => ({
  ...r, charging: r.charging === null || r.charging === undefined ? null : r.charging === 1,
})
