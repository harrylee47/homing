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

/**
 * 单条连接上允许积压的帧数上限。
 *
 * 取 200：一个补传批次最多 `max_batch_size`（默认 50，协议上限 200）条，
 * 留足一整批的余量。超了就是对面不按协议来。
 */
const MAX_QUEUED_FRAMES = 200

/** WebSocket 的协议错误关闭码（RFC 6455 §7.4.1）。 */
const CLOSE_PROTOCOL_ERROR = 1002

export function createWsServer(deps: WsServerDeps): WebSocketServer {
  /**
   * 单帧上限 2 MiB。
   *
   * ws 库默认 100 MiB——也就是说一台设备能一口气往这台小机器上灌 100 MB，
   * 而握手之前就能灌。这跟具体功能无关，是个一直存在的洞。
   *
   * 2 MiB 对现有最大的那条回执仍有余量：指纹列表上限 20000 条、
   * 每条约 50 字节，压满也就 1 MB 出头。
   */
  const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 })

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

    /**
     * 同一条连接上的帧**按到达顺序串行处理**。
     *
     * 原来是每个帧各起一个 `void (async () => …)()`，互不相干地并发跑。
     * 单帧进来时看不出问题，补传时就现形了：Agent 一批灌上来 50 条
     * （`max_batch_size`），50 个处理过程同时在飞，于是
     *
     * - **落库顺序与到达顺序无关**。协议约定「补传按 occurred_at 升序」，
     *   Agent 那头确实是升序发的，可到了这头又乱了；
     * - **推送顺序跟着乱**，用户在 Telegram 里看到的验证码不按时间排；
     * - **短信回声判不出来**（`pipeline.ts` 的 `isSmsEcho` 要查「同设备 30 秒内
     *   有没有对应的短信事件」）。短信和短信应用的通知在同一批里并发处理时，
     *   查的那一刻另一条可能还没落库，于是同一条验证码推两遍；
     * - 50 条同时派发给同一个 Telegram 私聊，稳吃 429。
     *
     * 串行化的代价几乎为零：单帧的处理是「解密 → 落库 → 回 ack」，都是本地
     * 操作；真正慢的推送本来就是脱钩的（session 那边 `onStored` 不 await）。
     * 心跳也不受影响——`alive` 在入队**之前**就置了。
     */
    let queue: Promise<void> = Promise.resolve()
    let depth = 0

    ws.on('message', (data) => {
      alive = true
      const raw = data.toString()

      /**
       * 队列深度兜底。
       *
       * 正常情况下深度不会超过一个补传批次：Agent 发完一批要等 ack 才发下一批。
       * 堆到这个数意味着对面在不按协议猛灌，再排下去就是拿内存换命——
       * 每个待处理的帧都攥着一份原始字符串（单帧上限 2MB）。
       */
      if (depth >= MAX_QUEUED_FRAMES) {
        log.error('帧积压超过上限，断开连接', {
          device_id: session.authenticatedDeviceId, depth,
        })
        ws.close(CLOSE_PROTOCOL_ERROR, 'too many queued frames')
        return
      }

      depth++
      queue = queue
        .then(async () => {
          const action = await session.handle(raw)
          for (const f of action.send) conn.send(f)
          if (action.close) {
            ws.close(action.close.code, action.close.reason)
            return
          }
          // 认证成功后才登记进 hub
          const id = session.authenticatedDeviceId
          if (id && deps.hub.get(id) !== conn) deps.hub.register(conn)
        })
        .catch((err: unknown) => {
          log.error('处理帧时异常', { error: String(err) })
        })
        .finally(() => { depth-- })
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
