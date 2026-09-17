/**
 * 多用户隔离。
 *
 * 这个文件存在的理由很直接：一家人合用一台网关，一个人的卡收银行验证码，
 * 另一个人的卡收工作短信，**互相不能看见**。漏一个作用域条件，
 * 就是把别人的验证码摆到你眼前，而这种漏是静默的——界面上什么都正常。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { createCipher, generateDek, type Cipher } from '../crypto.js'
import { processEvent } from '../pipeline.js'
import { runTask, type ParsedTask, type TaskDeps } from '../tasks.js'
import { MemoryStore } from './fakes.js'
import type { DeviceRecord, StoredEvent } from '../store.js'

const ME = 'usr_me'
const HER = 'usr_her'

const device = (id: string, user: string): DeviceRecord => ({
  id, user_id: user, name: id, token_hash: 'h', status: 'online',
  last_seen_at: 0, battery: null, charging: null, net_json: null,
  location_enc: null, location_at: null, app_version: null, created_at: 0,
})

const event = (id: string, user: string, device_id: string): StoredEvent => ({
  id, user_id: user, device_id, kind: 'sms', direction: 'in', sim_slot: null,
  sender_enc: new Uint8Array(), content_enc: new Uint8Array(),
  enc_ver: 1, occurred_at: 1000, received_at: 0, matched_rules: null, created_at: 0,
})

describe('数据互相看不见', () => {
  let store: MemoryStore

  beforeEach(() => {
    store = new MemoryStore()
    store.devices.set('dev_me', device('dev_me', ME))
    store.devices.set('dev_her', device('dev_her', HER))
    store.events.set('evt_me', event('evt_me', ME, 'dev_me'))
    store.events.set('evt_her', event('evt_her', HER, 'dev_her'))
  })

  it('消息列表只出自己的', async () => {
    const mine = await store.listEvents({ user_id: ME, limit: 50, offset: 0 })
    expect(mine.map((e) => e.id)).toEqual(['evt_me'])
  })

  it('按 id 直接取别人的消息取不到 —— 猜到 id 也没用', async () => {
    expect(await store.getEvent('evt_her', ME)).toBeNull()
    expect(await store.getEvent('evt_her', HER)).not.toBeNull()
  })

  it('总数也不能算进别人的，否则分页会露出「他有多少条」', async () => {
    expect(await store.countEvents({ user_id: ME })).toBe(1)
  })

  it('设备列表只出自己的', async () => {
    expect((await store.listDevices(ME)).map((d) => d.id)).toEqual(['dev_me'])
  })

  it('删不掉别人的东西', async () => {
    expect(await store.deleteEvent('evt_her', ME)).toBe(false)
    expect(await store.deleteDevice('dev_her', ME)).toBe(false)
    expect(store.events.has('evt_her')).toBe(true)
    expect(store.devices.has('dev_her')).toBe(true)
  })

  it('吊销不掉别人的设备 —— 否则等于能把对方的网关关掉', async () => {
    await store.revokeDevice('dev_her', ME)
    expect(store.devices.get('dev_her')!.status).toBe('online')
  })

  it('批量删除只清自己的', async () => {
    expect(await store.deleteEvents({ user_id: ME })).toBe(1)
    expect(store.events.has('evt_her')).toBe(true)
  })

  it('全端下线只下线自己的会话', async () => {
    const sess = (h: string, u: string) => ({
      token_hash: h, user_id: u, ua_hash: '', ip_prefix: '', created_at: 0,
      expires_at: 9e12, revoked: false, trusted: false,
    })
    await store.createSession(sess('a', ME))
    await store.createSession(sess('b', HER))
    await store.revokeAllSessions(ME)
    expect((await store.getSession('a'))!.revoked).toBe(true)
    expect((await store.getSession('b'))!.revoked).toBe(false)
  })
})

describe('推送不会走进别人的渠道', () => {
  let store: MemoryStore
  let cipher: Cipher
  const sent: { channel: string }[] = []

  beforeEach(async () => {
    store = new MemoryStore()
    cipher = await createCipher(generateDek())
    sent.length = 0
    for (const [u, ch] of [[ME, 'ch_me'], [HER, 'ch_her']] as const) {
      store.channels.set(ch, {
        id: ch, user_id: u, type: 'stub', name: ch,
        config_enc: await cipher.encrypt(JSON.stringify({ tag: ch })),
        enabled: true, created_at: 0,
      })
      store.rules.set(`r_${u}`, {
        id: `r_${u}`, user_id: u, name: 'all', priority: 10, enabled: true,
        match_json: JSON.stringify({}), action_json: JSON.stringify({ channels: [ch] }),
        created_at: 0,
      })
    }
    store.events.set('evt_me', event('evt_me', ME, 'dev_me'))
    // pipeline 现在会先问「这个账号还能用吗」，两个人都得先存在
    for (const u of [ME, HER]) {
      store.users.set(u, {
        id: u, name: u, password_hash: '', totp_secret: '', role: 'member',
        bot_token: '', disabled: false, expires_at: null,
        agreed_version: null, agreed_at: null, created_at: 0,
      })
    }
  })

  it('我的短信只推到我的渠道', async () => {
    const { PROVIDERS } = await import('../notifier.js')
    ;(PROVIDERS as Record<string, unknown>).stub = {
      type: 'stub',
      configSchema: { safeParse: (v: unknown) => ({ success: true, data: v }) },
      send: (cfg: { tag: string }) => { sent.push({ channel: cfg.tag }); return Promise.resolve() },
    }
    await processEvent({ store, cipher }, 'evt_me', {
      user_id: ME, device_id: 'dev_me', kind: 'sms', from: '95533', content: '验证码 1234',
      occurred_at: 1000,
    })
    expect(sent.map((s) => s.channel)).toEqual(['ch_me'])
  })

  /*
   * 下行方向的隔离。上线前审计在这里挖出一整组洞：
   * POST /api/outbound 与 POST /api/tasks 用的是不带作用域的 getDevice，
   * 而「任意在线设备」回落到 hub 的**全局**连接表——一个刚注册、一台设备都没有的
   * 普通用户实测能用管理员的手机发短信、能把每天执行的任务绑在上面，
   * 而受害者付话费、被冒名，且在自己的发送记录里看不到（记录归发起者）。
   * 下面几条守的是 core 这一侧；路由那一侧靠 ownedDevice()。
   */
  describe('下行也要按人隔离', () => {
    const task = (o: Partial<ParsedTask> = {}): ParsedTask => ({
      id: 't1', user_id: ME, name: '保号', enabled: true, device_id: '',
      to: '10086', text: '1', sim_slot: null,
      schedule: { type: 'daily', time: '09:00' },
      last_run_at: null, last_status: null, fail_count: 0, created_at: 0, ...o,
    })
    const deps = (online: string[], sent: string[]): TaskDeps => ({
      store,
      timezoneFor: async () => 'UTC',
      // 真实实现（main.ts）在这里和「这个人自己的设备」求了交集
      onlineDevices: async (userId: string) =>
        online.filter((id) => (id === 'dev_me') === (userId === ME)),
      send: async (_u, d) => { sent.push(d); return true },
      alert: async () => {},
      now: () => Date.parse('2026-09-16T09:01:00Z'),
    })

    it('没绑设备的任务只会挑到自己的手机，不会挑到别人的', async () => {
      const sent: string[] = []
      // 别人的设备排在前面：挑「第一台在线的」就会挑中它
      await runTask(deps(['dev_you', 'dev_me'], sent), task(), true)
      expect(sent).toEqual(['dev_me'])
    })

    it('自己一台都不在线时宁可不发，也不借别人的卡', async () => {
      const sent: string[] = []
      const r = await runTask(deps(['dev_you'], sent), task(), true)
      expect(sent).toEqual([])
      expect(r.sent).toBe(false)
    })

    it('撞到别人的 rule_id 时一行都不动，也不会把归属改到自己名下', async () => {
      store.rules.set('r_x', {
        id: 'r_x', user_id: HER, name: '别人的规则', priority: 10, enabled: true,
        match_json: '{}', action_json: '{}', created_at: 0,
      })
      const ok = await store.upsertRule({
        id: 'r_x', user_id: ME, name: '抢过来', priority: 1, enabled: false,
        match_json: '{}', action_json: '{}', created_at: 0,
      })
      expect(ok).toBe(false)
      const still = store.rules.get('r_x')!
      expect(still.user_id).toBe(HER)
      expect(still.name).toBe('别人的规则')
    })
  })
})
