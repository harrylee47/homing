import { beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createCipher, generateDek, hashToken } from '../crypto.js'
import { registerProvider } from '../notifier.js'
import { DeviceSession } from '../session.js'
import { encodeFrame, makeFrame } from '../frames.js'
import { RuleAction, RuleMatch } from '../rules.js'
import { ProviderError, type NotifyMessage, type Provider } from '../providers/types.js'
import { MemoryHub, MemoryStore } from './fakes.js'

/**
 * 补传：Agent 攒了一批事件，重连时一口气灌上来（max_batch_size 默认 50）。
 *
 * 这一组用例守的是三件在单条事件下**完全看不出来**的事：
 * 推送不能并发、顺序不能乱、限流要真的等。
 */

const DEVICE = 'dev_backfill'
const TOKEN = 'tok_backfill_0123456789'
const NOW = 1_789_000_000_000

/** 进入 send 的顺序 */
const started: string[] = []
/**
 * **完成** send 的顺序。
 *
 * 断言必须用这个，不能用进入顺序——并发派发时进入顺序本来就是对的
 * （事件是一条条处理的），乱的是完成顺序，而用户感知到的正是后者。
 * 第一版用错了，撤掉修复照样绿。
 */
const finished: string[] = []
let inFlight = 0
let maxInFlight = 0
let sendDelayMs = 5
/** 让单条推送的耗时可以按内容变化——顺序用例靠它制造「后发先至」 */
let perBodyDelay: ((body: string) => number) | null = null

const stub: Provider<Record<string, never>> = {
  type: 'backfillstub',
  configSchema: z.object({}),
  async send(_c, msg: NotifyMessage) {
    inFlight++
    maxInFlight = Math.max(maxInFlight, inFlight)
    started.push(msg.body)
    await new Promise((r) => setTimeout(r, perBodyDelay ? perBodyDelay(msg.body) : sendDelayMs))
    finished.push(msg.body)
    inFlight--
  },
}
registerProvider(stub as unknown as Provider<never>)

/**
 * 进了黑洞的渠道：连得上、但永远不回。真实世界里是服务器挂了、域名被墙、
 * 反代把连接吊着——三次尝试各 15 秒超时加退避，一条要 48 秒。
 */
let deadDelayMs = 120
const dead: Provider<Record<string, never>> = {
  type: 'backfilldead',
  configSchema: z.object({}),
  async send() {
    await new Promise((r) => setTimeout(r, deadDelayMs))
    throw new ProviderError('backfilldead', '黑洞', false)
  },
}
registerProvider(dead as unknown as Provider<never>)

const authed = async (withDead = false) => {
  const store = new MemoryStore()
  const cipher = await createCipher(generateDek())
  store.devices.set(DEVICE, {
    id: DEVICE, user_id: 'u1', name: 'A25', token_hash: await hashToken(TOKEN),
    status: 'offline', last_seen_at: null, battery: null, charging: null, net_json: null,
    location_enc: null, location_at: null, app_version: null, created_at: NOW,
  })
  store.channels.set('ch_1', {
    id: 'ch_1', user_id: 'u1', type: 'backfillstub', name: 'ch_1',
    config_enc: await cipher.encrypt('{}'), enabled: true, created_at: 0,
  })
  const targets = ['ch_1']
  if (withDead) {
    store.channels.set('ch_dead', {
      id: 'ch_dead', user_id: 'u1', type: 'backfilldead', name: 'ch_dead',
      config_enc: await cipher.encrypt('{}'), enabled: true, created_at: 0,
    })
    targets.push('ch_dead')
  }
  store.rules.set('r_1', {
    id: 'r_1', user_id: 'u1', name: '全都推', priority: 1, enabled: true,
    match_json: JSON.stringify(RuleMatch.parse({})),
    action_json: JSON.stringify(RuleAction.parse({ channels: targets })),
    created_at: 0,
  })
  const session = new DeviceSession({ store, hub: new MemoryHub(), cipher, now: () => NOW })
  const ack = await session.handle(encodeFrame(makeFrame('hello', {
    device_id: DEVICE, token: TOKEN, app_version: '0.1.0',
    android_sdk: 34, battery: 87, pending_count: 0,
  }, NOW)))
  if (ack.send[0]?.type !== 'hello_ack') throw new Error(`握手没过: ${JSON.stringify(ack.send[0]?.payload)}`)
  return { session, store }
}

