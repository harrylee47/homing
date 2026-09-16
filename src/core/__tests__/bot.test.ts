import { beforeEach, describe, expect, it, vi } from 'vitest'
import { handleCallback, handleCommand, handleReply, resetPendingSends, type BotApi } from '../bot.js'

const EVENTS = [
  { id: 'evt_1', from: '95533', content: '【建设银行】您的验证码是 902431，请勿泄露', kind: 'sms', occurred_at: 1_700_000_000_000 },
  { id: 'evt_2', from: '10086', content: '您的话费余额为 32.50 元', kind: 'sms', occurred_at: 1_700_000_100_000 },
]

const OUTBOUND = [
  { id: 'cmd_1', to: '13800138000', text: '保号测试 902431', status: 'delivered', error: null, created_at: 1_700_000_200_000 },
  { id: 'cmd_2', to: '13900139000', text: '你好', status: 'failed', error: '无信号', created_at: 1_700_000_300_000 },
]

const TWO_DEVICES = [
  { id: 'dev_jp', name: '日本卡', status: 'online', last_seen_at: Date.now(), battery: 80 },
  { id: 'dev_cn', name: '国内卡', status: 'online', last_seen_at: Date.now(), battery: 60 },
]

const makeApi = (over: Partial<BotApi> = {}): BotApi => ({
  stats: async () => ({
    devices: [{ id: 'dev_1', name: 'JP-Gateway-01', status: 'online', last_seen_at: Date.now() - 12_000, battery: 87 }],
    today: { events: 24, outbound: 2, outbound_failed: 0 },
    rules: 4, channels: 2,
  }),
  events: async ({ q, from, kind }) => {
    let list = EVENTS
    if (q) list = list.filter((e) => e.content.includes(q))
    if (from) list = list.filter((e) => e.from.includes(from))
    if (kind) list = list.filter((e) => e.kind === kind)
    return { events: list, total: list.length }
  },
  outbound: async ({ limit = 10 }) => ({ outbound: OUTBOUND.slice(0, limit), total: OUTBOUND.length }),
  tasks: async () => ({ tasks: [{ name: '保号', enabled: true, schedule_text: '每 30 天', to: '138', next_run_at: 1_700_000_000_000, fail_count: 0 }] }),
  rules: async () => ({ rules: [{ name: '验证码', priority: 10, enabled: true }] }),
  sendSms: async () => ({ id: 'cmd_1', status: 'pending' }),
  lookupRef: async (ref) => (ref === '555' ? { sender: '95533', device_id: 'dev_1', event_id: 'evt_1' } : null),
  isKnownNumber: async (n) => n === '95533',
  ...over,
})

describe('Bot 命令', () => {
  it('非命令消息不响应', async () => {
    expect(await handleCommand(makeApi(), '你好')).toBeNull()
  })

  it('/help 列出命令', async () => {
    const r = await handleCommand(makeApi(), '/help')
    expect(r!.text).toContain('/status')
    expect(r!.text).toContain('引用回复')
  })

  it('群组里带 @botname 后缀的命令也能识别', async () => {
    const r = await handleCommand(makeApi(), '/status@my_gateway_bot')
    expect(r!.text).toContain('JP-Gateway-01')
  })

  it('/status 显示设备、心跳、电量与今日统计', async () => {
    const r = await handleCommand(makeApi(), '/status')
    expect(r!.text).toContain('JP-Gateway-01')
    expect(r!.text).toContain('87%')
    expect(r!.text).toContain('今日事件 24')
  })

  it('未知命令给出提示而不是静默', async () => {
    expect((await handleCommand(makeApi(), '/nope'))!.text).toContain('未知命令')
  })

  it('/rules 只读，明确提示改用控制台', async () => {
    const r = await handleCommand(makeApi(), '/rules')
    expect(r!.text).toContain('只读')
  })
})

