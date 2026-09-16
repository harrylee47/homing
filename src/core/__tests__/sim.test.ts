import { describe, expect, it } from 'vitest'
import { simLabel, simShort, simsOf } from '../sim.js'

const two = JSON.stringify({
  wifi: true, type: 'wifi',
  sims: [
    { slot: 0, carrier: '中国移动', tail: '1234', signal: 3 },
    { slot: 1, carrier: '中国移动', tail: '8888', signal: 0 },
  ],
})
const one = JSON.stringify({ wifi: true, sims: [{ slot: 0, carrier: 'SoftBank' }] })

describe('SIM 展示', () => {
  it('只有一张卡时什么都不显示 —— 每条都缀 SIM1 是纯噪音', () => {
    expect(simShort(simsOf(one), 0)).toBe('')
    expect(simLabel(simsOf(one), 0)).toBe('')
  })

  it('双卡时标出是哪张', () => {
    expect(simShort(simsOf(two), 1)).toBe('SIM2')
  })

  it('尾号优先于运营商 —— 同一家运营商的两张卡写运营商名等于没说', () => {
    expect(simLabel(simsOf(two), 0)).toBe('SIM1 · 尾号1234')
    expect(simLabel(simsOf(two), 1)).toBe('SIM2 · 尾号8888')
  })

  it('没有尾号就退回运营商名', () => {
    const j = JSON.stringify({ sims: [{ slot: 0, carrier: 'A' }, { slot: 1, carrier: 'B' }] })
    expect(simLabel(simsOf(j), 1)).toBe('SIM2 · B')
  })

  it('卡槽未知时不显示', () => {
    expect(simLabel(simsOf(two), null)).toBe('')
    expect(simLabel(simsOf(two), undefined)).toBe('')
  })

  it('老设备没上报 sims 时安全降级', () => {
    expect(simsOf(null)).toEqual([])
    expect(simsOf('{"wifi":true}')).toEqual([])
  })

  it('脏数据不能把整个列表打挂', () => {
    expect(simsOf('这不是 JSON')).toEqual([])
    expect(simsOf('{"sims":"不是数组"}')).toEqual([])
    expect(simsOf('{"sims":[{"slot":99}]}')).toEqual([])
  })
})
