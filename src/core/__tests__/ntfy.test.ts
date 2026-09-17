/**
 * ntfy 渠道。存在的理由是「安卓上也能点一下复制验证码」，
 * 所以这组用例盯的主要是 copy 动作按钮与主题名那条安全边界。
 */
import { describe, expect, it } from 'vitest'
import { NTFY_PRIORITY, NtfyConfig, NtfyOptions, ntfyProvider } from '../providers/ntfy.js'
import type { NotifyMessage } from '../providers/types.js'

const msg = (o: Partial<NotifyMessage> = {}): NotifyMessage => ({
  title: '95533', body: '【建设银行】验证码 123456', priority: 'normal',
  code: '123456', eventId: 'evt_abc', occurredAt: 0,
  consoleUrl: 'https://gw.example.com', ...o,
})

const CFG = { server: 'https://ntfy.sh', topic: 'homing-abcd1234' }

/** 拦下 fetch，把真正发出去的 JSON 与请求头取出来 */
const capture = async (
  options: Record<string, unknown> = {},
  over: Partial<NotifyMessage> = {},
  cfgOver: Record<string, unknown> = {},
) => {
  const orig = globalThis.fetch
  let sent: Record<string, unknown> = {}
  let headers: Record<string, string> = {}
  let url = ''
  globalThis.fetch = (async (u: string, init: { body: string; headers: Record<string, string> }) => {
    url = u
    headers = init.headers
    sent = JSON.parse(init.body) as Record<string, unknown>
    return { ok: true, status: 200, text: async () => '' }
  }) as unknown as typeof fetch
  try {
    await ntfyProvider.send({ ...CFG, ...cfgOver } as never, { ...msg(over), options: { ntfy: options } })
  } finally { globalThis.fetch = orig }
  return { sent, headers, url }
}

describe('主题名是凭证', () => {
  /**
   * 公共实例上，任何知道主题名的人都能订阅它，没有别的门。
   * 而这条通道里流的是银行验证码，所以短主题名等同于「口令是 abc」。
   */
  it('太短的主题名直接拒绝', () => {
    expect(NtfyConfig.safeParse({ ...CFG, topic: 'sms' }).success).toBe(false)
    expect(NtfyConfig.safeParse({ ...CFG, topic: 'homing12' }).success).toBe(true)
  })

  it('非法字符拒绝 —— ntfy 自己只认字母数字和 - _', () => {
    for (const bad of ['homing/code', 'homing code', 'homing.code', '主题名八个字啊']) {
      expect(NtfyConfig.safeParse({ ...CFG, topic: bad }).success, bad).toBe(false)
    }
  })

  it('不填服务端就走公共实例', () => {
    const r = NtfyConfig.parse({ topic: 'homing-abcd1234' })
    expect(r.server).toBe('https://ntfy.sh')
  })

  it('有 token 就带 Bearer，没有就不带这个头', async () => {
    expect((await capture({}, {}, { token: 'tk_secret' })).headers.authorization).toBe('Bearer tk_secret')
    expect('authorization' in (await capture()).headers).toBe(false)
  })
})

describe('复制按钮 —— 这条通道存在的理由', () => {
  it('默认带一个复制验证码的按钮，且排在第一个', async () => {
    const { sent } = await capture()
    const actions = sent.actions as { action: string; label: string; value?: string }[]
    expect(actions[0]).toMatchObject({ action: 'copy', label: '复制验证码', value: '123456' })
  })

  it('body 模式复制整条正文，按钮改叫「复制内容」', async () => {
    const { sent } = await capture({ copy_mode: 'body' })
    const actions = sent.actions as { action: string; value: string; label: string }[]
    expect(actions[0]!.value).toBe('【建设银行】验证码 123456')
  })

  it('none 模式没有复制按钮，但跳转按钮还在', async () => {
    const { sent } = await capture({ copy_mode: 'none' })
    const actions = sent.actions as { action: string }[]
    expect(actions.map((a) => a.action)).toEqual(['view'])
  })

  it('code 模式下没提取到码就不放这个按钮 —— 别给一个按了没反应的按钮', async () => {
    const { sent } = await capture({ copy_mode: 'code' }, { code: null })
    const actions = sent.actions as { action: string }[]
    expect(actions.some((a) => a.action === 'copy')).toBe(false)
  })

  it('按钮数不超过 3 个 —— ntfy 超了会整条拒收', async () => {
    const { sent } = await capture()
    expect((sent.actions as unknown[]).length).toBeLessThanOrEqual(3)
  })
})

describe('优先级与跳转', () => {
  it('默认档位是 default(3)', async () => {
    expect((await capture()).sent.priority).toBe(NTFY_PRIORITY.default)
  })

  /** 与 Bark 的 active→timeSensitive 是同一个判断：银行验证码半夜也得响 */
  it('规则标了高优先级且档位没动过，自动升到 max', async () => {
    expect((await capture({}, { priority: 'high' })).sent.priority).toBe(NTFY_PRIORITY.max)
  })

  it('用户显式选过档位就不再自动升 —— 他说了算', async () => {
    expect((await capture({ priority: 'low' }, { priority: 'high' })).sent.priority).toBe(NTFY_PRIORITY.low)
  })

  it('click 和 view 按钮指向同一处', async () => {
    const { sent } = await capture()
    const view = (sent.actions as { action: string; url?: string }[]).find((a) => a.action === 'view')
    expect(sent.click).toBe('https://gw.example.com/events/evt_abc')
    expect(view!.url).toBe(sent.click)
  })

  it('没配控制台地址就既没有 click 也没有跳转按钮', async () => {
    const { sent } = await capture({}, { consoleUrl: null })
    expect('click' in sent).toBe(false)
    expect((sent.actions as { action: string }[]).some((a) => a.action === 'view')).toBe(false)
  })

  it('不跳转模式下只剩复制按钮', async () => {
    const { sent } = await capture({ deep_link: 'none' })
    expect((sent.actions as { action: string }[]).map((a) => a.action)).toEqual(['copy'])
  })
})

describe('排版与配置', () => {
  it('标题是「谁发来的」，归属缀在后面，正文只放内容', async () => {
    const { sent } = await capture({}, { deviceName: '国内卡', sim: 'SIM1 · 尾号8000' })
    expect(sent.title).toBe('95533 · 国内卡 · SIM1 · 尾号8000')
    expect(sent.message).toBe('【建设银行】验证码 123456')
  })

  it('POST 到服务端根路径，topic 在 body 里', async () => {
    const { url, sent } = await capture()
    expect(url).toBe('https://ntfy.sh')
    expect(sent.topic).toBe('homing-abcd1234')
  })

  it('服务端地址尾部斜杠不会变成双斜杠', async () => {
    expect((await capture({}, {}, { server: 'https://n.example.com/' })).url).toBe('https://n.example.com')
  })

  it('没配图标就不带这个字段', async () => {
    expect('icon' in (await capture()).sent).toBe(false)
    expect((await capture({}, {}, { icon: 'https://gw.example.com/icon-192.png' })).sent.icon)
      .toBe('https://gw.example.com/icon-192.png')
  })

  it('没填标签就不带 tags —— 不要送一个空数组', async () => {
    expect('tags' in (await capture()).sent).toBe(false)
    expect((await capture({ tags: ['bank'] })).sent.tags).toEqual(['bank'])
  })

  it('选项默认值与 Bark 对齐，同一条规则在两个渠道上表现一致', () => {
    const o = NtfyOptions.parse({})
    expect(o.copy_mode).toBe('code')
    expect(o.deep_link).toBe('event')
  })
})
