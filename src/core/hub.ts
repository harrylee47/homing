/**
 * 连接管理接口。core 层只依赖此接口，不依赖 ws / Durable Object 任何一方。
 *
 * 硬约束④：进程内只允许保存连接表这一处状态，且必须能从存储重建。
 */
import type { DownstreamFrame } from './protocol.js'

/** 一条已认证的设备连接。 */
export interface Connection {
  readonly device_id: string
  /** 连接建立时刻 */
  readonly connected_at: number
  send(frame: DownstreamFrame): void
  close(code: number, reason: string): void
}

export interface Hub {
  /** 认证通过后登记。同一 device_id 再次连接时踢掉旧连接。 */
  register(conn: Connection): void
  unregister(device_id: string, conn: Connection): void
  get(device_id: string): Connection | undefined
  /** 当前在线的 device_id 列表。掉线检测与控制台首页依赖它。 */
  onlineDevices(): string[]
  /** 向指定设备下发。设备离线返回 false，调用方决定是否入队。 */
  send(device_id: string, frame: DownstreamFrame): boolean
}
