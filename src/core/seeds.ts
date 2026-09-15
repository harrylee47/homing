/**
 * 建议的初始规则集。
 *
 * 按「消息本身是什么」分类，而不是按发件人号段。号段判断是脆的：
 * 验证码可能来自任何国家的任何服务，号段列表永远列不全，
 * 漏掉一个就意味着那条验证码被降级成普通消息。
 *
 * 四条规则按优先级串联，每条都 stop_processing，所以**顺序即语义**：
 * 先看是不是验证码，再看是不是广告，都不是就当普通短信。
 * 这个顺序能自然处理「带退订字样的验证码短信」这类交叉情况。
 */
import { RuleAction, RuleMatch, type Rule } from './rules.js'

export interface SeedSpec {
  name: string
  priority: number
  match: unknown
  action: unknown
}

export const SEED_RULES: SeedSpec[] = [
  {
    // 验证码：最高优先级。穿透专注模式，自动提取并复制。
    name: '验证码',
    priority: 10,
    match: {
      kind: ['sms'],
      content_contains: [
        '验证码', '校验码', '动态码', '动态密码', '识别码', '验证代码',
        '確認コード', '認証番号', 'ワンタイム',
        'verification code', 'security code', 'OTP', 'one-time',
      ],
    },
    action: {
      priority: 'high', extract_code: true,
      template: '【{sender}】{content}', archive: true, stop_processing: true,
      bark: { level: 'timeSensitive', group: '验证码', auto_copy_code: true, deep_link: 'event' },
    },
  },
  {
    // 广告：只归档不推送。价值在于「需要时能查到」，而不是打扰。
    // 排在验证码之后，所以带「退订」字样的验证码短信不会被误判。
    name: '广告推广',
    priority: 20,
    match: {
      kind: ['sms'],
      content_contains: [
        '退订', '回T', '回复T', 'TD退订', '拒收请回复',
        '优惠', '折扣', '促销', '特惠', '抢购', '秒杀', '限时',
        '免费领', '点击领取', '会员日', '活动', '广告',
      ],
    },
    action: {
      priority: 'normal', extract_code: false,
      // channels 留空 = 只归档不推送
      template: '【{sender}】{content}', archive: true, stop_processing: true,
    },
  },
  {
    // 普通：两者都不是。正常推送但不打扰；不提取验证码，避免把订单号当成码。
    name: '普通短信',
    priority: 100,
    match: { kind: ['sms'] },
    action: {
      priority: 'normal', extract_code: false,
      template: '【{sender}】{content}', archive: true, stop_processing: true,
      bark: { level: 'active', group: '短信', auto_copy_code: false, deep_link: 'event' },
    },
  },
  {
    name: '来电',
    priority: 110,
    match: { kind: ['call'] },
    action: {
      priority: 'normal', extract_code: false,
      template: '{content}：{sender}', archive: true, stop_processing: true,
      bark: { level: 'active', group: '来电', auto_copy_code: false, deep_link: 'compose' },
    },
  },
]

/** 展开为可直接求值的规则。channels 由调用方注入——广告那条恒为空。 */
export function buildSeedRules(channelIds: string[], idFor: (i: number) => string): Rule[] {
  return SEED_RULES.map((s, i) => {
    const action = RuleAction.parse(s.action)
    return {
      id: idFor(i),
      name: s.name,
      priority: s.priority,
      enabled: true,
      match: RuleMatch.parse(s.match),
      // 广告规则的 channels 必须保持为空，否则「只归档」就失效了
      action: { ...action, channels: s.name === '广告推广' ? [] : channelIds },
    }
  })
}