// 事件 id 必须是 evt_<uuid-v4>（协议里有正则），顺序断言靠正文承载
const eventFrame = (i: number) => encodeFrame(makeFrame('event', {
  id: `evt_${crypto.randomUUID()}`, device_id: DEVICE, kind: 'sms', from: '95533',
  // 正文里带序号，好断言顺序
  content: `第 ${String(i).padStart(2, '0')} 条`,
  occurred_at: NOW - (50 - i) * 60_000, sim_slot: 0, extra: {},
}, NOW))

describe('补传一批事件', () => {
  beforeEach(() => {
    started.length = 0
    finished.length = 0
    inFlight = 0
    maxInFlight = 0
    sendDelayMs = 5
    perBodyDelay = null
  })

  /**
   * 原来 session 里是 `void processEvent(...)`，一批 50 条 = 50 个同时在飞的推送。
   * 后果一是同一个 Telegram 私聊被 50 条同时打（稳吃 429），
   * 二是谁的网络先回来谁先到，验证码不按时间排。
   */
  it('推送逐条串行，同一时刻只有一条在飞', async () => {
    const { session } = await authed()
    // 模拟 wsserver 串行处理帧：一帧处理完再下一帧
    for (let i = 1; i <= 20; i++) await session.handle(eventFrame(i))
    // 等推送队列排空
    await new Promise((r) => setTimeout(r, 20 * sendDelayMs + 300))

    expect(finished).toHaveLength(20)
    expect(maxInFlight).toBe(1)
  })

  /**
   * 这条用例要能真的抓住回归，就不能让每条推送耗时相同——那样并发派发
   * 也会碰巧按序完成，断言就是空的（第一版正是如此，撤掉修复照样绿）。
   * 让**越靠后的事件响应越快**：不串行的话顺序必然翻过来。
   */
  it('推送顺序就是事件顺序 —— 补传的全部意义就是把那段时间按序补回来', async () => {
    const { session } = await authed()
    perBodyDelay = (body) => {
      const n = Number(body.replace(/\D/g, ''))
      return (21 - n) * 4
    }
    for (let i = 1; i <= 20; i++) await session.handle(eventFrame(i))
    await new Promise((r) => setTimeout(r, 20 * 20 * 4 + 500))

    expect(finished).toEqual(
      Array.from({ length: 20 }, (_, i) => `第 ${String(i + 1).padStart(2, '0')} 条`),
    )
  })

  /**
   * 一个渠道进黑洞，不能连累同一台设备上健康的那个。
   *
   * 原来推送串在「每台设备一条链」上，而那条链等的是 `dispatch` 全部返回——
   * 于是挂掉的渠道每重试一轮，这台手机上**所有人**的验证码就多等一轮。
   * 实测三次 15 秒超时加退避是 48 秒一条；哪怕渠道是「立刻拒绝」，
   * 退避的 1+2 秒也让一批 50 条的补传多花两分半。
   *
   * 修法是把顺序保证挪到 notifier 的每渠道串行链上，设备队列只串到
   * 「开始发网络请求」为止。这条用例就是钉住这件事的。
   */
  it('一个渠道进黑洞，健康渠道照常按序收完，不替它等', async () => {
    const { session } = await authed(true)
    deadDelayMs = 400
    const t0 = Date.now()
    for (let i = 1; i <= 8; i++) await session.handle(eventFrame(i))
    // 只给「健康渠道自己够用」的时间：8 × 5ms 远小于黑洞的 8 × 400ms。
    // 修复前这里只会收到 1～2 条。
    await new Promise((r) => setTimeout(r, 8 * sendDelayMs + 300))
    const elapsed = Date.now() - t0

    expect(finished).toEqual(
      Array.from({ length: 8 }, (_, i) => `第 ${String(i + 1).padStart(2, '0')} 条`),
    )
    // 健康渠道不该被黑洞的 8 × 400ms 拖着走
    expect(elapsed).toBeLessThan(8 * deadDelayMs)
    // 顺序仍然是按序的：串行保证没丢，只是换了个落点
    expect(maxInFlight).toBe(1)
  })

  it('一条推送抛异常也不能把整条链炸断 —— 断了之后这台设备就再也不推了', async () => {
    const { session } = await authed()
    let thrown = false
    const orig = stub.send.bind(stub)
    stub.send = async (c, msg) => {
      if (!thrown && msg.body.includes('05')) { thrown = true; throw new ProviderError('backfillstub', '炸一次', false) }
      return orig(c, msg)
    }
    try {
      for (let i = 1; i <= 10; i++) await session.handle(eventFrame(i))
      await new Promise((r) => setTimeout(r, 10 * sendDelayMs + 400))
    } finally {
      stub.send = orig
    }
    // 第 5 条失败，但第 6–10 条照样发出去了
    expect(finished).toContain('第 10 条')
  })
})
