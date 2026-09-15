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
      kind: ['sms'], direction: ['in'],
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
      kind: ['sms'], direction: ['in'],
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
    match: { kind: ['sms'], direction: ['in'] },
    action: {
      priority: 'normal', extract_code: false,
      template: '【{sender}】{content}', archive: true, stop_processing: true,
      bark: { level: 'active', group: '短信', auto_copy_code: false, deep_link: 'event' },
    },
  },
  {
    // App 通知：很多验证码走推送而不是短信（微信、支付宝、银行 App）。
    // 单列一条是为了能给它单独的 Bark 分组与优先级——与短信混在一起
    // 就没法区分「银行短信」和「银行 App 推送」了。
    name: '应用通知',
    priority: 90,
    match: { kind: ['notification'] },
    action: {
      priority: 'high', extract_code: true,
      template: '【{sender}】{content}', archive: true, stop_processing: true,
      bark: { level: 'timeSensitive', group: '应用通知', auto_copy_code: true, deep_link: 'event' },
    },
  },
  {
    // 自己发出去的短信只归档不推送：给自己刚发的短信再推一遍验证码是荒谬的，
    // 但历史里要能查到「这条验证码我转给谁了」
    name: '已发送短信',
    priority: 95,
    match: { kind: ['sms'], direction: ['out'] },
    action: {
      priority: 'normal', extract_code: false,
      template: '→ {sender}：{content}', archive: true, stop_processing: true,
    },
  },
  {
    name: '来电',
    priority: 110,
    // 限定收到的：自己打出去的电话没必要再推一条通知回来
    match: { kind: ['call'], direction: ['in'] },
    action: {
      priority: 'normal', extract_code: false,
      template: '{content}：{sender}', archive: true, stop_processing: true,
      bark: { level: 'active', group: '来电', auto_copy_code: false, deep_link: 'compose' },
    },
  },
  {
    // 去电：自己拨出去的，只进通话记录，不推送——你本来就知道自己打了谁
    name: '去电',
    priority: 115,
    match: { kind: ['call'], direction: ['out'] },
    action: {
      priority: 'normal', extract_code: false,
      template: '{content}：{sender}', archive: true, stop_processing: true,
    },
  },
]

/** 只归档、不推送的规则。channels 必须保持为空，否则「只归档」就失效了。 */
const ARCHIVE_ONLY = new Set(['广告推广', '已发送短信', '去电'])

/** 展开为可直接求值的规则。channels 由调用方注入。 */
export function buildSeedRules(channelIds: string[], idFor: (i: number) => string): Rule[] {
  return SEED_RULES.map((s, i) => {
    const action = RuleAction.parse(s.action)
    return {
      id: idFor(i),
      name: s.name,
      priority: s.priority,
      enabled: true,
      match: RuleMatch.parse(s.match),
      action: { ...action, channels: ARCHIVE_ONLY.has(s.name) ? [] : channelIds },
    }
  })
}

/**
 * 预置规则集的版本号。
 *
 * 加了新的预置规则就 +1。老部署在启动时按它补齐缺失的规则——否则
 * 「已发送短信只归档不推送」这类新语义只对新装的人生效，老用户会
 * 莫名其妙地收到自己发出去的短信的推送。
 */
export const SEED_RULES_VERSION = 4

/**
 * 相对现有规则缺了哪几条预置规则。
 *
 * 按**名字**判断存在与否：id 是随机的，名字才是用户认得出的东西。
 * 只补不改——用户改过的同名规则原样保留。
 */
export function missingSeedRules(
  existingNames: Iterable<string>,
  channelIds: string[],
  idFor: (i: number) => string,
): Rule[] {
  const have = new Set(existingNames)
  return buildSeedRules(channelIds, idFor).filter((r) => !have.has(r.name))
}

/**
 * 老规则缺失的 direction 该补成什么。
 *
 * direction 这个字段是后加的，在它之前建的规则存的是「不限制方向」——
 * 于是一条自己发出去的、正文里带「验证码」三个字的短信，会先命中优先级 10 的
 * 「验证码」规则并被高优先级推回来，根本轮不到优先级 95 的「已发送短信」。
 *
 * 这里只认**名字还是预置名、且整个 direction 键都不存在**的规则：
 * 那说明它是在这个字段存在之前建的，补上的正是预置规则一直以来的本意。
 * 用户自己改过方向（哪怕改成空数组）的一律不动。
 */
export function missingDirection(name: string, match: Record<string, unknown>): ('in' | 'out')[] | null {
  if ('direction' in match) return null
  const seed = SEED_RULES.find((s) => s.name === name)
  if (!seed) return null
  const want = (seed.match as { direction?: ('in' | 'out')[] }).direction
  return want && want.length > 0 ? want : null
}
