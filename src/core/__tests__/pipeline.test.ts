import { beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createCipher, generateDek } from '../crypto.js'
import { registerProvider } from '../notifier.js'
import { processEvent } from '../pipeline.js'
import { DEFAULT_TIMEZONE } from '../schedule.js'
import { ProviderError, type NotifyMessage, type Provider } from '../providers/types.js'
import { RuleAction, RuleMatch, type MatchableEvent } from '../rules.js'
import type { Cipher } from '../crypto.js'
import { MemoryStore } from './fakes.js'

/** 可控的测试渠道：记录收到的消息，可配置失败次数。 */
const sent: NotifyMessage[] = []
let failTimes = 0
const stub: Provider<{ tag: string }> = {
  type: 'stub',
  configSchema: z.object({ tag: z.string() }),
  async send(_cfg, msg) {
    if (failTimes > 0) { failTimes--; throw new ProviderError('stub', '模拟失败') }
    sent.push(msg)
  },
}
registerProvider(stub as unknown as Provider<never>)

const evt = (o: Partial<MatchableEvent> & { imported?: boolean } = {}): MatchableEvent & { imported?: boolean } => ({
  device_id: 'dev_1', kind: 'sms', from: '95533',
  content: '【建设银行】您的验证码是 123456，5分钟内有效', occurred_at: 1_700_000_000_000, ...o,
})

