#!/usr/bin/env node
/**
 * 守住消息正文解析的两件事（web/app.js 的 richText 那一族）。
 *
 * ① **验证码关键词两边必须一致。** 网页上高亮哪一串、Bark 通知标题里放哪一串，
 *    用的是两份代码（浏览器里跑的 app.js 与服务端的 core/rules.ts）。
 *    一旦分叉，表现是「通知里是 614197，网页上高亮的却是别的数字」——
 *    而人会以为其中一处是错的，却不知道该信哪个。
 *
 * ② **链接解析不能被短信正文骗到。** 这段文字是发信人完全可控的，
 *    所以这里逐条跑一遍会出事的输入：伪协议、尾部标点、链接里的数字。
 *
 * 挂在 deploy.sh 与 CI 上。跑法：node scripts/check-rich-text.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const app = readFileSync(join(ROOT, 'web/app.js'), 'utf8')
const rules = readFileSync(join(ROOT, 'src/core/rules.ts'), 'utf8')

let bad = 0
const fail = (msg) => { console.error(`✗ ${msg}`); bad++ }

// ── ① 关键词一致 ────────────────────────────────────────────

const pick = (src, name) => {
  const m = src.match(new RegExp('const ' + name + '[^=]*=\\s*\\[([\\s\\S]*?)\\]'))
  if (!m) return null
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])
}

const a = pick(app, 'CODE_KEYWORDS')
const b = pick(rules, 'CODE_KEYWORDS')
if (!a) fail('web/app.js 里找不到 CODE_KEYWORDS')
else if (!b) fail('src/core/rules.ts 里找不到 CODE_KEYWORDS')
else if (a.join('|') !== b.join('|')) {
  fail('CODE_KEYWORDS 两边不一致：\n'
    + `    app.js:   ${a.join('、')}\n`
    + `    rules.ts: ${b.join('、')}\n`
    + '    通知标题与网页高亮会指向不同的数字，改一边就要改另一边。')
} else {
  console.log(`✓ CODE_KEYWORDS 两边一致（${a.length} 个）`)
}

// ── ② 解析行为 ──────────────────────────────────────────────

// 把两个纯函数从 app.js 里抠出来单独跑：它们不碰 DOM，可以直接 eval
// 按「行首单独一个 }」找函数末尾，不数括号——正则里的 `{4,8}`、
// 字符类里的 `{` 都会把计数骗掉，而这两个函数里恰好都有。
const grab = (name) => {
  const lines = app.split('\n')
  const i = lines.findIndex((l) => l.startsWith(`function ${name}(`))
  if (i < 0) throw new Error(`app.js 里找不到顶层函数 ${name}`)
  const j = lines.findIndex((l, k) => k > i && l === '}')
  if (j < 0) throw new Error(`${name} 找不到结尾`)
  return lines.slice(i, j + 1).join('\n')
}

// eslint-disable-next-line no-new-func
const kw = app.match(/const CODE_KEYWORDS = \[[\s\S]*?\]/)[0]
const { splitLinks, findCodes } = new Function(
  `${kw}\n${grab('splitLinks')}\n${grab('findCodes')}\nreturn { splitLinks, findCodes }`,
)()

const links = (s) => splitLinks(s).filter((x) => x.href).map((x) => x.href)
const codes = (s) => findCodes(s).map((c) => s.slice(c.start, c.end))

const cases = [
  // 正常链接
  ['Apple Store：W1687194623 の商品をお届けしました。 https://s.apple.com/ce7g9R3Jc8',
    { links: ['https://s.apple.com/ce7g9R3Jc8'] }],
  // 尾部中文标点要吐回去，否则链接 404 而人看不出多了个字
  ['详情见 https://example.com/a。其他',
    { links: ['https://example.com/a'] }],
  ['见 https://example.com/x）',
    { links: ['https://example.com/x'] }],
  // **伪协议一律不许变成链接**
  ['点这里 javascript:alert(1) 看看', { links: [] }],
  ['data:text/html;base64,PHNjcmlwdD4=', { links: [] }],
  ['file:///etc/passwd', { links: [] }],
  // 链接里的数字不能被当成验证码切开（所以必须先认链接）
  ['您的验证码是 https://x.com/code/123456',
    { links: ['https://x.com/code/123456'] }],

  // 验证码：三种常见模板
  ['[Netease]Your SMS verification code is 614197 .', { codes: ['614197'] }],
  ['【阿里云】您的验证码 398999，请在 15 分钟内完成验证。', { codes: ['398999'] }],
  ['G-455304 是您的 Google 验证码。请勿与任何人分享此码。', { codes: ['455304'] }],
  // 一条里两个码，两个都要能点
  ['验证码 111111，备用验证码 222222', { codes: ['111111', '222222'] }],
  // 订单号不该被截成验证码（没有关键词）
  ['您的订单 1687194623 已发货', { codes: [] }],
  // 关键词邻近但位数不对
  ['验证码 123 太短', { codes: [] }],
  ['验证码 1234567890 太长', { codes: [] }],
  // 纯字母关键词要词边界：passcode 里不该另外匹配出 code
  ['Your passcode is 998877', { codes: ['998877'] }],
]

for (const [input, want] of cases) {
  if (want.links) {
    const got = links(input)
    if (got.join('|') !== want.links.join('|')) {
      fail(`链接解析：${JSON.stringify(input)}\n    期望 ${JSON.stringify(want.links)}\n    实际 ${JSON.stringify(got)}`)
    }
  }
  if (want.codes) {
    const got = codes(input)
    if (got.join('|') !== want.codes.join('|')) {
      fail(`验证码解析：${JSON.stringify(input)}\n    期望 ${JSON.stringify(want.codes)}\n    实际 ${JSON.stringify(got)}`)
    }
  }
}

if (bad) {
  console.error(`\n${bad} 项不通过`)
  process.exit(1)
}
console.log(`✓ 正文解析 ${cases.length} 条用例全通过`)
