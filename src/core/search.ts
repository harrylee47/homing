/**
 * 密文字段的分批检索。
 *
 * 号码与正文是加密入库的，SQL 搜不了，只能逐条解开再比对。逐条解密其实不贵
 * （实测 10 万条约 1 秒），真正的约束是「一次 HTTP 请求愿意花多久」。
 *
 * 所以这里不设「最多扫 N 条」的硬上限——那会让「几个月前那条」永远搜不到，
 * 而且用户看不出为什么。改成：分批往回扫，超时就停下，**如实报告扫到哪儿**，
 * 让界面能说「更早的还没搜」并提供继续搜的入口。
 *
 * 内存只按页算：命中一万条时也只留当前页那几十条。
 */

export interface ScanBudget {
  /** 跳过前多少条命中 */
  offset: number
  /** 当前页要多少条 */
  limit: number
  /** 每批从存储取多少行 */
  batch: number
  /** 时间预算（毫秒）。超了就停，剩下的交给下一次「继续搜」 */
  budgetMs: number
  /** 行数硬上限，防止病态数据集把一次请求拖垮 */
  rowCap: number
  /** 可注入，便于测试 */
  now?: () => number
}

export interface ScanResult<T> {
  /** 当前页命中项 */
  page: T[]
  /** 已找到的命中条数。exhausted=false 时它是「目前找到的」，不是总数 */
  total: number
  /** 实际扫过的行数 */
  scanned: number
  /** 是否已经扫到底。false 表示还有更早的数据没看 */
  exhausted: boolean
}

/**
 * @param fetchBatch 按 (offset, limit) 取一批**已解密**的条目，顺序必须稳定
 *                   （存储层要有确定的排序，否则翻页会重复或漏掉）
 * @param match      是否命中
 */
export async function scanMatches<T>(
  fetchBatch: (offset: number, limit: number) => Promise<T[]>,
  match: (item: T) => boolean,
  opts: ScanBudget,
): Promise<ScanResult<T>> {
  const now = opts.now ?? (() => Date.now())
  const startedAt = now()

  const page: T[] = []
  let total = 0
  let scanned = 0
  let exhausted = false

  while (true) {
    const rows = await fetchBatch(scanned, opts.batch)
    if (rows.length === 0) { exhausted = true; break }

    for (const item of rows) {
      if (!match(item)) continue
      // 只把落在当前页窗口里的留下来，命中再多也不会撑大内存
      if (total >= opts.offset && page.length < opts.limit) page.push(item)
      total++
    }

    scanned += rows.length
    // 取回的行数不足一批，说明后面没有了
    if (rows.length < opts.batch) { exhausted = true; break }
    if (scanned >= opts.rowCap || now() - startedAt > opts.budgetMs) break
  }

  // 因预算停下时，再探一行看看后面还有没有。
  // 不探的话，正好扫到边界（数据量恰是批量的整数倍）会报成「没搜完」，
  // 界面上就会出现「已经搜完了却让人点继续搜」这种自相矛盾的提示。
  if (!exhausted) {
    exhausted = (await fetchBatch(scanned, 1)).length === 0
  }

  return { page, total, scanned, exhausted }
}