describe('Bot 输出必须模糊化', () => {
  it('/recent 的正文包在 spoiler 里', async () => {
    const r = await handleCommand(makeApi(), '/recent')
    expect(r!.text).toContain('<tg-spoiler>')
    // 验证码不得出现在任何 spoiler 之外的位置
    const outside = r!.text.split(/<tg-spoiler>.*?<\/tg-spoiler>/gs).join('')
    expect(outside).not.toContain('902431')
  })

  it('/search 的正文同样包在 spoiler 里 —— 这是最容易漏的一处', async () => {
    const r = await handleCommand(makeApi(), '/search 验证码')
    expect(r!.text).toContain('<tg-spoiler>')
    const outside = r!.text.split(/<tg-spoiler>.*?<\/tg-spoiler>/gs).join('')
    expect(outside).not.toContain('902431')
  })

  it('发件人可以明文，用于辨认来源', async () => {
    expect((await handleCommand(makeApi(), '/recent'))!.text).toContain('95533')
  })

  it('HTML 被转义，正文无法破坏消息结构', async () => {
    const api = makeApi({
      events: async () => ({ events: [{ id: 'e', from: '<b>x</b>', content: '<script>alert(1)</script>', kind: 'sms', occurred_at: 0 }], total: 1 }),
    })
    const r = await handleCommand(api, '/recent')
    expect(r!.text).not.toContain('<script>')
    expect(r!.text).toContain('&lt;script&gt;')
  })

  it('新号码确认提示里的正文也进 spoiler', async () => {
    const r = await handleCommand(makeApi(), '/send 13800138000 我的密码是 abc')
    expect(r!.text).toContain('<tg-spoiler>')
  })
})

describe('/send', () => {
  it('参数不全给用法提示', async () => {
    expect((await handleCommand(makeApi(), '/send'))!.text).toContain('用法')
    expect((await handleCommand(makeApi(), '/send 138'))!.text).toContain('用法')
  })

  it('已知号码直接发送', async () => {
    const sendSms = vi.fn(async () => ({ id: 'c', status: 'pending' }))
    const r = await handleCommand(makeApi({ sendSms }), '/send 95533 收到')
    expect(sendSms).toHaveBeenCalledWith('dev_1', '95533', '收到')
    expect(r!.text).toContain('已提交发送')
  })

  it('新号码需要二次确认，不直接发出', async () => {
    const sendSms = vi.fn(async () => ({ id: 'c', status: 'pending' }))
    const r = await handleCommand(makeApi({ sendSms }), '/send 13900139000 你好')
    expect(sendSms).not.toHaveBeenCalled()
    expect(r!.buttons).toBeDefined()
    expect(r!.text).toContain('不在历史记录中')
  })

  it('多设备时即使是已知号码也要先选设备 —— 用错卡等于用错身份', async () => {
    const sendSms = vi.fn(async () => ({ id: 'c', status: 'pending' }))
    const api = makeApi({
      sendSms,
      stats: async () => ({ devices: TWO_DEVICES, today: { events: 0, outbound: 0, outbound_failed: 0 }, rules: 0, channels: 0 }),
    })
    const r = await handleCommand(api, '/send 95533 收到')
    expect(sendSms).not.toHaveBeenCalled()
    expect(r!.buttons!.flat().map((b) => b.text)).toEqual(
      expect.arrayContaining(['用 日本卡 发送', '用 国内卡 发送', '取消']),
    )
  })

  it('选定设备后用那台发，不是随便挑一台', async () => {
    const sendSms = vi.fn(async () => ({ id: 'c', status: 'pending' }))
    const api = makeApi({
      sendSms,
      stats: async () => ({ devices: TWO_DEVICES, today: { events: 0, outbound: 0, outbound_failed: 0 }, rules: 0, channels: 0 }),
    })
    const prompt = await handleCommand(api, '/send 95533 收到')
    const cnBtn = prompt!.buttons!.flat().find((b) => b.text.includes('国内卡'))!
    const r = await handleCallback(api, cnBtn.data)
    expect(sendSms).toHaveBeenCalledWith('dev_cn', '95533', '收到', null)
    expect(r!.text).toContain('国内卡')
  })

  it('没有在线设备时明确告知', async () => {
    const api = makeApi({
      stats: async () => ({ devices: [], today: { events: 0, outbound: 0, outbound_failed: 0 }, rules: 0, channels: 0 }),
    })
    expect((await handleCommand(api, '/send 95533 x'))!.text).toContain('没有在线设备')
  })

  it('内容里的空格与换行完整保留', async () => {
    const sendSms = vi.fn(async () => ({ id: 'c', status: 'pending' }))
    await handleCommand(makeApi({ sendSms }), '/send 95533 第一行 还有 空格')
    expect(sendSms).toHaveBeenCalledWith('dev_1', '95533', '第一行 还有 空格')
  })
})

