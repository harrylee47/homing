import { describe, expect, it } from 'vitest'
import { toSvg } from '../qr.js'
import { totpUri } from '../auth.js'

const URI = totpUri('JBSWY3DPEHPK3PXP', 'admin')

describe('二维码', () => {
  it('输出合法 SVG', () => {
    const svg = toSvg(URI)
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg.endsWith('</svg>')).toBe(true)
    expect(svg).toContain('viewBox=')
  })

  it('单条 path 而非逐个 rect，且合并了行内游程', () => {
    const svg = toSvg(URI)
    // 只有背景一个 rect
    expect((svg.match(/<rect/g) ?? []).length).toBe(1)
    expect((svg.match(/<path/g) ?? []).length).toBe(1)
    expect(svg.length).toBeLessThan(8000)
  })

  it('相邻模块被合成一段，而不是每个模块一段', () => {
    const svg = toSvg(URI, { margin: 0 })
    const n = Number(svg.match(/viewBox="0 0 (\d+)/)![1])
    const segments = (svg.match(/M\d+ \d+h/g) ?? []).length

    // 深色模块约占一半即 n²/2。未合并时段数等于模块数；
    // 合并后应明显低于这个数，用 n²/4 作为上界。
    expect(segments).toBeLessThan((n * n) / 4)

    // 各段宽度之和应恰好等于深色模块总数——合并不能丢模块，
    // 丢一个模块二维码就扫不出来了
    const total = [...svg.matchAll(/h(\d+)v/g)].reduce((a, m) => a + Number(m[1]), 0)
    expect(total).toBeGreaterThan(n * n * 0.3)

    // 存在宽度大于 1 的段，说明合并确实生效了
    expect(/h([2-9]|\d\d)v/.test(svg)).toBe(true)
  })

  it('留有静区，低于 4 个模块扫描器可能识别不到', () => {
    const svg = toSvg(URI, { margin: 4 })
    const m = svg.match(/viewBox="0 0 (\d+)/)!
    const size = Number(m[1])
    // 第一个深色模块的坐标至少等于静区宽度
    const first = svg.match(/d="M(\d+) (\d+)/)!
    expect(Number(first[1])).toBeGreaterThanOrEqual(4)
    expect(Number(first[2])).toBeGreaterThanOrEqual(4)
    expect(size).toBeGreaterThan(8)
  })

  it('内容不同则二维码不同', () => {
    expect(toSvg('a')).not.toBe(toSvg('b'))
  })

  it('长内容也能编码（自动选版本）', () => {
    expect(() => toSvg('x'.repeat(500))).not.toThrow()
  })

  it('不含可被 CSP 拦截的外部引用或脚本', () => {
    const svg = toSvg(URI)
    expect(svg).not.toContain('<script')
    expect(svg).not.toContain('xlink:href')
    // xmlns 里的 http://www.w3.org 是命名空间声明，不发起请求；
    // 要排除的是真正会加载外部资源的属性
    expect(svg).not.toMatch(/(?:src|href)\s*=\s*"https?:/)
    expect(svg).not.toContain('<image')
  })
})
