#!/usr/bin/env node
/**
 * 把各分片合并成 web/i18n-en.js。
 *
 * 分片由并行的翻译 agent 各写一个，互不冲突；这里只做合并与**把关**——
 * 一条坏规则能让整页的翻译失灵，而失灵是静默的（界面照常显示中文），
 * 所以宁可在这里报错停下。
 *
 *   node scripts/build-i18n.mjs <分片目录>
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const dir = process.argv[2]
if (!dir) { console.error('用法：node scripts/build-i18n.mjs <分片目录>'); process.exit(1) }

const exact = {}
const rules = []
const conflicts = []
let files = 0

for (const f of readdirSync(dir).sort()) {
  if (!f.endsWith('.json') || f === 'overrides.json') continue
  let part
  try { part = JSON.parse(readFileSync(join(dir, f), 'utf8')) }
  catch (e) { console.error(`✗ ${f} 不是合法 JSON：${e.message}`); process.exit(1) }
  files++
  for (const [zh, en] of Object.entries(part.exact ?? {})) {
    if (typeof en !== 'string' || !en.trim()) continue
    const k = zh.trim()
    if (!k) continue
    // 同一个中文串被两个分片译成不同的英文：记下来，取第一个。
    // 不报错停下——两处都译得通，只是不一致，而停下会让整个词表都用不上
    if (exact[k] !== undefined && exact[k] !== en) conflicts.push([k, exact[k], en])
    else exact[k] = en
  }
  for (const r of part.rules ?? []) {
    if (!r || typeof r.pattern !== 'string' || typeof r.to !== 'string') continue
    // 三道闸：能编译、整串锚定、不是空模式
    if (!r.pattern.startsWith('^') || !r.pattern.endsWith('$')) {
      console.error(`✗ ${f} 里有条规则没有整串锚定，会误伤用户数据：${r.pattern}`)
      process.exit(1)
    }
    try { new RegExp(r.pattern) }
    catch (e) { console.error(`✗ ${f} 里有条规则编译不了：${r.pattern} —— ${e.message}`); process.exit(1) }
    rules.push({ pattern: r.pattern, to: r.to })
  }
}

/*
 * 人工覆盖层，最后应用、**一律盖过分片**。
 *
 * 分片是并行的 agent 产的，两处把同一句译成两种说法是常态，
 * 还有单复数这类机器翻不好的（「1 channels」）。
 * 改分片没用——下次重跑又回去了；改这里才是持久的。
 */
const ovPath = join(dir, 'overrides.json')
let overrides = { exact: {}, rules: [] }
try { overrides = JSON.parse(readFileSync(ovPath, 'utf8')) } catch { /* 没有就算了 */ }
for (const [zh, en] of Object.entries(overrides.exact ?? {})) exact[zh.trim()] = en
// 覆盖层的规则排在最前面：i18n.js 是顺序匹配，先命中的赢
for (const r of (overrides.rules ?? []).reverse()) {
  if (!r.pattern.startsWith('^') || !r.pattern.endsWith('$')) {
    console.error(`✗ overrides 里有条规则没有整串锚定：${r.pattern}`); process.exit(1)
  }
  new RegExp(r.pattern)
  rules.unshift({ pattern: r.pattern, to: r.to })
}

// 长的排前面：短 key 是长 key 的前缀时，先匹配长的那一条
const sorted = Object.fromEntries(
  Object.entries(exact).sort((a, b) => b[0].length - a[0].length),
)

const out = `/**
 * 中文 → 英文词表。**由 scripts/build-i18n.mjs 生成，不要手改。**
 *
 * key 是运行时那一段文本 trim 之后的原样（查表规则见 i18n.js 顶部那段注释）：
 * 只做整串精确匹配，所以 key 必须是**标签之间的一整段文本**，不是整个模板字符串。
 * rules 用来对付 \\\`\${n} 条规则\\\` 这类插值出来的串，一律整串锚定。
 */
window.I18N_EN = ${JSON.stringify({ exact: sorted, rules }, null, 1)}
`
writeFileSync(join(ROOT, 'web/i18n-en.js'), out)

console.log(`合并 ${files} 个分片 → exact ${Object.keys(sorted).length} 条、rules ${rules.length} 条`)
if (conflicts.length) {
  console.log(`\n同一句被译成两种说法 ${conflicts.length} 处（取了先出现的那个）：`)
  for (const [k, a, b] of conflicts.slice(0, 8)) console.log(`  「${k.slice(0, 26)}」 ${a.slice(0, 34)} / ${b.slice(0, 34)}`)
}
