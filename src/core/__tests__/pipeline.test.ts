import { beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createCipher, generateDek } from '../crypto.js'
import { registerProvider } from '../notifier.js'
import { processEvent } from '../pipeline.js'
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

const evt = (o: Partial<MatchableEvent> = {}): MatchableEvent => ({
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
      id: 'evt_1', device_id: 'dev_1', kind: 'sms',
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

  it('管线异常不向外抛，采集链路不受影响', async () => {
    const broken = { ...store, listRules: () => { throw new Error('db down') } } as unknown as MemoryStore
    await expect(processEvent({ store: broken, cipher, retryBaseMs: 1 }, 'evt_1', evt())).resolves.toBeUndefined()
  })
})
