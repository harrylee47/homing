/**
 * Bot 回复的分片。
 *
 * 这条链路上原本有两个坑叠在一起，合起来的表现是「用户什么都没收到，
 * 日志里也没有一行」：fetch 对 HTTP 400 是 resolve 不是 reject（所以
 * .catch 永远不触发），而 Telegram 单条上限 4096 字符、超了就 400。
 * /recent 30 很容易越线——中文银行短信普遍 60–120 字，每条还要加上
 * 26 个字符的 <tg-spoiler> 标签。
 */
import { describe, expect, it } from 'vitest'
import { splitForTelegram } from '../bot.js'

describe('长回复分片', () => {
  it('短消息原样返回一片，不做任何切分', () => {
    expect(splitForTelegram('短短的一条')).toEqual(['短短的一条'])
  })

  it('超长时切成多片，每片都不超上限', () => {
    const line = '95533 09-17 13:41\n💬 <tg-spoiler>【建设银行】您的验证码是 902431，5 分钟内有效。</tg-spoiler>'
    const parts = splitForTelegram(Array(80).fill(line).join('\n'), 500)
    expect(parts.length).toBeGreaterThan(1)
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(500)
  })

  /**
   * 这是分片最要紧的一条：parse_mode=HTML 下把 <tg-spoiler> 从中间切开，
   * 标签不闭合，Telegram 回 400 整条丢掉——而 spoiler 里装的正是短信正文。
   * 所以只在换行处切。
   */
  it('不会把 tg-spoiler 标签从中间切开', () => {
    const line = '95533\n💬 <tg-spoiler>验证码 902431，请勿泄露给任何人</tg-spoiler>'
    for (const limit of [60, 80, 100, 137, 200]) {
      for (const p of splitForTelegram(Array(40).fill(line).join('\n'), limit)) {
        const open = (p.match(/<tg-spoiler>/g) ?? []).length
        const close = (p.match(/<\/tg-spoiler>/g) ?? []).length
        expect(open, `limit=${limit} 片内标签不成对：${p.slice(0, 60)}`).toBe(close)
      }
    }
  })

  it('切完再拼回去，内容一个字不少', () => {
    const text = Array(50).fill('第 N 行，带一点中文和 ASCII mixed content').join('\n')
    expect(splitForTelegram(text, 300).join('\n')).toBe(text)
  })

  /**
   * 单行本身就超长时只能硬切。那种情况下宁可 Telegram 拒掉这一条，
   * 也不要把整段都卡在发不出去——所以要求它仍然返回多片而不是抛异常。
   */
  it('单行超长也不会卡死或抛异常', () => {
    const parts = splitForTelegram('x'.repeat(1000), 100)
    expect(parts).toHaveLength(10)
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(100)
  })

  it('空串不会产生一片空消息', () => {
    expect(splitForTelegram('')).toEqual([''])
  })
})
