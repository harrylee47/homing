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

/**
 * 归属列必须真的写进去。
 *
 * 这一组测试的来历：upsertChannel 与 upsertTask 的 INSERT 列清单漏了 user_id，
 * 而类型检查完全看不出来——`c.user_id` 在记录上存在、在接口里必填，
 * 只是 SQL 语句里没带上它。结果是新建的渠道 user_id 为空串：
 * 列表里查不到（作用域按 user_id 过滤）、推送永远发不出去，而且一声不吭。
 *
 * 逐条人工核对 SQL 一定会漏，所以改成写一条、读一条、断言归属还在。
 */
describe('每一种记录写进去之后归属还在', () => {
  const NOW = 1_800_000_000_000
  const U = 'usr_owner'

  it('渠道', async () => {
    const store = await migrate()
    await store.upsertChannel({
      id: 'ch1', user_id: U, type: 'webhook', name: 'x',
      config_enc: new Uint8Array([1]), enabled: true, created_at: NOW,
    })
    expect((await store.listChannels(U)).map((c) => c.id)).toEqual(['ch1'])
    expect(await store.listChannels('someone_else')).toEqual([])
  })

  it('规则', async () => {
    const store = await migrate()
    await store.upsertRule({
      id: 'r1', user_id: U, name: 'x', priority: 10, enabled: true,
      match_json: '{}', action_json: '{}', created_at: NOW,
    })
    expect((await store.listRules(U)).map((r) => r.id)).toEqual(['r1'])
    expect(await store.listRules('someone_else')).toEqual([])
  })

  it('计划任务', async () => {
    const store = await migrate()
    await store.upsertTask({
      id: 't1', user_id: U, name: '保号', enabled: true, device_id: 'd',
      to_number: '138', content_enc: new Uint8Array([1]), sim_slot: null,
      schedule_json: '{"type":"daily","time":"09:00"}',
      last_run_at: null, last_status: null, fail_count: 0, created_at: NOW,
    })
    expect((await store.listTasks(U)).map((t) => t.id)).toEqual(['t1'])
    expect(await store.listTasks('someone_else')).toEqual([])
  })

  it('消息', async () => {
    const store = await migrate()
    // events.device_id 有外键约束，先把设备建出来
    await store.createDevice({
      id: 'd', user_id: U, name: 'd', token_hash: 'h', status: 'offline',
      last_seen_at: null, battery: null, charging: null, net_json: null,
      location_enc: null, location_at: null, app_version: null, created_at: NOW,
    })
    await store.insertEvent({
      id: 'evt1', user_id: U, device_id: 'd', kind: 'sms', direction: 'in', sim_slot: null,
      sender_enc: new Uint8Array([1]), content_enc: new Uint8Array([1]), enc_ver: 1,
      occurred_at: NOW, received_at: NOW, matched_rules: null, created_at: NOW,
    })
    expect((await store.listEvents({ user_id: U, limit: 10, offset: 0 })).map((e) => e.id)).toEqual(['evt1'])
    expect(await store.listEvents({ user_id: 'someone_else', limit: 10, offset: 0 })).toEqual([])
  })

  it('发送记录', async () => {
    const store = await migrate()
    await store.createOutbound({
      id: 'cmd1', user_id: U, device_id: 'd', to_number: '138',
      content_enc: new Uint8Array([1]), sim_slot: null,
      status: 'pending', error: null, created_at: NOW, updated_at: NOW,
    })
    expect((await store.listOutbound(10, 0, { user_id: U })).map((o) => o.id)).toEqual(['cmd1'])
    expect(await store.listOutbound(10, 0, { user_id: 'someone_else' })).toEqual([])
  })

  it('会话', async () => {
    const store = await migrate()
    await store.createSession({
      token_hash: 'h', user_id: U, ua_hash: '', ip_prefix: '',
      created_at: NOW, expires_at: NOW + 1000, revoked: false, trusted: false,
    })
    expect((await store.getSession('h'))!.user_id).toBe(U)
    // 全端下线只动自己的：别人的会话不该被这一下带走
    await store.revokeAllSessions('someone_else')
    expect((await store.getSession('h'))!.revoked).toBe(false)
    await store.revokeAllSessions(U)
    expect((await store.getSession('h'))!.revoked).toBe(true)
  })
})
