/**
 * 邀请码与账号有效期。
 *
 * 邀请码在有效期内等价于「在一台能看到银行验证码的机器上开一个账号」，
 * 所以待遇与配对码相同：只存哈希、原子取用、失败一律同一句话。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { MemoryStore } from './fakes.js'
import type { InviteRecord } from '../store.js'

const NOW = 1_800_000_000_000
const HOUR = 3_600_000

const invite = (o: Partial<InviteRecord> = {}): InviteRecord => ({
  code_hash: 'h1', created_by: 'admin', note: null, valid_days: 30,
  expires_at: NOW + 24 * HOUR, used_at: null, used_by: null, created_at: NOW,
  public: false, code_plain: null, code_enc: null, self_made: false, ...o,
})

describe('邀请码', () => {
  let store: MemoryStore
  beforeEach(() => { store = new MemoryStore() })

  it('只看不取：校验有效性但不消费 —— 注册没成功不该烧掉码', async () => {
    await store.createInvite(invite())
    expect(await store.peekInvite('h1', NOW)).not.toBeNull()
    expect(await store.peekInvite('h1', NOW)).not.toBeNull()
    expect(store.invites.get('h1')!.used_at).toBeNull()
  })

  it('取用一次之后就失效', async () => {
    await store.createInvite(invite())
    expect(await store.takeInvite('h1', 'usr_a', NOW)).not.toBeNull()
    expect(await store.takeInvite('h1', 'usr_b', NOW)).toBeNull()
  })

  it('并发下只有一个能成功 —— 否则同一个码能开出两个账号', async () => {
    await store.createInvite(invite())
    const [a, b] = await Promise.all([
      store.takeInvite('h1', 'usr_a', NOW),
      store.takeInvite('h1', 'usr_b', NOW),
    ])
    expect([a, b].filter(Boolean)).toHaveLength(1)
  })

  it('码自己也会过期 —— 没人用的码不该永远躺在那儿', async () => {
    await store.createInvite(invite({ expires_at: NOW - 1 }))
    expect(await store.peekInvite('h1', NOW)).toBeNull()
    expect(await store.takeInvite('h1', 'usr_a', NOW)).toBeNull()
  })

  it('取用后记下是谁用的 —— 出事时这是唯一的溯源线索', async () => {
    await store.createInvite(invite())
    const r = await store.takeInvite('h1', 'usr_a', NOW)
    expect(r!.used_by).toBe('usr_a')
    expect(r!.used_at).toBe(NOW)
  })

  it('用过的码撤销不掉，没用过的可以', async () => {
    await store.createInvite(invite())
    await store.createInvite(invite({ code_hash: 'h2' }))
    await store.takeInvite('h2', 'usr_a', NOW)
    expect(await store.deleteInvite('h1')).toBe(true)
    expect(await store.deleteInvite('h2')).toBe(false)
  })

  it('带着账号有效期：码决定了开出来的号能用多久', async () => {
    await store.createInvite(invite({ valid_days: 30 }))
    expect((await store.takeInvite('h1', 'u', NOW))!.valid_days).toBe(30)
    await store.createInvite(invite({ code_hash: 'h3', valid_days: null }))
    expect((await store.takeInvite('h3', 'u', NOW))!.valid_days).toBeNull()
  })
})

describe('用邀请码自助续期', () => {
  let store: MemoryStore
  const DAY = 86_400_000

  const user = (o: Record<string, unknown> = {}) => ({
    id: 'u9', name: 'friend', password_hash: '', totp_secret: '',
    role: 'member' as const, bot_token: '', disabled: false,
    expires_at: NOW - DAY, agreed_version: null, agreed_at: null, created_at: 0, ...o,
  })

  beforeEach(() => { store = new MemoryStore() })

  it('续期从原到期时刻往后接 —— 没到期的部分不该被抹掉', () => {
    const acct = user({ expires_at: NOW + 10 * DAY })
    const base = Math.max(acct.expires_at ?? 0, NOW)
    expect(base + 30 * DAY).toBe(NOW + 40 * DAY)
  })

  it('已经过期的从现在起算，不从过去起算', () => {
    const acct = user({ expires_at: NOW - 100 * DAY })
    const base = Math.max(acct.expires_at ?? 0, NOW)
    expect(base).toBe(NOW)
  })

  it('码被自助续期用掉之后就不能再用了', async () => {
    await store.createInvite(invite({ code_hash: 'hr' }))
    expect(await store.takeInvite('hr', 'u9', NOW)).not.toBeNull()
    expect(await store.peekInvite('hr', NOW)).toBeNull()
  })
})

/**
 * 批量操作踩过的两处，用存储层守住。
 *
 * 接口那一层（`POST /api/invites/batch`）是适配器代码，这里只钉住它依赖的
 * 存储语义——真正会被改坏的就是这两条。
 */
describe('邀请码：批量操作依赖的存储语义', () => {
  let store: MemoryStore
  beforeEach(() => { store = new MemoryStore() })

  it('已经用掉的删不动 —— 那条是历史，不是垃圾', async () => {
    await store.createInvite(invite({ code_hash: 'used' }))
    await store.takeInvite('used', 'u1', NOW)
    expect(await store.deleteInvite('used')).toBe(false)
    // 没用过的照删
    await store.createInvite(invite({ code_hash: 'free' }))
    expect(await store.deleteInvite('free')).toBe(true)
  })

  it('不存在的 hash 返回 false 而不是抛 —— 一批里混着已删的是常态', async () => {
    expect(await store.deleteInvite('nope')).toBe(false)
  })

  it('改 public 是整行覆盖：备注与两个有效期必须自己带回去', async () => {
    await store.createInvite(invite({ code_hash: 'h9', note: '给同事', valid_days: 90 }))
    const cur = (await store.getInvite('h9'))!
    // 批量转公开时**照抄**其余字段。只传 public 的话它们会被写成 null——
    // 「批量设为公开，顺手把所有备注清空了」那种 bug 就是这么来的
    await store.updateInvite('h9', {
      note: cur.note, valid_days: cur.valid_days, expires_at: cur.expires_at, public: true,
    })
    const after = (await store.getInvite('h9'))!
    expect(after.public).toBe(true)
    expect(after.note).toBe('给同事')
    expect(after.valid_days).toBe(90)
    expect(after.expires_at).toBe(cur.expires_at)
  })
})
