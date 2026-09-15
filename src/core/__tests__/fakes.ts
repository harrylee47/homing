/** 测试用的内存 Store 与 Hub。行为要与 SQLite 实现保持一致，尤其是幂等语义。 */
import type { Connection, Hub } from '../hub.js'
import type {
  ChannelRecord, DeviceRecord, EventQuery, InsertEventResult, OutboundRecord,
  PairingCodeRecord, RuleRecord, Store, StoredEvent,
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

  async insertEvent(e: StoredEvent): Promise<InsertEventResult> {
    if (this.events.has(e.id)) return 'duplicate'
    this.events.set(e.id, e)
    return 'stored'
  }
  async getEvent(id: string) { return this.events.get(id) ?? null }
  async listEvents(_q: EventQuery) { return [...this.events.values()] }
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
