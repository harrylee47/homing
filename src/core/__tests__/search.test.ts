import { describe, expect, it, vi } from 'vitest'
import { scanMatches } from '../search.js'

/** 造 n 条数据，其中每 k 条命中一次。 */
const dataset = (n: number, k: number): number[] => Array.from({ length: n }, (_, i) => i)
const hitEvery = (k: number) => (x: number): boolean => x % k === 0

const fetchFrom = (rows: number[]) =>
  async (skip: number, take: number): Promise<number[]> => rows.slice(skip, skip + take)

const opts = (over: Partial<Parameters<typeof scanMatches>[2]> = {}) => ({
  offset: 0, limit: 10, batch: 100, budgetMs: 1000, rowCap: 100_000, ...over,
})

describe('密文检索的分批扫描', () => {
  it('扫到底时 total 就是准确的命中总数', async () => {
    const rows = dataset(1000, 1)
    const r = await scanMatches(fetchFrom(rows), hitEvery(10), opts())
    expect(r.exhausted).toBe(true)
    expect(r.total).toBe(100)
    expect(r.page).toEqual([0, 10, 20, 30, 40, 50, 60, 70, 80, 90])
  })

  it('翻页取的是命中项的第 n 页，不是原始行的第 n 页', async () => {
    const rows = dataset(1000, 1)
    const r = await scanMatches(fetchFrom(rows), hitEvery(10), opts({ offset: 10, limit: 5 }))
    expect(r.page).toEqual([100, 110, 120, 130, 140])
    expect(r.total).toBe(100)
  })

  it('命中很多时内存只留一页——这是这个实现存在的意义之一', async () => {
    const rows = dataset(50_000, 1)
    const r = await scanMatches(fetchFrom(rows), () => true, opts({ limit: 30 }))
    expect(r.page).toHaveLength(30)
    expect(r.total).toBe(50_000)
  })

  it('超时就停，并如实说没扫完', async () => {
    const rows = dataset(100_000, 1)
    // 每取一批「过去」20ms，预算 100ms → 大约 5 批之后停
    let clock = 0
    const r = await scanMatches(
      async (skip, take) => { clock += 20; return rows.slice(skip, skip + take) },
      hitEvery(10),
      opts({ budgetMs: 100, now: () => clock }),
    )
    expect(r.exhausted).toBe(false)
    expect(r.scanned).toBeLessThan(100_000)
    expect(r.scanned).toBeGreaterThan(0)
  })

  it('行数上限同样会停下，且不谎称扫完了', async () => {
    const rows = dataset(10_000, 1)
    const r = await scanMatches(fetchFrom(rows), hitEvery(10), opts({ rowCap: 500 }))
    expect(r.exhausted).toBe(false)
    expect(r.scanned).toBe(500)
    expect(r.total).toBe(50)
  })

  it('数据量正好等于上限时，要认出其实已经到底了', async () => {
    // 不额外探一行的话，这里会报「没搜完」，界面就会让用户去点一个没用的「继续搜」
    const rows = dataset(500, 1)
    const r = await scanMatches(fetchFrom(rows), hitEvery(10), opts({ rowCap: 500, batch: 100 }))
    expect(r.scanned).toBe(500)
    expect(r.exhausted).toBe(true)
  })

  it('数据正好是整批数时也要能判断出扫完了', async () => {
    // 边界：最后一批恰好取满，必须再取一次拿到空结果才敢说扫完
    const rows = dataset(200, 1)
    const fetch = vi.fn(fetchFrom(rows))
    const r = await scanMatches(fetch, hitEvery(10), opts({ batch: 100 }))
    expect(r.exhausted).toBe(true)
    expect(r.total).toBe(20)
    expect(fetch).toHaveBeenCalledTimes(3)   // 100 + 100 + 空批
  })

  it('一条数据都没有', async () => {
    const r = await scanMatches(fetchFrom([]), () => true, opts())
    expect(r).toMatchObject({ page: [], total: 0, scanned: 0, exhausted: true })
  })

  it('一条都不命中时也要扫完，不能提前收工', async () => {
    const rows = dataset(1000, 1)
    const r = await scanMatches(fetchFrom(rows), () => false, opts())
    expect(r.exhausted).toBe(true)
    expect(r.scanned).toBe(1000)
    expect(r.total).toBe(0)
  })

  it('翻到超出命中范围的页返回空页，但 total 仍然准确', async () => {
    const rows = dataset(1000, 1)
    const r = await scanMatches(fetchFrom(rows), hitEvery(10), opts({ offset: 500, limit: 10 }))
    expect(r.page).toEqual([])
    expect(r.total).toBe(100)
  })
})
