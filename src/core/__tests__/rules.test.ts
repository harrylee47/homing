import { describe, expect, it } from 'vitest'
import {
  evaluate, extractCode, inTimeWindow, matchRule, render,
  RuleAction, RuleMatch, type MatchableEvent, type Rule,
} from '../rules.js'

const evt = (o: Partial<MatchableEvent> = {}): MatchableEvent => ({
  device_id: 'dev_1', kind: 'sms', from: '95533',
  content: '【建设银行】您的验证码是 123456，5分钟内有效',
  occurred_at: Date.UTC(2026, 8, 15, 10, 30), ...o,
})

const rule = (m: Partial<RuleMatch> = {}, a: Partial<RuleAction> = {}, o: Partial<Rule> = {}): Rule => ({
  id: 'r1', name: 'test', priority: 100, enabled: true,
  match: RuleMatch.parse(m), action: RuleAction.parse(a), ...o,
})

describe('规则匹配', () => {
  it('空条件匹配一切', () => {
    expect(matchRule(rule(), evt())).toBe(true)
  })

  it('禁用的规则永不命中', () => {
    expect(matchRule(rule({}, {}, { enabled: false }), evt())).toBe(false)
  })

  it('kind 数组内是 OR', () => {
    expect(matchRule(rule({ kind: ['sms', 'call'] }), evt({ kind: 'call' }))).toBe(true)
    expect(matchRule(rule({ kind: ['call'] }), evt({ kind: 'sms' }))).toBe(false)
  })

  it('多个条件之间是 AND', () => {
    const r = rule({ kind: ['sms'], content_contains: ['验证码'] })
    expect(matchRule(r, evt())).toBe(true)
    // kind 对但内容不含关键词 → 整体不命中
    expect(matchRule(r, evt({ content: '您的账单已出' }))).toBe(false)
  })

  it('content_contains 数组内是 OR', () => {
    const r = rule({ content_contains: ['动的パスワード', '验证码'] })
    expect(matchRule(r, evt())).toBe(true)
  })

  it('发件人正则', () => {
    expect(matchRule(rule({ sender_regex: '^(95533|95588)$' }), evt())).toBe(true)
    expect(matchRule(rule({ sender_regex: '^955(33|88)$' }), evt({ from: '10086' }))).toBe(false)
  })

  it('写坏的正则不命中，而不是让整条链崩掉', () => {
    // 一条坏规则若抛异常，会导致所有短信都收不到——必须容错
    expect(() => matchRule(rule({ sender_regex: '([' }), evt())).not.toThrow()
    expect(matchRule(rule({ sender_regex: '([' }), evt())).toBe(false)
  })

  it('限定设备', () => {
    expect(matchRule(rule({ device_ids: ['dev_1'] }), evt())).toBe(true)
    expect(matchRule(rule({ device_ids: ['dev_2'] }), evt())).toBe(false)
  })
})

describe('时段窗口', () => {
  const at = (h: number, m = 0) => Date.UTC(2026, 8, 15, h, m)

  it('普通区间', () => {
    expect(inTimeWindow(at(10), '09:00', '18:00', 0)).toBe(true)
    expect(inTimeWindow(at(20), '09:00', '18:00', 0)).toBe(false)
  })

  it('跨午夜区间', () => {
    expect(inTimeWindow(at(23, 30), '23:00', '07:00', 0)).toBe(true)
    expect(inTimeWindow(at(3), '23:00', '07:00', 0)).toBe(true)
    expect(inTimeWindow(at(12), '23:00', '07:00', 0)).toBe(false)
  })

  it('时区偏移生效', () => {
    // UTC 23:00 在东九区是次日 08:00
    expect(inTimeWindow(at(23), '08:00', '09:00', 540)).toBe(true)
  })

  it('边界包含两端', () => {
    expect(inTimeWindow(at(9, 0), '09:00', '18:00', 0)).toBe(true)
    expect(inTimeWindow(at(18, 0), '09:00', '18:00', 0)).toBe(true)
  })
})