describe('确认按钮回调', () => {
  beforeEach(() => resetPendingSends())

  it('确认后真正发送，中文内容往返正确', async () => {
    const sendSms = vi.fn(async () => ({ id: 'c', status: 'pending' }))
    const api = makeApi({ sendSms })
    const prompt = await handleCommand(api, '/send 13900139000 你好世界')
    const data = prompt!.buttons![0]![0]!.data
    const r = await handleCallback(api, data)
    expect(sendSms).toHaveBeenCalledWith('dev_1', '13900139000', '你好世界', null)
    expect(r!.text).toContain('已提交发送')
  })

  it('callback_data 不超过 Telegram 的 64 字节上限', async () => {
    const prompt = await handleCommand(makeApi(), `/send 13900139000 ${'很长的内容'.repeat(50)}`)
    for (const b of prompt!.buttons!.flat()) {
      expect(new TextEncoder().encode(b.data).length).toBeLessThanOrEqual(64)
    }
  })

  it('过期的待发消息不会被发出', async () => {
    const sendSms = vi.fn(async () => ({ id: 'c', status: 'pending' }))
    const api = makeApi({ sendSms })
    const prompt = await handleCommand(api, '/send 13900139000 你好')
    const data = prompt!.buttons![0]![0]!.data
    const r = await handleCallback(api, data, Date.now() + 10 * 60_000)
    expect(sendSms).not.toHaveBeenCalled()
    expect(r!.text).toContain('过期')
  })

  it('同一个确认不能重复点击发两次', async () => {
    const sendSms = vi.fn(async () => ({ id: 'c', status: 'pending' }))
    const api = makeApi({ sendSms })
    const prompt = await handleCommand(api, '/send 13900139000 你好')
    const data = prompt!.buttons![0]![0]!.data
    await handleCallback(api, data)
    await handleCallback(api, data)
    expect(sendSms).toHaveBeenCalledTimes(1)
  })

  it('选中的设备在点击时已离线则不发送', async () => {
    const sendSms = vi.fn(async () => ({ id: 'c', status: 'pending' }))
    let devices = TWO_DEVICES
    const api = makeApi({ sendSms, stats: async () => ({ devices, today: { events: 0, outbound: 0, outbound_failed: 0 }, rules: 0, channels: 0 }) })
    const prompt = await handleCommand(api, '/send 95533 收到')
    const cnBtn = prompt!.buttons!.flat().find((b) => b.text.includes('国内卡'))!
    devices = [TWO_DEVICES[0]!, { ...TWO_DEVICES[1]!, status: 'offline' }]
    const r = await handleCallback(api, cnBtn.data)
    expect(sendSms).not.toHaveBeenCalled()
    expect(r!.text).toContain('不在线')
  })

  it('取消不发送', async () => {
    const sendSms = vi.fn(async () => ({ id: 'c', status: 'pending' }))
    const r = await handleCallback(makeApi({ sendSms }), 'cancel')
    expect(sendSms).not.toHaveBeenCalled()
    expect(r!.text).toContain('已取消')
  })

  it('无法识别的回调数据被忽略', async () => {
    expect(await handleCallback(makeApi(), 'garbage')).toBeNull()
  })
})

describe('Reply 即回复', () => {
  it('引用短信推送后，内容作为短信发回原发件人', async () => {
    const sendSms = vi.fn(async () => ({ id: 'c', status: 'pending' }))
    const r = await handleReply(makeApi({ sendSms }), '555', '收到，谢谢')
    expect(sendSms).toHaveBeenCalledWith('dev_1', '95533', '收到，谢谢', null)
    expect(r!.text).toContain('已回复 95533')
  })

  it('引用的不是短信推送时返回 null，交回命令处理', async () => {
    // 例如用户引用了 /status 的输出再打一条命令
    expect(await handleReply(makeApi(), '999', '/status')).toBeNull()
  })

  it('发送失败时如实报错，不假装成功', async () => {
    const api = makeApi({ sendSms: async () => ({ id: '', status: 'failed', error: '设备离线' }) })
    expect((await handleReply(api, '555', 'x'))!.text).toContain('设备离线')
  })
})

