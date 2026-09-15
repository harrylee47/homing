/**
 * 模拟 Agent：在真机接入前验证服务端链路。
 *   node scripts/sim-agent.mjs <device_id> <token> [ws://host:port/ws]
 */
import { randomUUID } from 'node:crypto'

const [deviceId, token, url = 'ws://127.0.0.1:8070/ws'] = process.argv.slice(2)
const frame = (type, payload) => JSON.stringify({ v: 1, type, msg_id: randomUUID(), ts: Date.now(), payload })

const ws = new WebSocket(url)
ws.onopen = () => {
  console.log('→ hello')
  ws.send(frame('hello', {
    device_id: deviceId, token, app_version: '0.1.0-sim',
    android_sdk: 34, battery: 87, pending_count: 0,
  }))
}

ws.onmessage = (ev) => {
  const f = JSON.parse(ev.data)
  console.log('←', f.type, JSON.stringify(f.payload).slice(0, 120))

  if (f.type === 'hello_ack') {
    const id = `evt_${randomUUID()}`
    console.log('→ event', id)
    ws.send(frame('event', {
      id, device_id: deviceId, kind: 'sms', from: '95533',
      content: '【建设银行】您的验证码是 123456，5 分钟内有效，请勿泄露。',
      occurred_at: Date.now() - 2000, sim_slot: 0, extra: {},
    }))
    // 立刻重发同一条，验证幂等
    setTimeout(() => { console.log('→ event（重发同一 id，验证幂等）'); ws.send(frame('event', {
      id, device_id: deviceId, kind: 'sms', from: '95533',
      content: '【建设银行】您的验证码是 123456，5 分钟内有效，请勿泄露。',
      occurred_at: Date.now() - 2000, sim_slot: 0, extra: {},
    })) }, 150)
    setTimeout(() => { ws.close(1000, 'done'); process.exit(0) }, 600)
  }
  if (f.type === 'ping') ws.send(frame('pong', { seq: f.payload.seq, battery: 87, pending_count: 0 }))
  if (f.type === 'hello_reject') { console.error('被拒绝:', f.payload); process.exit(1) }
}
ws.onerror = (e) => { console.error('连接错误', e.message ?? e); process.exit(1) }
