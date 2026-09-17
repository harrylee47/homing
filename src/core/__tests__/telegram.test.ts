import { describe, expect, it } from 'vitest'
import { buildText, TelegramConfig } from '../providers/telegram.js'
import type { NotifyMessage } from '../providers/types.js'

const msg = (o: Partial<NotifyMessage> = {}): NotifyMessage => ({
  title: '95533',
  body: '【建设银行】您的验证码是 902431，请勿泄露',
  kind: 'sms', direction: 'in', localTime: '2026-09-17 10:12:07',
  priority: 'normal', code: '902431',
  eventId: 'evt_1', occurredAt: 1_700_000_000_000, ...o,
})

describe('消息头部：归属信息逐行带标签，正文只放内容', () => {
  it('一条短信长这样', () => {
    expect(buildText(msg({ code: null, deviceName: 'A25-JP', sim: 'SIM1 · 尾号8868' }), false)).toBe(
      '📨 <b>新短信</b> · 2026-09-17 10:12:07\n' +
      '发件人: 95533\n' +
      'SIM: SIM1 · 尾号8868\n' +
      '设备: A25-JP\n' +
      '\n💬 【建设银行】您的验证码是 902431，请勿泄露',
    )
  })

  it('发件人只出现一次 —— 之前头部一次、模板里又一次', () => {
    const t = buildText(msg({ body: '正文', code: null }), false)
    expect(t.match(/95533/g)).toHaveLength(1)
  })

  it('单卡单设备时不出现 SIM 与设备行', () => {
    const t = buildText(msg({ code: null }), false)
    expect(t).not.toContain('SIM:')
    expect(t).not.toContain('设备:')
  })

  it('时间用传进来的本地时间，不自己算 —— 服务端在 UTC 容器里', () => {
    expect(buildText(msg({ code: null }), false)).toContain('2026-09-17 10:12:07')
  })

  it('来电与应用通知各有各的标签', () => {
    expect(buildText(msg({ kind: 'call', body: '未接来电', code: null }), false))
      .toContain('📞 <b>来电</b>')
    expect(buildText(msg({ kind: 'call', body: '未接来电', code: null }), false)).toContain('号码: 95533')
    expect(buildText(msg({ kind: 'notification', code: null }), false)).toContain('🔔 <b>应用通知</b>')
    expect(buildText(msg({ kind: 'notification', code: null }), false)).toContain('来源: 95533')
  })

  it('自己发出去的短信写「收件人」而不是「发件人」', () => {
    const t = buildText(msg({ direction: 'out', code: null }), false)
    expect(t).toContain('<b>已发送</b>')
    expect(t).toContain('收件人: 95533')
  })

  it('系统告警走另一套排版，且不模糊 —— 里面没有短信正文', () => {
    const t = buildText(msg({ alert: true, title: '⚠️ 设备离线', body: 'A25-JP 已离线 5 分钟', code: null }), true)
    expect(t).not.toContain('<tg-spoiler>')
    expect(t).toContain('<b>⚠️ 设备离线</b>')
    expect(t).not.toContain('发件人')
  })

  it('漏填 kind 时仍然模糊 —— 失手只能多模糊一条，不能明文泄漏', () => {
    const t = buildText({ ...msg(), kind: undefined }, true)
    expect(t).toContain('<tg-spoiler>')
  })
})

describe('Telegram 消息构造', () => {
  it('正文包在 tg-spoiler 里', () => {
    const t = buildText(msg(), true)
    expect(t).toContain('<tg-spoiler>')
    expect(t).toContain('</tg-spoiler>')
  })

  it('验证码不出现在 spoiler 之外 —— 否则 Bot 会被封', () => {
    const t = buildText(msg(), true)
    const before = t.slice(0, t.indexOf('<tg-spoiler>'))
    expect(before).not.toContain('902431')
  })

  it('正文也不出现在 spoiler 之外', () => {
    const t = buildText(msg(), true)
    const before = t.slice(0, t.indexOf('<tg-spoiler>'))
    expect(before).not.toContain('建设银行')
  })

  it('发件人可以明文 —— 旧系统如此，用于辨认来源', () => {
    expect(buildText(msg(), true)).toContain('95533')
  })

  it('HTML 实体被转义，避免注入破坏消息结构', () => {
    const t = buildText(msg({ body: '<b>x</b> & "y"', code: null }), true)
    expect(t).toContain('&lt;b&gt;x&lt;/b&gt; &amp; &quot;y&quot;')
    expect(t).not.toContain('<b>x</b>')
  })

  it('发件人中的 HTML 同样转义', () => {
    expect(buildText(msg({ title: '<script>' }), true)).toContain('&lt;script&gt;')
  })

  it('关闭 spoiler 时不加标签（仅供自建 Bot 等无封禁风险的场景）', () => {
    const t = buildText(msg(), false)
    expect(t).not.toContain('<tg-spoiler>')
    expect(t).toContain('902431')
  })

  it('无正文时只发头部', () => {
    const t = buildText(msg({ body: '', code: null }), true)
    expect(t).not.toContain('tg-spoiler')
    expect(t).toContain('95533')
  })

  it('spoiler 默认开启', () => {
    const cfg = TelegramConfig.parse({ bot_token: 'x'.repeat(30), chat_id: '1' })
    expect(cfg.spoiler).toBe(true)
  })
})

describe('多设备', () => {
  it('填了设备名就在 spoiler 外显示 —— 设备名不是敏感信息', () => {
    const t = buildText(msg({ deviceName: 'JP-Gateway-01' }), true)
    expect(t).toContain('设备: JP-Gateway-01')
    const before = t.slice(0, t.indexOf('<tg-spoiler>'))
    expect(before).toContain('JP-Gateway-01')
  })

  it('单设备场景不显示设备行', () => {
    expect(buildText(msg({ deviceName: null }), true)).not.toContain('设备:')
    expect(buildText(msg(), true)).not.toContain('设备:')
  })

  it('设备名同样转义', () => {
    expect(buildText(msg({ deviceName: '<b>x</b>' }), true)).toContain('&lt;b&gt;x&lt;/b&gt;')
  })
})