describe('查询命令', () => {
  it('/from 按号码筛选', async () => {
    const r = await handleCommand(makeApi(), '/from 95533')
    expect(r!.text).toContain('95533')
    expect(r!.text).not.toContain('10086')
  })

  it('/from 支持指定条数', async () => {
    const events = vi.fn(async () => ({ events: EVENTS, total: 2 }))
    await handleCommand(makeApi({ events }), '/from 955 5')
    expect(events).toHaveBeenCalledWith(expect.objectContaining({ from: '955', limit: 5 }))
  })

  it('/from 参数缺失给用法提示', async () => {
    expect((await handleCommand(makeApi(), '/from'))!.text).toContain('用法')
  })

  it('/calls 只查来电', async () => {
    const events = vi.fn(async () => ({ events: [], total: 0 }))
    await handleCommand(makeApi({ events }), '/calls')
    expect(events).toHaveBeenCalledWith(expect.objectContaining({ kind: 'call' }))
  })

  it('/tasks 显示排期与下次执行', async () => {
    const r = await handleCommand(makeApi(), '/tasks')
    expect(r!.text).toContain('保号')
    expect(r!.text).toContain('每 30 天')
    expect(r!.text).toContain('只读')
  })

  it('结果被截断时明确告知总数', async () => {
    const events = vi.fn(async () => ({ events: EVENTS, total: 99 }))
    const r = await handleCommand(makeApi({ events }), '/recent 2')
    expect(r!.text).toContain('共 99 条')
    expect(r!.text).toContain('控制台')
  })

  it('所有列表命令的正文都在 spoiler 内', async () => {
    for (const cmd of ['/recent', '/search 验证码', '/from 95533', '/calls']) {
      const r = await handleCommand(makeApi(), cmd)
      if (!r || !r.text.includes('<tg-spoiler>')) continue
      const outside = r.text.split(/<tg-spoiler>.*?<\/tg-spoiler>/gs).join('')
      expect(outside).not.toContain('902431')
    }
  })

  it('/status 显示充电状态', async () => {
    const api = makeApi({
      stats: async () => ({
        devices: [{ id: 'd', name: 'JP', status: 'online', last_seen_at: Date.now(), battery: 95, charging: true }],
        today: { events: 0, outbound: 0, outbound_failed: 0 }, rules: 0, channels: 0,
      }),
    })
    expect((await handleCommand(api, '/status'))!.text).toContain('🔌 95%')
  })

  it('命令菜单覆盖全部主要命令', async () => {
    const { COMMANDS } = await import('../bot.js')
    const names = COMMANDS.map((c) => c.command)
    for (const c of ['status', 'recent', 'search', 'from', 'send', 'devices', 'tasks', 'rules', 'help']) {
      expect(names).toContain(c)
    }
    // Telegram 要求命令名全小写、不带斜杠
    for (const c of COMMANDS) expect(c.command).toMatch(/^[a-z_]+$/)
  })
})

describe('双卡：发送要选卡', () => {
  const dual = {
    id: 'dev_1', name: 'A25', status: 'online', last_seen_at: Date.now(), battery: 80,
    net: {
      type: 'cellular',
      sims: [
        { slot: 0, carrier: '中国移动', tail: '1234', signal: 3, default_sms: true },
        { slot: 1, carrier: '中国联通', tail: '8888', signal: 1 },
      ],
    },
  }
  const dualApi = (over: Partial<BotApi> = {}) => makeApi({
    stats: async () => ({
      devices: [dual] as never, today: { events: 0, outbound: 0, outbound_failed: 0 }, rules: 0, channels: 0,
    }),
    ...over,
  })

  it('哪怕只有一台设备、号码也熟，双卡时仍然要先问用哪张卡', async () => {
    const sendSms = vi.fn(async () => ({ id: 'c', status: 'pending' }))
    const r = await handleCommand(dualApi({ sendSms }), '/send 95533 收到')
    expect(sendSms).not.toHaveBeenCalled()
    const texts = r!.buttons!.flat().map((b) => b.text)
    expect(texts).toEqual(expect.arrayContaining(['SIM1 尾号1234', 'SIM2 尾号8888', '取消']))
  })

  it('选了哪张卡就用哪张发', async () => {
    const sendSms = vi.fn(async () => ({ id: 'c', status: 'pending' }))
    const api = dualApi({ sendSms })
    const prompt = await handleCommand(api, '/send 95533 收到')
    const btn = prompt!.buttons!.flat().find((b) => b.text.includes('SIM2'))!
    const r = await handleCallback(api, btn.data)
    expect(sendSms).toHaveBeenCalledWith('dev_1', '95533', '收到', 1)
    expect(r!.text).toContain('SIM2')
  })

  it('引用回复用原消息那张卡 —— 换张卡对方看到的就是陌生号码', async () => {
    const sendSms = vi.fn(async () => ({ id: 'c', status: 'pending' }))
    const api = dualApi({
      sendSms,
      lookupRef: async () => ({ sender: '95533', device_id: 'dev_1', event_id: 'evt_1', sim_slot: 1 }),
    })
    await handleReply(api, '555', '收到')
    expect(sendSms).toHaveBeenCalledWith('dev_1', '95533', '收到', 1)
  })

  it('/status 逐卡各报一份信号', async () => {
    const r = await handleCommand(dualApi(), '/status')
    expect(r!.text).toContain('SIM1 尾号1234')
    expect(r!.text).toContain('SIM2 尾号8888')
    expect(r!.text).toContain('很弱')
  })
})