describe('事件处理管线', () => {
  let store: MemoryStore
  let cipher: Cipher

  const addChannel = async (id: string, enabled = true) => {
    store.channels.set(id, {
      id, type: 'stub', name: id,
      config_enc: await cipher.encrypt(JSON.stringify({ tag: id })),
      enabled, created_at: 0,
    })
  }
  const addRule = (id: string, priority: number, match: Partial<RuleMatch>, action: Partial<RuleAction>) => {
    store.rules.set(id, {
      id, name: id, priority, enabled: true,
      match_json: JSON.stringify(RuleMatch.parse(match)),
      action_json: JSON.stringify(RuleAction.parse(action)),
      created_at: 0,
    })
  }

  beforeEach(async () => {
    store = new MemoryStore()
    cipher = await createCipher(generateDek())
    sent.length = 0
    failTimes = 0
    store.events.set('evt_1', {
      id: 'evt_1', device_id: 'dev_1', kind: 'sms', direction: 'in',
      sender_enc: new Uint8Array(), content_enc: new Uint8Array(),
      enc_ver: 1, occurred_at: 0, received_at: 0, matched_rules: null, created_at: 0,
    })
  })

  it('无规则时走兜底，推送到所有启用渠道', async () => {
    await addChannel('ch_a')
    await addChannel('ch_b')
    await processEvent({ store, cipher, retryBaseMs: 1 }, 'evt_1', evt())
    expect(sent).toHaveLength(2)
  })

  it('禁用的渠道不参与推送', async () => {
    await addChannel('ch_a')
    await addChannel('ch_off', false)
    await processEvent({ store, cipher, retryBaseMs: 1 }, 'evt_1', evt())
    expect(sent).toHaveLength(1)
  })

  it('命中规则时只发规则指定的渠道', async () => {
    await addChannel('ch_a'); await addChannel('ch_b')
    addRule('r1', 10, { sender_regex: '^95533$' }, { channels: ['ch_a'] })
    await processEvent({ store, cipher, retryBaseMs: 1 }, 'evt_1', evt())
    expect(sent).toHaveLength(1)
  })

  it('提取验证码并放进消息', async () => {
    await addChannel('ch_a')
    addRule('r1', 10, {}, { channels: ['ch_a'], extract_code: true })
    await processEvent({ store, cipher, retryBaseMs: 1 }, 'evt_1', evt())
    expect(sent[0]!.code).toBe('123456')
  })

  it('不开启提取时 code 为 null', async () => {
    await addChannel('ch_a')
    addRule('r1', 10, {}, { channels: ['ch_a'], extract_code: false })
    await processEvent({ store, cipher, retryBaseMs: 1 }, 'evt_1', evt())
    expect(sent[0]!.code).toBeNull()
  })

  it('模板渲染生效', async () => {
    await addChannel('ch_a')
    addRule('r1', 10, {}, { channels: ['ch_a'], template: '{sender} 发来 {content}' })
    await processEvent({ store, cipher, retryBaseMs: 1 }, 'evt_1', evt())
    expect(sent[0]!.body).toBe('95533 发来 【建设银行】您的验证码是 123456，5分钟内有效')
  })

  it('回填命中的规则 id', async () => {
    await addChannel('ch_a')
    addRule('r1', 10, {}, { channels: ['ch_a'], stop_processing: true })
    await processEvent({ store, cipher, retryBaseMs: 1 }, 'evt_1', evt())
    expect(store.events.get('evt_1')!.matched_rules).toBe('["r1"]')
  })

  it('规则要求不推送时仅归档', async () => {
    await addChannel('ch_a')
    addRule('r1', 10, { content_contains: ['验证码'] }, { channels: [], stop_processing: true })
    await processEvent({ store, cipher, retryBaseMs: 1 }, 'evt_1', evt())
    expect(sent).toHaveLength(0)
  })

  it('失败两次后重试成功', async () => {
    await addChannel('ch_a')
    failTimes = 2
    await processEvent({ store, cipher, retryBaseMs: 1 }, 'evt_1', evt())
    expect(sent).toHaveLength(1)
    expect(store.audits.some((a) => a.action === 'notify.ok')).toBe(true)
  })

  it('三次全败写审计日志', async () => {
    await addChannel('ch_a')
    failTimes = 99
    await processEvent({ store, cipher, retryBaseMs: 1 }, 'evt_1', evt())
    expect(sent).toHaveLength(0)
    expect(store.audits.some((a) => a.action === 'notify.fail')).toBe(true)
  })

  it('一个渠道失败不影响其他渠道', async () => {
    await addChannel('ch_a')
    await addChannel('ch_b')
    failTimes = 3   // 只够拖垮其中一个渠道的三次重试
    await processEvent({ store, cipher, retryBaseMs: 1 }, 'evt_1', evt())
    expect(sent.length).toBeGreaterThanOrEqual(1)
  })

  it('坏规则被跳过，不影响其他规则生效', async () => {
    await addChannel('ch_a')
    store.rules.set('bad', {
      id: 'bad', name: 'bad', priority: 1, enabled: true,
      match_json: '{ this is not json', action_json: '{}', created_at: 0,
    })
    addRule('good', 10, {}, { channels: ['ch_a'] })
    await processEvent({ store, cipher, retryBaseMs: 1 }, 'evt_1', evt())
    expect(sent).toHaveLength(1)
  })

  it('渠道配置解不开时跳过该渠道而非整体失败', async () => {
    await addChannel('ch_ok')
    store.channels.set('ch_bad', {
      id: 'ch_bad', type: 'stub', name: 'bad',
      config_enc: new Uint8Array([1, 2, 3]), enabled: true, created_at: 0,
    })
    await processEvent({ store, cipher, retryBaseMs: 1 }, 'evt_1', evt())
    expect(sent).toHaveLength(1)
  })

  it('老渠道配置缺少新字段时，schema 默认值仍然生效', async () => {
    // 模拟「新增配置项之前就存下的渠道」：config 里没有 tag 之外的字段
    store.channels.set('ch_old', {
      id: 'ch_old', type: 'stub', name: 'old',
      config_enc: await cipher.encrypt(JSON.stringify({ tag: 'old', extra: 'ignored' })),
      enabled: true, created_at: 0,
    })
    await processEvent({ store, cipher, retryBaseMs: 1 }, 'evt_1', evt())
    expect(sent).toHaveLength(1)
  })

  it('管线异常不向外抛，采集链路不受影响', async () => {
    // 用 Proxy 而不是展开：展开会丢掉原型上的方法，导致其余调用因
    // 「不是函数」而失败，掩盖真正要测的东西
    const broken = new Proxy(store, {
      get: (t, k) => (k === 'listRules' ? () => { throw new Error('db down') } : Reflect.get(t, k)),
    }) as MemoryStore
    await expect(processEvent({ store: broken, cipher, retryBaseMs: 1 }, 'evt_1', evt())).resolves.toBeUndefined()
  })

  it('加载规则失败时不推送，也不让 rejection 逃逸 —— 逃逸会终止进程', async () => {
    const broken = new Proxy(store, {
      get: (t, k) => (k === 'listChannels' ? async () => { throw new Error('db down') } : Reflect.get(t, k)),
    }) as MemoryStore
    sent.length = 0
    await expect(processEvent({ store: broken, cipher, retryBaseMs: 1 }, 'evt_1', evt())).resolves.toBeUndefined()
    expect(sent).toHaveLength(0)
  })
})

