/**
 * 同一条连接上的帧必须**按到达顺序串行处理**。
 *
 * 原来每个帧各起一个 `void (async () => …)()`，互不相干地并发跑。单帧看不出
 * 问题，补传时一批 50 条同时在飞，落库顺序就与到达顺序无关了——协议约定
 * 「补传按 occurred_at 升序」，Agent 那头确实是升序发的，到了这头又乱了。
 *
 * 连带最难发现的一处：`pipeline.ts` 的 `isSmsEcho` 要查「同设备 30 秒内有没有
 * 对应的短信事件」来压掉短信应用的通知回声。短信与它的回声在同一批里并发
 * 处理时，查的那一刻另一条可能还没落库，于是同一条验证码推两遍。
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { createCipher, generateDek, hashToken } from '../../../core/crypto.js'
import { encodeFrame, makeFrame } from '../../../core/frames.js'
import { MemoryHub, MemoryStore } from '../../../core/__tests__/fakes.js'
import { createWsServer } from '../wsserver.js'
import type { StoredEvent } from '../../../core/store.js'

const DEVICE = 'dev_wsorder'
const TOKEN = 'tok_wsorder_0123456789'

/** 第一条落库故意慢，后面的快——不串行的话顺序必然翻过来 */
class SlowFirstStore extends MemoryStore {
  n = 0
  override async insertEvent(e: StoredEvent) {
    this.n++
    await new Promise((r) => setTimeout(r, this.n === 1 ? 120 : 1))
    return super.insertEvent(e)
  }
}

let server: Server | null = null
afterEach(() => { server?.close(); server = null })

describe('WS 帧按连接串行', () => {
  it('落库顺序 = 到达顺序，哪怕前一条处理得更慢', async () => {
    const store = new SlowFirstStore()
    const cipher = await createCipher(generateDek())
    store.devices.set(DEVICE, {
      id: DEVICE, user_id: 'u1', name: 'A25', token_hash: await hashToken(TOKEN),
      status: 'offline', last_seen_at: null, battery: null, charging: null, net_json: null,
      location_enc: null, location_at: null, app_version: null, created_at: 0,
    } as never)

    const wss = createWsServer({ store, cipher, hub: new MemoryHub(), heartbeatSec: 3600, baseUrl: null })
    server = createServer()
    server.on('upgrade', (req, socket, head) => {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
    })
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
    const port = (server!.address() as AddressInfo).port

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    const acks: string[] = []
    ws.on('message', (d) => {
      const f = JSON.parse(d.toString()) as { type: string; payload: { acks?: { id: string }[] } }
      if (f.type === 'event_ack') for (const a of f.payload.acks ?? []) acks.push(a.id)
    })
    await new Promise((r) => ws.once('open', r))

    ws.send(encodeFrame(makeFrame('hello', {
      device_id: DEVICE, token: TOKEN, app_version: '0.1.0',
      android_sdk: 34, battery: 87, pending_count: 0,
    }, Date.now())))
    await new Promise((r) => setTimeout(r, 120))

    // 一口气灌三条，不等任何回执 —— 这正是补传的样子
    const ids = [0, 1, 2].map(() => `evt_${crypto.randomUUID()}`)
    for (const [i, id] of ids.entries()) {
      ws.send(encodeFrame(makeFrame('event', {
        id, device_id: DEVICE, kind: 'sms', from: '95533',
        content: `第 ${i} 条`, occurred_at: Date.now() - (3 - i) * 1000,
        sim_slot: 0, extra: {},
      }, Date.now())))
    }
    await new Promise((r) => setTimeout(r, 600))
    ws.close()

    expect([...store.events.keys()]).toEqual(ids)
    expect(acks).toEqual(ids)
  })
})
