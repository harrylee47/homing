import { describe, expect, it } from 'vitest'
import { groupThreads, mergeThread, threadKey, type ThreadItem } from '../thread.js'

describe('会话归组', () => {
  it('同一个号码的几种写法归到一起 —— 手机上本来就是一条对话', () => {
    const a = threadKey('+8613800138000')
    expect(threadKey('8613800138000')).toBe(a)
    expect(threadKey('13800138000')).toBe(a)
    expect(threadKey('+86 138 0013 8000')).toBe(a)
  })

  it('不同的号码不会被归到一起', () => {
    expect(threadKey('+16463822860')).not.toBe(threadKey('+18124455341'))
    expect(threadKey('10086')).not.toBe(threadKey('10010'))
  })

  it('服务号与短号原样用 —— 它们本来就没有区号', () => {
    expect(threadKey('10086')).toBe('10086')
    expect(threadKey('800')).toBe('800')
  })

  it('纯字母的发件人按大小写无关的原串归组', () => {
    expect(threadKey('giffgaff')).toBe(threadKey('GiffGaff'))
    expect(threadKey('ソフトバンク')).toBe('ソフトバンク')
  })

  it('列表按最近一条排序，号码显示取最新那条的写法', () => {
    const g = groupThreads([
      { from: '13800138000', text: '早', at: 100, direction: 'in' },
      { from: '+8613800138000', text: '晚', at: 300, direction: 'out' },
      { from: '10086', text: '话费', at: 200, direction: 'in' },
    ])
    expect(g.map((x) => x.number)).toEqual(['+8613800138000', '10086'])
    expect(g[0]!.last_text).toBe('晚')
    expect(g[0]!.last_direction).toBe('out')
    expect(g[0]!.count).toBe(2)
  })
})

describe('会话时间线', () => {
  const item = (o: Partial<ThreadItem>): ThreadItem => ({
    id: 'x', direction: 'in', text: 'hi', at: 1000, source: 'event', ...o,
  })

  it('按时间升序 —— 对话是从上往下读的', () => {
    const r = mergeThread(
      [item({ id: 'a', at: 300 }), item({ id: 'b', at: 100 })],
      [item({ id: 'c', at: 200, direction: 'out', source: 'outbound' })],
    )
    expect(r.map((x) => x.id)).toEqual(['b', 'c', 'a'])
  })

  it('网关发的短信被手机又报一遍时只留一条', () => {
    const r = mergeThread(
      [item({ id: 'evt', at: 1005, direction: 'out', text: '保 号 短信' })],
      [item({ id: 'cmd', at: 1000, direction: 'out', text: '保号短信', source: 'outbound', status: 'delivered' })],
    )
    expect(r).toHaveLength(1)
    // 留下的是发送记录那条：它带着投递状态，信息更多
    expect(r[0]!.id).toBe('cmd')
    expect(r[0]!.status).toBe('delivered')
  })

  it('内容相同但隔了很久的两条是两条', () => {
    const r = mergeThread(
      [item({ id: 'evt', at: 1_000_000, direction: 'out', text: '收到' })],
      [item({ id: 'cmd', at: 1000, direction: 'out', text: '收到', source: 'outbound' })],
    )
    expect(r).toHaveLength(2)
  })

  it('收到的消息永远不会被当成重复删掉', () => {
    const r = mergeThread(
      [item({ id: 'evt', at: 1000, direction: 'in', text: '你好' })],
      [item({ id: 'cmd', at: 1000, direction: 'out', text: '你好', source: 'outbound' })],
    )
    expect(r).toHaveLength(2)
  })
})