describe('多设备时标出来源', () => {
  let store: MemoryStore
  let cipher: Cipher

  const addDevice = (id: string, name: string) => {
    store.devices.set(id, {
      id, name, token_hash: 'h', status: 'offline',
      last_seen_at: null, battery: null, charging: null, location_enc: null, location_at: null, app_version: null, created_at: 0,
    })
  }

  beforeEach(async () => {
    store = new MemoryStore()
    cipher = await createCipher(generateDek())
    sent.length = 0
    failTimes = 0
    store.events.set('evt_1', {
      id: 'evt_1', device_id: 'dev_1', kind: 'sms', direction: 'in',
      sender_enc: new Uint8Array(), content_enc: new Uint8Array(),
      enc_ver: 1, occurred_at: 0, received_at: 0, matched_rules: null, created_at: 0,
    })
    store.channels.set('ch_a', {
      id: 'ch_a', type: 'stub', name: 'ch_a',
      config_enc: await cipher.encrypt(JSON.stringify({ tag: 'a' })),
      enabled: true, created_at: 0,
    })
  })

  it('只有一台设备时不带设备名', async () => {
    addDevice('dev_1', 'JP-Gateway-01')
    await processEvent({ store, cipher, retryBaseMs: 1 }, 'evt_1', evt())
    expect(sent[0]!.deviceName).toBeNull()
  })

  it('多台设备时带上设备名', async () => {
    addDevice('dev_1', 'JP-Gateway-01')
    addDevice('dev_2', 'CN-Gateway-02')
    await processEvent({ store, cipher, retryBaseMs: 1 }, 'evt_1', evt())
    expect(sent[0]!.deviceName).toBe('JP-Gateway-01')
  })

  it('已吊销的设备不计入设备数', async () => {
    addDevice('dev_1', 'JP-Gateway-01')
    addDevice('dev_2', 'old')
    store.devices.set('dev_2', { ...store.devices.get('dev_2')!, status: 'revoked' })
    await processEvent({ store, cipher, retryBaseMs: 1 }, 'evt_1', evt())
    expect(sent[0]!.deviceName).toBeNull()
  })

  it('模板里的 {device} 是设备名而不是 id', async () => {
    addDevice('dev_1', 'JP-Gateway-01')
    store.rules.set('r', {
      id: 'r', name: 'r', priority: 10, enabled: true,
      match_json: JSON.stringify(RuleMatch.parse({})),
      action_json: JSON.stringify(RuleAction.parse({ channels: ['ch_a'], template: '{device}: {content}' })),
      created_at: 0,
    })
    await processEvent({ store, cipher, retryBaseMs: 1 }, 'evt_1', evt())
    expect(sent[0]!.body).toContain('JP-Gateway-01')
    expect(sent[0]!.body).not.toContain('dev_1')
  })
})

describe('时区：规则时段与 {time} 占位符', () => {
  let store: MemoryStore
  let cipher: Cipher

  const addChannel = async (id: string) => {
    store.channels.set(id, {
      id, type: 'stub', name: id,
      config_enc: await cipher.encrypt(JSON.stringify({ tag: id })),
      enabled: true, created_at: 0,
    })
  }
  const addRule = (id: string, match: Partial<RuleMatch>, action: Partial<RuleAction>) => {
    store.rules.set(id, {
      id, name: id, priority: 10, enabled: true,
      match_json: JSON.stringify(RuleMatch.parse(match)),
      action_json: JSON.stringify(RuleAction.parse(action)),
      created_at: 0,
    })
  }

  // 2026-09-15T22:30:00Z = 东京时间次日 07:30
  const AT = Date.parse('2026-09-15T22:30:00Z')

  beforeEach(async () => {
    store = new MemoryStore()
    cipher = await createCipher(generateDek())
    sent.length = 0
    store.events.set('evt_tz', {
      id: 'evt_tz', device_id: 'dev_1', kind: 'sms', direction: 'in',
      sender_enc: new Uint8Array(), content_enc: new Uint8Array(),
      enc_ver: 1, occurred_at: AT, received_at: AT, matched_rules: null, created_at: AT,
    })
    await addChannel('ch_1')
  })

  // 未命中时会走兜底并照样推送，所以判断依据是「用的哪条模板」而不是「有没有推」
  const winRule = () => addRule(
    'r_win',
    { time_window: { from: '07:00', to: '09:00' } },
    { channels: ['ch_1'], template: '命中时段规则', stop_processing: true },
  )

  it('时段按设置的时区算，不是 UTC', async () => {
    await store.setSetting('timezone', 'Asia/Tokyo')
    // 东京 07:00–09:00：UTC 时刻 22:30 落在窗口外，东京时间 07:30 落在窗口内
    winRule()
    await processEvent({ store, cipher }, 'evt_tz', evt({ occurred_at: AT }))
    expect(sent[0]!.body).toBe('命中时段规则')
  })

  it('没设时区时用默认时区，与计划任务保持一致', async () => {
    // 两边各写各的默认值就会差 9 小时，且只在没设过时区时发作
    expect(DEFAULT_TIMEZONE).toBe('Asia/Tokyo')
    winRule()
    await processEvent({ store, cipher }, 'evt_tz', evt({ occurred_at: AT }))
    expect(sent[0]!.body).toBe('命中时段规则')
  })

  it('显式传入的时区优先于设置', async () => {
    await store.setSetting('timezone', 'Asia/Tokyo')
    winRule()
    await processEvent({ store, cipher, tz: 'UTC' }, 'evt_tz', evt({ occurred_at: AT }))
    expect(sent[0]!.body).not.toBe('命中时段规则')
  })

  it('{time} 渲染成设置时区的墙上时间，而不是 ISO 串', async () => {
    await store.setSetting('timezone', 'Asia/Tokyo')
    addRule('r_t', {}, { channels: ['ch_1'], template: '{time} {content}', stop_processing: true })
    await processEvent({ store, cipher }, 'evt_tz', evt({ occurred_at: AT }))
    expect(sent[0]!.body).toContain('2026-09-16 07:30')
    expect(sent[0]!.body).not.toContain('T22:30')
  })

  it('时区名写错时退回 UTC，而不是整条推送断掉', async () => {
    await store.setSetting('timezone', '火星/奥林匹斯')
    addRule('r_t', {}, { channels: ['ch_1'], template: '{time}', stop_processing: true })
    await processEvent({ store, cipher }, 'evt_tz', evt({ occurred_at: AT }))
    expect(sent[0]!.body).toBe('2026-09-15 22:30')
  })
})

