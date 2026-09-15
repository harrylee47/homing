/** 测试用的内存 Store 与 Hub。行为要与 SQLite 实现保持一致，尤其是幂等语义。 */
import type { Connection, Hub } from '../hub.js'
import type {
  ChannelRecord, DeviceRecord, EventFilter, EventQuery, InsertEventResult, OutboundRecord,
  MessageRefRecord, PairingCodeRecord, RuleRecord, SessionRecord, Store, StoredEvent, TaskRecord,
} from '../store.js'

/** 与 SQLite 实现保持一致的状态机顺序 */
const OUTBOUND_RANK: Record<string, number> = {
  pending: 0, accepted: 1, sent: 2, delivered: 3, failed: 4,
}

export class MemoryStore implements Store {
  devices = new Map<string, DeviceRecord>()
  events = new Map<string, StoredEvent>()
  channels = new Map<string, ChannelRecord>()
  rules = new Map<string, RuleRecord>()
  pairings = new Map<string, PairingCodeRecord>()
  audits: { action: string; detail: string | null }[] = []

  async migrate(): Promise<void> {}

  async getDevice(id: string) { return this.devices.get(id) ?? null }
  async listDevices() { return [...this.devices.values()] }
  async createDevice(d: DeviceRecord) { this.devices.set(d.id, d) }
  async touchDevice(id: string, patch: Partial<DeviceRecord>) {
    const d = this.devices.get(id)
    if (d) this.devices.set(id, { ...d, ...patch })
  }
  async revokeDevice(id: string) { await this.touchDevice(id, { status: 'revoked' }) }
  async setDeviceLocation(id: string, enc: Uint8Array, at: number) {
    const d = this.devices.get(id)
    if (d) this.devices.set(id, { ...d, location_enc: enc, location_at: at })
  }

  async insertEvent(e: StoredEvent): Promise<InsertEventResult> {
    if (this.events.has(e.id)) return 'duplicate'
    this.events.set(e.id, e)
    return 'stored'
  }
  async getEvent(id: string) { return this.events.get(id) ?? null }
  async listEvents(q: EventQuery) {
    return this.filtered(q).slice(q.offset, q.offset + q.limit)
  }
  async countEvents(f: EventFilter) { return this.filtered(f).length }
  private filtered(f: EventFilter) {
    return [...this.events.values()]
      .filter((e) =>
        (!f.kind || e.kind === f.kind) &&
        (!f.device_id || e.device_id === f.device_id) &&
        (f.since === undefined || e.occurred_at >= f.since) &&
        (f.until === undefined || e.occurred_at <= f.until))
      .sort((a, b) => b.occurred_at - a.occurred_at)
  }
  async setMatchedRules(id: string, ruleIds: string[]) {
    const e = this.events.get(id)
    if (e) this.events.set(id, { ...e, matched_rules: JSON.stringify(ruleIds) })
  }

  async listChannels() { return [...this.channels.values()] }
  async getChannel(id: string) { return this.channels.get(id) ?? null }
  async upsertChannel(c: ChannelRecord) { this.channels.set(c.id, c) }
  async deleteChannel(id: string) { this.channels.delete(id) }

  async listRules() { return [...this.rules.values()].sort((a, b) => a.priority - b.priority) }
  async upsertRule(r: RuleRecord) { this.rules.set(r.id, r) }
  async deleteRule(id: string) { this.rules.delete(id) }

  async createPairingCode(p: PairingCodeRecord) { this.pairings.set(p.code_hash, p) }
  async takePairingCode(hash: string, now: number) {
    const p = this.pairings.get(hash)
    // 与 SQLite 的 UPDATE...WHERE used_at IS NULL 等价：取用一次后即失效
    if (!p || p.used_at !== null || p.expires_at <= now) return null
    this.pairings.set(hash, { ...p, used_at: now })
    return { ...p, used_at: now }
  }

  tasks = new Map<string, TaskRecord>()

  async listTasks() { return [...this.tasks.values()].sort((a, b) => a.created_at - b.created_at) }
  async getTask(id: string) { return this.tasks.get(id) ?? null }
  async upsertTask(t: TaskRecord) {
    const old = this.tasks.get(t.id)
    // 与 SQLite 的 upsert 一致：只覆盖配置字段，执行状态保持不变
    this.tasks.set(t.id, old ? { ...t, last_run_at: old.last_run_at, last_status: old.last_status, fail_count: old.fail_count } : t)
  }
  async deleteTask(id: string) { this.tasks.delete(id) }
  async setTaskEnabled(id: string, enabled: boolean) {
    const t = this.tasks.get(id)
    if (t) this.tasks.set(id, { ...t, enabled })
  }
  async updateTaskRun(id: string, p: { last_run_at: number; last_status: 'ok' | 'failed'; fail_count: number }) {
    const t = this.tasks.get(id)
    if (t) this.tasks.set(id, { ...t, ...p })
  }

  messageRefs = new Map<string, MessageRefRecord>()

  async putMessageRef(r: MessageRefRecord) { this.messageRefs.set(`${r.channel_id}:${r.ref}`, r) }
  async getMessageRef(c: string, r: string) { return this.messageRefs.get(`${c}:${r}`) ?? null }
  async cleanupMessageRefs(before: number) {
    for (const [k, v] of this.messageRefs) if (v.created_at < before) this.messageRefs.delete(k)
  }

  settings = new Map<string, string>()
  sessions = new Map<string, SessionRecord>()

  async getSetting(k: string) { return this.settings.get(k) ?? null }
  async setSetting(k: string, v: string) { this.settings.set(k, v) }

  async createSession(s: SessionRecord) { this.sessions.set(s.token_hash, s) }
  async getSession(h: string) { return this.sessions.get(h) ?? null }
  async touchSession(h: string, e: number) {
    const s = this.sessions.get(h)
    if (s) this.sessions.set(h, { ...s, expires_at: e })
  }
  async revokeSession(h: string) {
    const s = this.sessions.get(h)
    if (s) this.sessions.set(h, { ...s, revoked: true })
  }
  async revokeAllSessions() {
    for (const [k, v] of this.sessions) this.sessions.set(k, { ...v, revoked: true })
  }
  async cleanupSessions(now: number) {
    for (const [k, v] of this.sessions) if (v.expires_at < now || v.revoked) this.sessions.delete(k)
  }

  outbound = new Map<string, OutboundRecord>()

  async createOutbound(o: OutboundRecord) { this.outbound.set(o.id, o) }
  async getOutbound(id: string) { return this.outbound.get(id) ?? null }
  async listOutbound(limit: number, offset: number) {
    return [...this.outbound.values()].sort((a, b) => b.created_at - a.created_at).slice(offset, offset + limit)
  }
  async advanceOutbound(id: string, status: OutboundRecord['status'], error: string | null, at: number) {
    const o = this.outbound.get(id)
    if (!o) return
    const from = OUTBOUND_RANK[o.status] ?? 0
    const to = OUTBOUND_RANK[status] ?? 0
    if (status !== 'failed' && to <= from) return
    this.outbound.set(id, { ...o, status, error, updated_at: at })
  }

  async audit(e: { action: string; detail: string | null }) {
    this.audits.push({ action: e.action, detail: e.detail })
  }

  async close(): Promise<void> {}
}

export class MemoryHub implements Hub {
  conns = new Map<string, Connection>()
  register(c: Connection) { this.conns.set(c.device_id, c) }
  unregister(id: string) { this.conns.delete(id) }
  get(id: string) { return this.conns.get(id) }
  onlineDevices() { return [...this.conns.keys()] }
  send() { return false }
}
