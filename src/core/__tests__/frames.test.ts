import { describe, expect, it } from 'vitest'
import { encodeFrame, makeFrame, parseUpstream } from '../frames.js'
import { CLOCK_SKEW_TOLERANCE_MS, ErrorCode } from '../protocol.js'

const NOW = 1_757_894_400_000
const hello = () =>
  makeFrame('hello', {
    device_id: 'dev_test01',
    token: 'x'.repeat(32),
    app_version: '0.1.0',
    android_sdk: 34,
    battery: 87,
    pending_count: 0,
  }, NOW)

describe('帧解析', () => {
  it('合法 hello 通过', () => {
    const r = parseUpstream(encodeFrame(hello()), NOW)
    expect(r.ok).toBe(true)
  })

  it('非法 JSON 被拒', () => {
    const r = parseUpstream('{not json', NOW)
    expect(r).toMatchObject({ ok: false, code: ErrorCode.PROTOCOL_MALFORMED })
  })

  it('版本不符返回专用错误码而非笼统结构错误', () => {
    const f = { ...hello(), v: 99 }
    const r = parseUpstream(encodeFrame(f), NOW)
    expect(r).toMatchObject({ ok: false, code: ErrorCode.PROTOCOL_VERSION_UNSUPPORTED })
  })

  it('缺字段被拒并指出字段名', () => {
    const f = hello()
    delete (f.payload as Record<string, unknown>).token
    const r = parseUpstream(encodeFrame(f), NOW)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toContain('token')
  })

  it('时钟偏移超限被拒（抗重放）', () => {
    const r = parseUpstream(encodeFrame(hello()), NOW + CLOCK_SKEW_TOLERANCE_MS + 1000)
    expect(r).toMatchObject({ ok: false, code: ErrorCode.CLOCK_SKEW })
  })

  it('偏移在容忍范围内通过', () => {
    const r = parseUpstream(encodeFrame(hello()), NOW + CLOCK_SKEW_TOLERANCE_MS - 1000)
    expect(r.ok).toBe(true)
  })

  it('下行帧类型不能从上行通道进入', () => {
    const f = makeFrame('hello_ack', { server_time: NOW, config: {}, known_event_ids: [] }, NOW)
    expect(parseUpstream(encodeFrame(f), NOW).ok).toBe(false)
  })

  it('缺失 sim_slot 的事件仍然合法 —— Kotlin 会省略空字段而非写 null', () => {
    const f = makeFrame('event', {
      id: `evt_${crypto.randomUUID()}`,
      device_id: 'dev_test01',
      kind: 'notification',
      from: '中国建设银行',
      content: '您的验证码是 662211',
      occurred_at: NOW,
      // 故意不带 sim_slot：通知类事件恒无卡槽
      extra: { package: 'com.example.bank' },
    }, NOW)
    const r = parseUpstream(encodeFrame(f), NOW)
    expect(r.ok).toBe(true)
    if (r.ok && r.frame.type === 'event') expect(r.frame.payload.sim_slot).toBeNull()
  })

  it('显式 null 的 sim_slot 同样合法', () => {
    const f = makeFrame('event', {
      id: `evt_${crypto.randomUUID()}`, device_id: 'dev_test01', kind: 'sms',
      from: '95533', content: 'x', occurred_at: NOW, sim_slot: null, extra: {},
    }, NOW)
    expect(parseUpstream(encodeFrame(f), NOW).ok).toBe(true)
  })

  it('event 的 occurred_at 可以很旧（补传场景）', () => {
    const f = makeFrame('event', {
      id: `evt_${crypto.randomUUID()}`,
      device_id: 'dev_test01',
      kind: 'sms',
      from: '95533',
      content: '验证码 123456',
      occurred_at: NOW - 7 * 24 * 3600 * 1000,
      sim_slot: 0,
      extra: {},
    }, NOW)
    expect(parseUpstream(encodeFrame(f), NOW).ok).toBe(true)
  })
})
