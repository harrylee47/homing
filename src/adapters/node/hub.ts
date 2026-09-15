/**
 * Node 适配层：内存连接表。
 *
 * 硬约束④允许的唯一进程内状态。Workers 版换成 Durable Object，
 * 届时需用 serializeAttachment / deserializeAttachment 在休眠后恢复元数据。
 */
import type { Connection, Hub } from '../../core/hub.js'
import { log } from '../../core/logging.js'
import type { DownstreamFrame } from '../../core/protocol.js'

export class MemoryHub implements Hub {
  private readonly conns = new Map<string, Connection>()

  register(conn: Connection): void {
    const prev = this.conns.get(conn.device_id)
    if (prev && prev !== conn) {
      // 同一设备重复连接：踢掉旧的。常见于 Agent 重连而服务端尚未感知断开。
      log.info('踢掉同设备的旧连接', { device_id: conn.device_id })
      prev.close(1000, 'replaced by new connection')
    }
    this.conns.set(conn.device_id, conn)
  }

  unregister(device_id: string, conn: Connection): void {
    // 仅当当前登记的就是这条连接时才删除，避免踢旧连接时误删新连接
    if (this.conns.get(device_id) === conn) this.conns.delete(device_id)
  }

  get(device_id: string): Connection | undefined {
    return this.conns.get(device_id)
  }

  onlineDevices(): string[] {
    return [...this.conns.keys()]
  }

  send(device_id: string, frame: DownstreamFrame): boolean {
    const c = this.conns.get(device_id)
    if (!c) return false
    c.send(frame)
    return true
  }
}