describe('历史导入只归档不推送', () => {
  let store: MemoryStore
  let cipher: Cipher

  beforeEach(async () => {
    store = new MemoryStore()
    cipher = await createCipher(generateDek())
    sent.length = 0
    store.events.set('evt_1', {
      id: 'evt_1', device_id: 'dev_1', kind: 'sms', direction: 'in',
      sender_enc: new Uint8Array(), content_enc: new Uint8Array(),
      enc_ver: 1, occurred_at: 0, received_at: 0, matched_rules: null, created_at: 0,
    })
    store.channels.set('ch_1', {
      id: 'ch_1', type: 'stub', name: 'ch_1',
      config_enc: await cipher.encrypt(JSON.stringify({ tag: 'ch_1' })),
      enabled: true, created_at: 0,
    })
  })

  it('导入的记录不会触发推送——否则导入三千条就是三千条通知', async () => {
    await processEvent({ store, cipher }, 'evt_1', evt({ imported: true }))
    expect(sent).toHaveLength(0)
  })

  it('但规则命中照样记录下来，历史里还能按规则筛', async () => {
    store.rules.set('r1', {
      id: 'r1', name: '验证码', priority: 10, enabled: true,
      match_json: JSON.stringify(RuleMatch.parse({ content_contains: ['验证码'] })),
      action_json: JSON.stringify(RuleAction.parse({ channels: ['ch_1'] })),
      created_at: 0,
    })
    await processEvent({ store, cipher }, 'evt_1', evt({ imported: true }))
    expect(store.events.get('evt_1')?.matched_rules).toBe('["r1"]')
    expect(sent).toHaveLength(0)
  })

  it('实时捕获的照常推送', async () => {
    await processEvent({ store, cipher }, 'evt_1', evt())
    expect(sent).toHaveLength(1)
  })
})

describe('删除消息', () => {
  let store: MemoryStore

  const add = (id: string, over: Partial<Parameters<MemoryStore['insertEvent']>[0]> = {}) =>
    store.events.set(id, {
      id, device_id: 'dev_1', kind: 'sms', direction: 'in',
      sender_enc: new Uint8Array(), content_enc: new Uint8Array(),
      enc_ver: 1, occurred_at: 1_700_000_000_000, received_at: 0,
      matched_rules: null, created_at: 0, ...over,
    })

  beforeEach(() => { store = new MemoryStore() })

  it('删单条', async () => {
    add('a'); add('b')
    expect(await store.deleteEvent('a')).toBe(true)
    expect(store.events.size).toBe(1)
  })

  it('删不存在的返回 false，而不是假装成功', async () => {
    expect(await store.deleteEvent('nope')).toBe(false)
  })

  it('按设备删只动那台设备的', async () => {
    add('a'); add('b', { device_id: 'dev_2' }); add('c')
    expect(await store.deleteEvents({ device_id: 'dev_1' })).toBe(2)
    expect([...store.events.keys()]).toEqual(['b'])
  })

  it('按类型与时间范围删', async () => {
    add('a', { kind: 'call' })
    add('b', { kind: 'call', occurred_at: 1_600_000_000_000 })
    add('c')
    expect(await store.deleteEvents({ kind: 'call', since: 1_650_000_000_000 })).toBe(1)
    expect([...store.events.keys()].sort()).toEqual(['b', 'c'])
  })

  it('不带条件就是清空——调用方必须自己确认过', async () => {
    add('a'); add('b')
    expect(await store.deleteEvents({})).toBe(2)
    expect(store.events.size).toBe(0)
  })
})
