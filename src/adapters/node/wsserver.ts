/**
 * Node 适配层：WebSocket 服务端。
 *
 * 只负责收发字节、Origin 校验与心跳定时器，所有协议决策在 core/session.ts。
 */
import type { IncomingMessage } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import type { Cipher } from '../../core/crypto.js'
import type { Connection, Hub } from '../../core/hub.js'
import { encodeFrame, makeFrame } from '../../core/frames.js'
import { log } from '../../core/logging.js'
import type { AgentConfig, DownstreamFrame } from '../../core/protocol.js'
import { DeviceSession } from '../../core/session.js'
import type { Store } from '../../core/store.js'

export interface WsServerDeps {
  store: Store
  cipher: Cipher
  hub: Hub
  heartbeatSec: number
  baseUrl: string | null
  /** 查询类指令的结果回调 */
  onQueryResult?: ((cmdId: string, ok: boolean, detail: Record<string, unknown> | null, error: string | null) => void) | undefined
  /** 每次握手时生成下发给 Agent 的配置。按**设备主人**取——口令与捕获范围都是他自己的 */
  agentConfig?: ((userId: string) => Promise<AgentConfig>) | undefined
}

/**
 * Agent 是原生客户端，**从不发送 Origin 头**；浏览器则必发。
 *
 * 因此 /ws 上出现 Origin 就说明请求来自网页——而浏览器的同源策略不适用于
 * WebSocket，任何恶意页面的 JS 都能连上来。这里一律拒绝。
 * （计划 §11.6，ClawJacked 那类漏洞的成因。）
 */
export function isAllowedAgentOrigin(req: IncomingMessage): boolean {
  return req.headers.origin === undefined
}

export function createWsServer(deps: WsServerDeps): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true })

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const session = new DeviceSession({
      store: deps.store, cipher: deps.cipher, hub: deps.hub, baseUrl: deps.baseUrl,
      onQueryResult: deps.onQueryResult,
      loadConfig: deps.agentConfig,
    })
    let alive = true
    let seq = 0

    const conn: Connection = {
      get device_id() {
        return session.authenticatedDeviceId ?? ''
      },
      connected_at: Date.now(),
      send: (frame: DownstreamFrame) => ws.send(encodeFrame(frame)),
      close: (code: number, reason: string) => ws.close(code, reason),
    }

    // 心跳：服务端主动 ping，超时未见任何响应即断开（计划 §5.1）
    const timer = setInterval(() => {
      if (!alive) {
        log.warn('心跳超时，断开连接', { device_id: session.authenticatedDeviceId })
        ws.terminate()
        return
      }
      alive = false
      conn.send(makeFrame('ping', { seq: seq++ }) as DownstreamFrame)
    }, deps.heartbeatSec * 1000)

    ws.on('message', (data) => {
      alive = true
      void (async () => {
        const action = await session.handle(data.toString())
        for (const f of action.send) conn.send(f)
        if (action.close) {
          ws.close(action.close.code, action.close.reason)
          return
        }
        // 认证成功后才登记进 hub
        const id = session.authenticatedDeviceId
        if (id && deps.hub.get(id) !== conn) deps.hub.register(conn)
      })().catch((err) => {
        log.error('处理帧时异常', { error: String(err) })
      })
    })

    ws.on('close', () => {
      clearInterval(timer)
      const id = session.authenticatedDeviceId
      if (id) deps.hub.unregister(id, conn)
      void session.onDisconnect()
    })

    ws.on('error', (err) => log.warn('WS 连接错误', { error: String(err) }))

    log.debug('新连接', { ip: req.socket.remoteAddress })
  })

  return wss
}
