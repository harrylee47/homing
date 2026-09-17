/** 测试用的内存 Store 与 Hub。行为要与 SQLite 实现保持一致，尤其是幂等语义。 */
import type { Connection, Hub } from '../hub.js'
import type {
  DeviceLogRecord,
  ChannelRecord, DeviceRecord, EventFilter, EventQuery, InsertEventResult, OutboundFilter, OutboundRecord,
  InviteRecord, MessageRefRecord, PairingCodeRecord, RuleRecord, SessionRecord, Store, StoredEvent, TaskRecord, UserRecord,
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

  users = new Map<string, UserRecord>([
    // 默认就有一个可用的 u1：绝大多数测试的数据都挂在它名下，
    // 而巡检、调度、握手现在都要问「这个人还能用吗」——
    // 没有这条记录的话它们会一致地判成「账号不存在」，
    // 测的就不是被测的那件事了。要测停用/到期的用例自己改这条记录。
    ['u1', {
      id: 'u1', name: 'u1', password_hash: '', totp_secret: '',
      role: 'admin', bot_token: '', disabled: false,
      expires_at: null, agreed_version: null, agreed_at: null, created_at: 0,
    }],
  ])

  async listUsers() { return [...this.users.values()] }
  async getUser(id: string) { return this.users.get(id) ?? null }
  async getUserByName(n: string) {
    return [...this.users.values()].find((u) => u.name.toLowerCase() === n.toLowerCase()) ?? null
  }
  async getUserByBotToken(t: string) {
    return t ? [...this.users.values()].find((u) => u.bot_token === t) ?? null : null
  }
  async upsertUser(u: UserRecord) { this.users.set(u.id, u) }
  async deleteUser(id: string) {
    const n: Record<string, number> = {}
    const drop = <T extends { user_id: string }>(m: Map<string, T>, key: string) => {
      const hit = [...m.entries()].filter(([, v]) => v.user_id === id)
      for (const [k] of hit) m.delete(k)
      n[key] = hit.length
    }
    drop(this.events, 'events'); drop(this.outbound, 'outbound'); drop(this.messageRefs, 'message_refs')
    drop(this.tasks, 'tasks'); drop(this.rules, 'rules'); drop(this.channels, 'channels')
    drop(this.devices, 'devices'); drop(this.sessions, 'sessions')
    this.users.delete(id)
    return n
  }

  async getDevice(id: string) { return this.devices.get(id) ?? null }
  async listDevices(userId: string) { return [...this.devices.values()].filter((d) => d.user_id === userId) }
  async listAllDevices() { return [...this.devices.values()] }
  async createDevice(d: DeviceRecord) { this.devices.set(d.id, d) }
  async touchDevice(id: string, patch: Partial<DeviceRecord>) {
    const d = this.devices.get(id)
    // 吊销是终态，断线时写入的 offline 不能把它改回去
    if (d && d.status !== 'revoked') this.devices.set(id, { ...d, ...patch })
  }
  async deleteDevice(id: string, userId: string) {
    const d = this.devices.get(id)
    return d?.user_id === userId ? this.devices.delete(id) : false
  }
  async deleteOutboundByDevice(deviceId: string, userId: string) {
    const hit = [...this.outbound.values()].filter((o) => o.device_id === deviceId && o.user_id === userId)
    for (const o of hit) this.outbound.delete(o.id)
    return hit.length
  }
  async revokeDevice(id: string, userId: string) {
    const d = this.devices.get(id)
    if (d && d.user_id !== userId) return
    // 与 SQLite 实现一致：同时作废凭证，否则设备重连就又活了
    if (d) this.devices.set(id, { ...d, status: 'revoked', token_hash: '' })
  }
  async setDeviceLocation(id: string, enc: Uint8Array, at: number) {
    const d = this.devices.get(id)
    if (d) this.devices.set(id, { ...d, location_enc: enc, location_at: at })
  }

  async insertEvent(e: StoredEvent): Promise<InsertEventResult> {
    if (this.events.has(e.id)) return 'duplicate'
    this.events.set(e.id, e)
    return 'stored'
  }
  async getEvent(id: string, userId: string) {
    const e = this.events.get(id)
    return e && e.user_id === userId ? e : null
  }
  async listEvents(q: EventQuery) {
    return this.filtered(q).slice(q.offset, q.offset + q.limit)
  }
  async countEvents(f: EventFilter) { return this.filtered(f).length }
  private filtered(f: EventFilter) {
    return [...this.events.values()]
      .filter((e) =>
        e.user_id === f.user_id &&
        (!f.kind || e.kind === f.kind) &&
        (!f.device_id || e.device_id === f.device_id) &&
        (!f.direction || (e.direction ?? 'in') === f.direction) &&
        (f.since === undefined || e.occurred_at >= f.since) &&
        (f.until === undefined || e.occurred_at <= f.until))
      .sort((a, b) => b.occurred_at - a.occurred_at || b.id.localeCompare(a.id))
  }
  async deleteEvent(id: string, userId: string) {
    const e = this.events.get(id)
    return e?.user_id === userId ? this.events.delete(id) : false
  }
  async deleteEvents(f: EventFilter) {
    const hit = this.filtered(f)
    for (const e of hit) this.events.delete(e.id)
    return hit.length
  }
  async setMatchedRules(id: string, ruleIds: string[]) {
    const e = this.events.get(id)
    if (e) this.events.set(id, { ...e, matched_rules: JSON.stringify(ruleIds) })
  }

  async listChannels(userId: string) { return [...this.channels.values()].filter((c) => c.user_id === userId) }
  async listAllChannels() { return [...this.channels.values()] }
  async getChannel(id: string, userId: string) {
    const c = this.channels.get(id)
    return c && c.user_id === userId ? c : null
  }
  async upsertChannel(c: ChannelRecord) { this.channels.set(c.id, c) }
  async deleteChannel(id: string, userId: string) {
    if (this.channels.get(id)?.user_id === userId) this.channels.delete(id)
  }

  async listRules(userId: string) {
    return [...this.rules.values()].filter((r) => r.user_id === userId).sort((a, b) => a.priority - b.priority)
  }
  async upsertRule(r: RuleRecord) { this.rules.set(r.id, r) }
  async deleteRule(id: string, userId: string) {
    if (this.rules.get(id)?.user_id === userId) this.rules.delete(id)
  }

  invites = new Map<string, InviteRecord>()

  async listInvites() { return [...this.invites.values()] }
  async createInvite(i: InviteRecord) { this.invites.set(i.code_hash, i) }
  async peekInvite(hash: string, now: number) {
    const i = this.invites.get(hash)
    return i && i.used_at === null && i.expires_at > now ? i : null
  }
  async takeInvite(hash: string, userId: string, now: number) {
    const i = this.invites.get(hash)
    // 与 SQLite 的 UPDATE...WHERE used_at IS NULL 等价：只能取用一次
    if (!i || i.used_at !== null || i.expires_at <= now) return null
    const used = { ...i, used_at: now, used_by: userId }
    this.invites.set(hash, used)
    return used
  }
  async deleteInvite(hash: string) {
    const i = this.invites.get(hash)
    return i && i.used_at === null ? this.invites.delete(hash) : false
  }

  async createPairingCode(p: PairingCodeRecord) { this.pairings.set(p.code_hash, p) }
  async takePairingCode(hash: string, now: number) {
    const p = this.pairings.get(hash)
    // 与 SQLite 的 UPDATE...WHERE used_at IS NULL 等价：取用一次后即失效
    if (!p || p.used_at !== null || p.expires_at <= now) return null
    this.pairings.set(hash, { ...p, used_at: now })
    return { ...p, used_at: now }
  }

  tasks = new Map<string, TaskRecord>()

  async listTasks(userId: string) {
    return [...this.tasks.values()].filter((t) => t.user_id === userId).sort((a, b) => a.created_at - b.created_at)
  }
  async listAllTasks() { return [...this.tasks.values()].sort((a, b) => a.created_at - b.created_at) }
  async getTask(id: string, userId: string) {
    const t = this.tasks.get(id)
    return t && t.user_id === userId ? t : null
  }
  async upsertTask(t: TaskRecord) {
    const old = this.tasks.get(t.id)
    // 与 SQLite 的 upsert 一致：只覆盖配置字段，执行状态保持不变
    this.tasks.set(t.id, old ? { ...t, last_run_at: old.last_run_at, last_status: old.last_status, fail_count: old.fail_count } : t)
  }
  async deleteTask(id: string, userId: string) {
    if (this.tasks.get(id)?.user_id === userId) this.tasks.delete(id)
  }
  async setTaskEnabled(id: string, userId: string, enabled: boolean) {
    const t = this.tasks.get(id)
    if (t && t.user_id === userId) this.tasks.set(id, { ...t, enabled })
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
  deviceLogs: DeviceLogRecord[] = []
  async appendDeviceLog(r: DeviceLogRecord) { this.deviceLogs.push(r) }
  async listDeviceLogs(deviceId: string, userId: string, limit: number) {
    // 真实现排的是 created_at DESC, id DESC。同一毫秒多条并不罕见
    // （握手成功紧接着断开就是），所以这里要用插入顺序当次序补充，
    // 否则假 store 的顺序和线上不一致，测出来的东西不作数
    return this.deviceLogs
      .map((r, i) => ({ r, i }))
      .filter((x) => x.r.device_id === deviceId && x.r.user_id === userId)
      .sort((a, b) => (b.r.created_at - a.r.created_at) || (b.i - a.i))
      .slice(0, limit)
      .map((x) => x.r)
  }
  async cleanupDeviceLogs(before: number) {
    this.deviceLogs = this.deviceLogs.filter((r) => r.created_at >= before)
  }
  async getUserSetting(u: string, k: string) { return this.settings.get(`${u}:${k}`) ?? null }
  async listUserSettings(u: string) {
    const out: Record<string, string> = {}
    for (const [k, v] of this.settings) if (k.startsWith(`${u}:`)) out[k.slice(u.length + 1)] = v
    return out
  }
  async setUserSetting(u: string, k: string, v: string) { this.settings.set(`${u}:${k}`, v) }

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
  async revokeAllSessions(userId: string) {
    for (const [k, v] of this.sessions) if (v.user_id === userId) this.sessions.set(k, { ...v, revoked: true })
  }
  async cleanupSessions(now: number) {
    for (const [k, v] of this.sessions) if (v.expires_at < now || v.revoked) this.sessions.delete(k)
  }

  outbound = new Map<string, OutboundRecord>()

  async createOutbound(o: OutboundRecord) { this.outbound.set(o.id, o) }
  async getOutbound(id: string, userId: string) {
    const o = this.outbound.get(id)
    return o && o.user_id === userId ? o : null
  }
  async listOutbound(limit: number, offset: number, filter: OutboundFilter) {
    return this.filteredOutbound(filter).slice(offset, offset + limit)
  }
  async deleteOutbound(id: string, userId: string) {
    return this.outbound.get(id)?.user_id === userId ? this.outbound.delete(id) : false
  }
  async countOutbound(filter: OutboundFilter) {
    return this.filteredOutbound(filter).length
  }
  private filteredOutbound(f: OutboundFilter) {
    return [...this.outbound.values()]
      .filter((o) => o.user_id === f.user_id
        && (!f?.device_id || o.device_id === f.device_id)
        && (!f?.status || o.status === f.status)
        && (!f?.to || o.to_number.includes(f.to)))
      .sort((a, b) => b.created_at - a.created_at || b.id.localeCompare(a.id))
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