describe('规则求值', () => {
  it('按 priority 升序，小者优先', () => {
    const rs = [
      rule({}, { channels: ['c_low'] }, { id: 'a', priority: 200 }),
      rule({}, { channels: ['c_high'] }, { id: 'b', priority: 10 }),
    ]
    expect(evaluate(rs, evt()).matched.map((r) => r.id)).toEqual(['b', 'a'])
  })

  it('stop_processing 截断后续匹配', () => {
    const rs = [
      rule({}, { channels: ['c1'], stop_processing: true }, { id: 'a', priority: 10 }),
      rule({}, { channels: ['c2'] }, { id: 'b', priority: 20 }),
    ]
    const r = evaluate(rs, evt())
    expect(r.matched.map((x) => x.id)).toEqual(['a'])
    expect(r.channels).toEqual(['c1'])
  })

  it('多规则命中时渠道去重合并', () => {
    const rs = [
      rule({}, { channels: ['c1', 'c2'] }, { id: 'a', priority: 10 }),
      rule({}, { channels: ['c2', 'c3'] }, { id: 'b', priority: 20 }),
    ]
    expect(evaluate(rs, evt()).channels).toEqual(['c1', 'c2', 'c3'])
  })

  it('任一规则为 high 则整体 high', () => {
    const rs = [
      rule({}, { priority: 'normal' }, { id: 'a', priority: 10 }),
      rule({}, { priority: 'high' }, { id: 'b', priority: 20 }),
    ]
    expect(evaluate(rs, evt()).priority).toBe('high')
  })

  it('无规则命中时 matched 为空，由调用方走兜底', () => {
    const rs = [rule({ kind: ['call'] }, {}, { id: 'a' })]
    expect(evaluate(rs, evt()).matched).toEqual([])
  })

  it('同优先级按 id 稳定排序，结果可预期', () => {
    const rs = [
      rule({}, {}, { id: 'z', priority: 50 }),
      rule({}, {}, { id: 'a', priority: 50 }),
    ]
    expect(evaluate(rs, evt()).matched.map((r) => r.id)).toEqual(['a', 'z'])
  })
})

describe('验证码提取', () => {
  it.each([
    ['【建设银行】您的验证码是 123456，5分钟内有效', '123456'],
    ['验证码：8842', '8842'],
    ['动态密码 135790 请勿告诉他人', '135790'],
    ['Your verification code is 55213', '55213'],
    ['お客様の認証番号は 4821 です', '4821'],
    ['123456 是您的验证码，请勿泄露', '123456'],
  ])('从「%s」提取出 %s', (content, expected) => {
    expect(extractCode(content)).toBe(expected)
  })

  it('没有关键词时不提取，避免把金额/卡号当成验证码', () => {
    expect(extractCode('您尾号 1234 的卡消费 5000 元')).toBeNull()
    expect(extractCode('订单 20260915 已发货')).toBeNull()
  })

  it('关键词存在但附近无数字则返回 null', () => {
    expect(extractCode('验证码已发送至您的邮箱')).toBeNull()
  })

  it('过长的数字串不算验证码（订单号/卡号会被误判）', () => {
    expect(extractCode('验证码是 1234567890123')).toBeNull()
  })

  it('过短的数字串也不算', () => {
    expect(extractCode('验证码是 12')).toBeNull()
  })
})

describe('模板渲染', () => {
  it('替换已知占位符', () => {
    expect(render('【{sender}】{content}', {
      sender: '95533', content: '验证码 123456', code: '123456', time: 't', device: 'd',
    })).toBe('【95533】验证码 123456')
  })

  it('未知占位符原样保留，便于发现拼写错误', () => {
    expect(render('{sender} {typo}', {
      sender: 'a', content: '', code: '', time: '', device: '',
    })).toBe('a {typo}')
  })
})