describe('设备状态要说清楚为什么', () => {
  const wifiPhone = {
    id: 'dev_1', name: 'JP-Gateway-01', status: 'online', last_seen_at: Date.now(),
    battery: 72, charging: false,
    net: { wifi: true, type: 'wifi', ssid: 'loveyou5', carrier: 'SoftBank', signal: 4, online: true },
  }
  const withDevices = (devices: unknown[]) => makeApi({
    stats: async () => ({
      devices: devices as never, today: { events: 0, outbound: 0, outbound_failed: 0 }, rules: 0, channels: 0,
    }),
  })

  it('连着 WiFi 也要报 SIM 信号 —— 卡没信号时短信照样收不到', async () => {
    const r = await handleCommand(withDevices([wifiPhone]), '/status')
    expect(r!.text).toContain('信号')
    expect(r!.text).toContain('▮▮▮▮')
    expect(r!.text).toContain('loveyou5')
    expect(r!.text).toContain('SoftBank')
  })

  it('没在充电要明说，不能只在充电时才提', async () => {
    const r = await handleCommand(withDevices([wifiPhone]), '/status')
    expect(r!.text).toContain('72%')
    expect(r!.text).toContain('未充电')
  })

  it('信号弱要标出来', async () => {
    const weak = { ...wifiPhone, net: { ...wifiPhone.net, signal: 1 } }
    expect((await handleCommand(withDevices([weak]), '/status'))!.text).toContain('很弱')
  })

  it('/devices 与 /status 给的细节一样多', async () => {
    const r = await handleCommand(withDevices([wifiPhone]), '/devices')
    expect(r!.text).toContain('▮▮▮▮')
    expect(r!.text).toContain('未充电')
    expect(r!.text).toContain('SoftBank')
  })

  it('掉线设备报的是掉线前的状态，要标明', async () => {
    const off = { ...wifiPhone, status: 'offline' }
    expect((await handleCommand(withDevices([off]), '/status'))!.text).toContain('掉线前')
  })

  it('设备没上报网络时不编造', async () => {
    const bare = { id: 'd', name: 'x', status: 'online', last_seen_at: Date.now(), battery: null }
    const r = await handleCommand(withDevices([bare]), '/status')
    expect(r!.text).not.toContain('信号')
    expect(r!.text).not.toContain('%')
  })
})

describe('/sent 发送记录', () => {
  it('列出收件人、状态与失败原因', async () => {
    const r = await handleCommand(makeApi(), '/sent')
    expect(r?.text).toContain('→ 13800138000')
    expect(r?.text).toContain('✅ 已送达')
    expect(r?.text).toContain('❌ 失败')
    expect(r?.text).toContain('无信号')
  })

  it('正文进 spoiler —— 转发出去的内容一样可能有验证码', async () => {
    const r = await handleCommand(makeApi(), '/sent')
    expect(r?.text).toContain('<tg-spoiler>')
    expect(r?.text).not.toMatch(/💬 保号测试/)
  })

  it('没有记录时明说', async () => {
    const r = await handleCommand(makeApi({ outbound: async () => ({ outbound: [], total: 0 }) }), '/sent')
    expect(r?.text).toBe('还没有发送记录')
  })

  it('条数可指定且有上限', async () => {
    const spy = vi.fn(async () => ({ outbound: OUTBOUND, total: 2 }))
    await handleCommand(makeApi({ outbound: spy }), '/sent 99')
    expect(spy).toHaveBeenCalledWith({ limit: 30 })
  })
})

describe('搜索没覆盖全部历史时要说出来', () => {
  it('有结果时附一句提醒', async () => {
    const api = makeApi({ events: async () => ({ events: EVENTS, total: 2, exhausted: false }) })
    const r = await handleCommand(api, '/search 验证码')
    expect(r?.text).toContain('只搜了最近一段')
  })

  it('没结果时不能说成「没有这条消息」', async () => {
    const api = makeApi({ events: async () => ({ events: [], total: 0, exhausted: false }) })
    const r = await handleCommand(api, '/search 不存在的词')
    expect(r?.text).toContain('最近一段里没找到')
    expect(r?.text).toContain('更早的还没搜')
  })

  it('搜完了就不啰嗦', async () => {
    const api = makeApi({ events: async () => ({ events: EVENTS, total: 2, exhausted: true }) })
    const r = await handleCommand(api, '/search 验证码')
    expect(r?.text).not.toContain('只搜了最近一段')
  })
})
