/**
 * 依赖漏洞扫描（计划 §11.6「依赖自动扫描」）。
 *
 * 这台服务器存着全部银行验证码，一个有洞的传递依赖就够了。
 * 没有 CI 的阶段先做成一条能手跑、也能塞进 cron 的命令。
 */
import { execFileSync } from 'node:child_process'

let stderr = ''
const run = (args) => {
  try {
    return execFileSync('pnpm', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    // pnpm audit 发现漏洞时以非 0 退出，报告仍在 stdout。
    // 但「压根没扫成」（离线、registry 不通、pnpm 不在 PATH）也走这条分支，
    // 两者必须分得开——见下面对空输出的处理。
    stderr = String(e.stderr ?? e.message ?? '')
    return String(e.stdout ?? '')
  }
}

const out = run(['audit', '--json', '--prod'])

// 整块取 JSON：pnpm 10 的 --json 是**缩进过的多行** JSON，第一行只有一个 `{`。
// 原来是「按行找第一行以 { 开头的，再 parse 那一行」，于是恒定解析失败、
// 恒定 exit 2，连带 pnpm run check 永远跑不完——一个永远红的检查等于没有检查，
// 人会习惯性忽略它，真出了高危依赖也看不见。
const from = out.indexOf('{')
const to = out.lastIndexOf('}')
let report = null
if (from >= 0 && to > from) {
  try {
    report = JSON.parse(out.slice(from, to + 1))
  } catch {
    report = null
  }
}

const counts = report?.metadata?.vulnerabilities
// 拿不到统计就是没扫成，这里绝不能回落成「0 个漏洞」：离线时 stdout 是空的，
// 那样会打印一个绿色的「✅ 无已知漏洞」——假的绿比红更糟。
if (!counts || typeof counts !== 'object') {
  console.error('✗ 依赖扫描没跑成（没能从 pnpm audit 拿到结果），下面是它的原样输出：')
  console.error((stderr || out).trim().slice(0, 2000) || '（没有任何输出）')
  process.exit(2)
}

const total = Object.values(counts).reduce((a, b) => a + Number(b || 0), 0)

console.log('生产依赖漏洞统计:')
for (const [level, n] of Object.entries(counts)) console.log(`  ${level.padEnd(10)} ${n}`)

// 只有 high/critical 拦路。low/info 级的 advisory 也会让 pnpm audit 非 0 退出，
// 跟着它一起失败的话这条检查就是常红的。
const blocking = Number(counts.critical || 0) + Number(counts.high || 0)
if (blocking > 0) {
  console.error(`\n存在 ${blocking} 个高危及以上漏洞，需要处理。`)
  process.exit(1)
}
console.log(total === 0 ? '\n✅ 无已知漏洞' : '\n仅有中低危漏洞，可评估后处理')