describe('发件人匹配（不用写正则）', () => {
  const ev = (from: string): MatchableEvent => ({
    device_id: 'dev_1', kind: 'sms', from, content: '正文', occurred_at: Date.now(),
  })
  const rule = (sender: unknown): Rule => ({
    id: 'r1', name: 't', priority: 1, enabled: true,
    match: RuleMatch.parse({ sender }), action: RuleAction.parse({}),
  })

  it('包含：多个值之间是 OR', () => {
    const r = rule({ mode: 'contains', values: ['95533', '95588'] })
    expect(matchRule(r, ev('+8695533'))).toBe(true)
    expect(matchRule(r, ev('95588'))).toBe(true)
    expect(matchRule(r, ev('10086'))).toBe(false)
  })

  it('等于：整串相等', () => {
    const r = rule({ mode: 'equals', values: ['95533'] })
    expect(matchRule(r, ev('95533'))).toBe(true)
    expect(matchRule(r, ev('+8695533'))).toBe(false)
  })

  it('尾号：跨国际区号写法仍然命中', () => {
    const r = rule({ mode: 'suffix', values: ['8000'] })
    expect(matchRule(r, ev('+8613800138000'))).toBe(true)
    expect(matchRule(r, ev('13800138001'))).toBe(false)
  })

  it('开头是', () => {
    const r = rule({ mode: 'prefix', values: ['106'] })
    expect(matchRule(r, ev('1069000012345'))).toBe(true)
    expect(matchRule(r, ev('13800138000'))).toBe(false)
  })

  it('忽略大小写——发件人可能是 Google 也可能是 GOOGLE', () => {
    const r = rule({ mode: 'equals', values: ['Google'] })
    expect(matchRule(r, ev('GOOGLE'))).toBe(true)
  })

  it('正则模式仍然可用，写错了当不命中而不是崩', () => {
    expect(matchRule(rule({ mode: 'regex', values: ['^955(33|88)$'] }), ev('95588'))).toBe(true)
    expect(matchRule(rule({ mode: 'regex', values: ['^(('] }), ev('95588'))).toBe(false)
  })

  it('值为空视为不限制', () => {
    expect(matchRule(rule({ mode: 'equals', values: [] }), ev('随便'))).toBe(true)
  })

  it('老规则的 sender_regex 行为不变', () => {
    const r: Rule = {
      id: 'r1', name: 't', priority: 1, enabled: true,
      match: RuleMatch.parse({ sender_regex: '^95533$' }), action: RuleAction.parse({}),
    }
    expect(matchRule(r, ev('95533'))).toBe(true)
    expect(matchRule(r, ev('95588'))).toBe(false)
  })
})

describe('正文排除词', () => {
  const ev = (content: string): MatchableEvent => ({
    device_id: 'dev_1', kind: 'sms', from: '95533', content, occurred_at: Date.now(),
  })
  const rule = (match: unknown): Rule => ({
    id: 'r1', name: 't', priority: 1, enabled: true,
    match: RuleMatch.parse(match), action: RuleAction.parse({}),
  })

  it('命中排除词即不命中，哪怕包含词也中了', () => {
    const r = rule({ content_contains: ['验证码'], content_excludes: ['退订'] })
    expect(matchRule(r, ev('您的验证码是 1234'))).toBe(true)
    expect(matchRule(r, ev('验证码优惠活动，回复 TD 退订'))).toBe(false)
  })

  it('只写排除词时其余全部命中', () => {
    const r = rule({ content_excludes: ['广告'] })
    expect(matchRule(r, ev('随便什么'))).toBe(true)
    expect(matchRule(r, ev('这是广告'))).toBe(false)
  })
})

describe('控制台提交的规则结构能被接受', () => {
  // 与 web/app.js 的 collect() 一一对应。这两处漂移的表现是保存时报
  // 「规则校验失败」，而用户看不出是哪个字段的问题。
  it('新界面的完整 payload', () => {
    const m = RuleMatch.safeParse({
      kind: ['sms', 'notification'],
      sender: { mode: 'suffix', values: ['8000', '95533'] },
      sender_regex: null,
      content_contains: ['验证码'],
      content_excludes: ['退订'],
      content_regex: null,
      device_ids: ['dev_1'],
      direction: ['in'],
      time_window: { from: '07:00', to: '23:30' },
    })
    expect(m.success).toBe(true)
    expect(m.data?.sender?.mode).toBe('suffix')
  })

  it('全部留空也合法——那表示不限制', () => {
    const m = RuleMatch.safeParse({
      kind: [], sender: null, sender_regex: null,
      content_contains: [], content_excludes: [], content_regex: null,
      device_ids: [], direction: [], time_window: null,
    })
    expect(m.success).toBe(true)
  })

  it('动作里的 Bark 选项', () => {
    const a = RuleAction.safeParse({
      channels: ['ch_1'], priority: 'high', extract_code: true,
      template: '【{sender}】{content}', archive: true, stop_processing: true,
      bark: { level: 'timeSensitive', group: null, auto_copy_code: true, deep_link: 'event' },
    })
    expect(a.success).toBe(true)
    expect(a.data?.bark?.level).toBe('timeSensitive')
  })

  it('时段格式写错时明确报错，而不是悄悄忽略', () => {
    expect(RuleMatch.safeParse({ time_window: { from: '25:00', to: '07:00' } }).success).toBe(false)
  })
})
