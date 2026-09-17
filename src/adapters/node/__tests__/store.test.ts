/**
 * 迁移必须能在**全新库**上跑通，而不只是在自己那台已经跑了半年的库上。
 *
 * 这不是假想的风险：`ALTER TABLE sessions ADD COLUMN trusted` 曾经排在
 * `CREATE TABLE sessions` 前面，老库因为表早就存在而一路绿灯，
 * 全新安装却在启动时直接报「no such table: sessions」——容器起不来，
 * 而装的人什么上下文都没有。升级路径天天在走，新装路径没人走。
 */
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { SqliteStore } from '../store.js'

const migrate = async (): Promise<SqliteStore> => {
  const store = new SqliteStore(':memory:')
  await store.migrate()
  return store
}

describe('数据库迁移', () => {
  it('全新库能跑通', async () => {
    await expect(migrate()).resolves.toBeDefined()
  })

  it('跑两遍也不报错 —— 每次启动都会跑一次', async () => {
    const store = await migrate()
    await expect(store.migrate()).resolves.toBeUndefined()
  })

  it('每张表都带归属列 —— 漏一张就是一条数据泄漏的路径', async () => {
    const store = await migrate()
    const db = new DatabaseSync(':memory:')
    void db
    for (const t of ['devices', 'events', 'channels', 'rules', 'tasks', 'outbound', 'sessions', 'message_refs', 'pairing_codes']) {
      const cols = (store as unknown as { db: DatabaseSync }).db
        .prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]
      expect(cols.map((c) => c.name), t).toContain('user_id')
    }
  })

  it('作用域真的生效：查不到别人的数据', async () => {
    const store = await migrate()
    const dev = (id: string, user: string) => ({
      id, user_id: user, name: id, token_hash: 'h', status: 'offline' as const,
      last_seen_at: null, battery: null, charging: null, net_json: null,
      location_enc: null, location_at: null, app_version: null, created_at: 0,
    })
    await store.createDevice(dev('a', 'u1'))
    await store.createDevice(dev('b', 'u2'))
    expect((await store.listDevices('u1')).map((d) => d.id)).toEqual(['a'])
    expect((await store.listAllDevices()).length).toBe(2)
    expect(await store.deleteDevice('b', 'u1')).toBe(false)
  })
})
