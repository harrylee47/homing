import { describe, expect, it } from 'vitest'
import { evaluate, extractCode, matchRule, RuleMatch, type MatchableEvent } from '../rules.js'
import { buildSeedRules, missingDirection, missingSeedRules, SEED_RULES } from '../seeds.js'

const rules = buildSeedRules(['ch_bark', 'ch_tg'], (i) => `seed_${i}`)

const classify = (content: string, kind: MatchableEvent['kind'] = 'sms') => {
  const r = evaluate(rules, {
    device_id: 'dev_1', kind, from: '95533', content, occurred_at: Date.now(),
  })
  return { name: r.matched[0]?.name ?? null, channels: r.channels, priority: r.priority }
}

describe('建议规则集：按消息类型分类', () => {
  it('六条规则，顺序即语义', () => {
    expect(rules.map((r) => r.name)).toEqual(['验证码', '广告推广', '普通短信', '应用通知', '已发送短信', '来电', '去电'])
    expect(rules.every((r) => r.action.stop_processing)).toBe(true)
    // 优先级决定匹配顺序，名字顺序只是定义顺序
    const byPriority = [...rules].sort((a, b) => a.priority - b.priority).map((r) => r.name)
    expect(byPriority).toEqual(['验证码', '广告推广', '应用通知', '已发送短信', '普通短信', '来电', '去电'])
  })

  describe('已发送短信', () => {
    const outgoing = (content: string) => evaluate(rules, {
      device_id: 'dev_1', kind: 'sms', from: '13800138000',
      content, occurred_at: Date.now(), direction: 'out' as const,
    })

    it('自己发出去的短信只归档不推送 —— 给刚发的短信再推一遍验证码是荒谬的', () => {
      const r = outgoing('您的验证码是 123456')
      expect(r.matched[0]?.name).toBe('已发送短信')
      expect(r.channels).toEqual([])
    })

    it('收到的同样内容仍然走验证码规则', () => {
      const r = evaluate(rules, {
        device_id: 'dev_1', kind: 'sms', from: '95533',
        content: '您的验证码是 123456', occurred_at: Date.now(), direction: 'in' as const,
      })
      expect(r.matched[0]?.name).toBe('验证码')
    })

    it('不带 direction 的事件按收到处理 —— 兼容老 Agent', () => {
      const r = evaluate(rules, {
        device_id: 'dev_1', kind: 'sms', from: '95533',
        content: '您的验证码是 123456', occurred_at: Date.now(),
      })
      expect(r.matched[0]?.name).toBe('验证码')
    })

    it('发出去的广告短信也只归档，不会被广告规则抢走', () => {
      expect(outgoing('退订回复T').matched[0]?.name).toBe('已发送短信')
    })
  })

  it('应用通知走独立规则，不被短信规则捕获', () => {
    const r = evaluate(rules, {
      device_id: 'dev_1', kind: 'notification', from: '中国建设银行',
      content: '您的登录验证码是 662211', occurred_at: Date.now(),
    })
    expect(r.matched[0]?.name).toBe('应用通知')
    expect(r.priority).toBe('high')
  })

  it('应用通知也提取验证码 —— 很多验证码走 App 推送', () => {
    expect(rules.find((r) => r.name === '应用通知')!.action.extract_code).toBe(true)
  })

  it('应用通知有独立的 Bark 分组，不与短信混在一起', () => {
    expect(rules.find((r) => r.name === '应用通知')!.action.bark?.group).toBe('应用通知')
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

describe('按设备分流', () => {
  it('限定设备的规则只对该设备生效', () => {
    const scoped = buildSeedRules(['ch_a'], (i) => `s_${i}`).map((r) =>
      r.name === '验证码' ? { ...r, match: { ...r.match, device_ids: ['dev_jp'] } } : r,
    )
    const ev = (device_id: string): MatchableEvent => ({
      device_id, kind: 'sms', from: '95533',
      content: '【建设银行】您的验证码是 123456', occurred_at: Date.now(),
    })

    expect(evaluate(scoped, ev('dev_jp')).matched[0]!.name).toBe('验证码')
    // 另一台设备落到普通短信，而不是被验证码规则捕获
    expect(evaluate(scoped, ev('dev_cn')).matched[0]!.name).toBe('普通短信')
  })

  it('两台设备各走各的渠道', () => {
    const base = buildSeedRules([], (i) => `s_${i}`)
    const jp = { ...base[0]!, id: 'r_jp', priority: 5,
      match: { ...base[0]!.match, device_ids: ['dev_jp'] },
      action: { ...base[0]!.action, channels: ['ch_bark_jp'] } }
    const cn = { ...base[0]!, id: 'r_cn', priority: 6,
      match: { ...base[0]!.match, device_ids: ['dev_cn'] },
      action: { ...base[0]!.action, channels: ['ch_tg_cn'] } }
    const rules = [jp, cn, ...base.slice(1)]

    const ev = (device_id: string): MatchableEvent => ({
      device_id, kind: 'sms', from: '95533',
      content: '验证码 123456', occurred_at: Date.now(),
    })
    expect(evaluate(rules, ev('dev_jp')).channels).toEqual(['ch_bark_jp'])
    expect(evaluate(rules, ev('dev_cn')).channels).toEqual(['ch_tg_cn'])
  })

  it('不限定设备的规则对所有设备生效', () => {
    const rules = buildSeedRules(['ch_a'], (i) => `s_${i}`)
    for (const dev of ['dev_a', 'dev_b', 'dev_c']) {
      expect(evaluate(rules, {
        device_id: dev, kind: 'sms', from: 'x',
        content: '验证码 123456', occurred_at: Date.now(),
      }).matched[0]!.name).toBe('验证码')
    }
  })
})

describe('老部署补齐预置规则', () => {
  it('只补缺的，已有的同名规则不动', () => {
    const missing = missingSeedRules(['验证码', '普通短信', '来电'], ['ch_1'], (i) => `r${i}`)
    expect(missing.map((r) => r.name)).toEqual(['广告推广', '应用通知', '已发送短信', '去电'])
  })

  it('补进来的「已发送短信」仍然是只归档', () => {
    const r = missingSeedRules([], ['ch_1'], (i) => `r${i}`).find((x) => x.name === '已发送短信')!
    expect(r.action.channels).toEqual([])
    expect(r.action.archive).toBe(true)
  })

  it('补进来的「应用通知」要带上渠道，否则等于没通知', () => {
    const r = missingSeedRules([], ['ch_1', 'ch_2'], (i) => `r${i}`).find((x) => x.name === '应用通知')!
    expect(r.action.channels).toEqual(['ch_1', 'ch_2'])
  })

  it('一条都不缺时返回空', () => {
    const all = SEED_RULES.map((s) => s.name)
    expect(missingSeedRules(all, ['ch_1'], (i) => `r${i}`)).toEqual([])
  })
})

describe('给老规则补方向限制', () => {
  it('整个 direction 键都没有的预置规则要补上', () => {
    expect(missingDirection('验证码', { kind: ['sms'], content_contains: ['验证码'] })).toEqual(['in'])
  })

  it('用户已经设过方向的不动——哪怕设的是空数组', () => {
    expect(missingDirection('验证码', { direction: [] })).toBeNull()
    expect(missingDirection('验证码', { direction: ['out'] })).toBeNull()
  })

  it('不是预置名字的规则不碰', () => {
    expect(missingDirection('我自己的规则', { kind: ['sms'] })).toBeNull()
  })

  it('预置规则本身就不限制方向的（应用通知）不补', () => {
    expect(missingDirection('应用通知', { kind: ['notification'] })).toBeNull()
  })

  it('补上之后，自己发出去的验证码短信不再命中「验证码」规则', () => {
    const [seed] = buildSeedRules(['ch_1'], () => 'r1')
    // 模拟老库里那条没有 direction 键的规则
    const { direction: _drop, ...legacy } = seed!.match
    const rule = {
      ...seed!,
      match: RuleMatch.parse({ ...legacy, direction: missingDirection('验证码', legacy) ?? [] }),
    }
    const out: MatchableEvent = {
      device_id: 'dev_1', kind: 'sms', from: '13800138000',
      content: '我的验证码是 123456', occurred_at: Date.now(), direction: 'out',
    }
    expect(matchRule(rule, out)).toBe(false)
    expect(matchRule(rule, { ...out, direction: 'in' })).toBe(true)
  })
})

describe('去电只进记录，不推送', () => {
  const call = (direction: 'in' | 'out'): MatchableEvent => ({
    device_id: 'dev_1', kind: 'call', from: '13800138000',
    content: direction === 'out' ? '已拨出 · 通话 1分20秒' : '未接来电',
    occurred_at: Date.now(), direction,
  })

  it('自己打出去的电话不推送，但要归档', () => {
    const r = evaluate(rules, call('out'))
    expect(r.matched.map((x) => x.name)).toEqual(['去电'])
    expect(r.channels).toEqual([])
    expect(r.archive).toBe(true)
  })

  it('来电照常推送', () => {
    const r = evaluate(rules, call('in'))
    expect(r.matched.map((x) => x.name)).toEqual(['来电'])
    expect(r.channels.length).toBeGreaterThan(0)
  })
})
