import { describe, expect, it } from 'vitest'
import { buildText, TelegramConfig } from '../providers/telegram.js'
import type { NotifyMessage } from '../providers/types.js'

const msg = (o: Partial<NotifyMessage> = {}): NotifyMessage => ({
  title: '95533',
  body: '【建设银行】您的验证码是 902431，请勿泄露',
  priority: 'normal', code: '902431',
  eventId: 'evt_1', occurredAt: 1_700_000_000_000, ...o,
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
