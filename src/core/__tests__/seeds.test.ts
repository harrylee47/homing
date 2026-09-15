import { describe, expect, it } from 'vitest'
import { evaluate, extractCode, type MatchableEvent } from '../rules.js'
import { buildSeedRules } from '../seeds.js'

const rules = buildSeedRules(['ch_bark', 'ch_tg'], (i) => `seed_${i}`)

const classify = (content: string, kind: MatchableEvent['kind'] = 'sms') => {
  const r = evaluate(rules, {
    device_id: 'dev_1', kind, from: '95533', content, occurred_at: Date.now(),
  })
  return { name: r.matched[0]?.name ?? null, channels: r.channels, priority: r.priority }
}

describe('建议规则集：按消息类型分类', () => {
  it('四条规则，顺序即语义', () => {
    expect(rules.map((r) => r.name)).toEqual(['验证码', '广告推广', '普通短信', '来电'])
    expect(rules.map((r) => r.priority)).toEqual([10, 20, 100, 110])
    expect(rules.every((r) => r.action.stop_processing)).toBe(true)
  })

  describe('验证码', () => {
    it.each([
      '【建设银行】您的验证码是 123456，5分钟内有效',
      '【工商银行】校验码 8842，请勿泄露',
      'お客様の認証番号は 4821 です',
      'Your verification code is 55213',
      '动态密码 135790',
    ])('识别「%s」', (c) => {
      const r = classify(c)
      expect(r.name).toBe('验证码')
      expect(r.priority).toBe('high')
    })

    it('高优先级且推送到全部渠道', () => {
      expect(classify('验证码 123456').channels).toEqual(['ch_bark', 'ch_tg'])
    })

    it('带退订字样的验证码短信仍归为验证码 —— 顺序保证的', () => {
      // 不少银行短信结尾带「回T退订」，如果广告规则排在前面就会被静默归档，
      // 那是最严重的漏报形态：用户完全不知道验证码来过
      const r = classify('【招商银行】验证码 998877，如需退订请回复T')
      expect(r.name).toBe('验证码')
      expect(r.priority).toBe('high')
    })
  })

  describe('广告', () => {
    it.each([
      '双十一大促，全场五折，点击领取优惠券',
      '【某商城】限时秒杀，回T退订',
      '会员日活动开启，免费领取好礼',
    ])('识别「%s」', (c) => {
      expect(classify(c).name).toBe('广告推广')
    })

    it('只归档不推送', () => {
      expect(classify('限时优惠，回T退订').channels).toEqual([])
    })
  })

  describe('普通短信', () => {
    it.each([
      '您的快递已签收，请注意查收',
      '【某某银行】您尾号1234的卡消费500元',
      '明天下午三点开会，请准时参加',
    ])('识别「%s」', (c) => {
      expect(classify(c).name).toBe('普通短信')
    })

    it('正常推送但不提取验证码 —— 避免把订单号/金额当成码', () => {
      const r = classify('您的订单 20260915001 已发货')
      expect(r.name).toBe('普通短信')
      expect(r.channels).toEqual(['ch_bark', 'ch_tg'])
      expect(rules.find((x) => x.name === '普通短信')!.action.extract_code).toBe(false)
    })

    it('兜底覆盖一切短信，不会有短信落到规则之外', () => {
      for (const c of ['', 'x', '!@#$%', '　', '𠮷野家']) {
        expect(classify(c).name).not.toBeNull()
      }
    })
  })

  describe('来电', () => {
    it('来电走独立规则，不被短信规则影响', () => {
      expect(classify('未接来电', 'call').name).toBe('来电')
    })

    it('即便来电内容含验证码字样也归为来电（kind 先于内容）', () => {
      expect(classify('验证码', 'call').name).toBe('来电')
    })
  })

  describe('与验证码提取的配合', () => {
    it('归为验证码的消息确实能提取出码', () => {
      const c = '【建设银行】您的验证码是 123456，5分钟内有效'
      expect(classify(c).name).toBe('验证码')
      expect(extractCode(c)).toBe('123456')
    })

    it('Bark 参数：验证码穿透专注模式，普通短信不打扰', () => {
      const code = rules.find((r) => r.name === '验证码')!.action.bark
      const normal = rules.find((r) => r.name === '普通短信')!.action.bark
      expect(code?.level).toBe('timeSensitive')
      expect(code?.auto_copy_code).toBe(true)
      expect(normal?.level).toBe('active')
      expect(normal?.auto_copy_code).toBe(false)
    })
  })
})
