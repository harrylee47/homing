/**
 * 依赖漏洞扫描（计划 §11.6「依赖自动扫描」）。
 *
 * 这台服务器存着全部银行验证码，一个有洞的传递依赖就够了。
 * 没有 CI 的阶段先做成一条能手跑、也能塞进 cron 的命令。
 */
import { execFileSync } from 'node:child_process'

const run = (args) => {
  try {
    return execFileSync('pnpm', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    // pnpm audit 发现漏洞时以非 0 退出，输出仍在 stdout
    return e.stdout ?? ''
  }
}

const out = run(['audit', '--json', '--prod'])
let report
try {
  report = JSON.parse(out.split('\n').find((l) => l.trim().startsWith('{')) ?? '{}')
} catch {
  console.error('无法解析 pnpm audit 输出')
  process.exit(2)
}

const counts = report.metadata?.vulnerabilities ?? {}
const total = Object.values(counts).reduce((a, b) => a + Number(b || 0), 0)

console.log('生产依赖漏洞统计:')
for (const [level, n] of Object.entries(counts)) console.log(`  ${level.padEnd(10)} ${n}`)

const blocking = Number(counts.critical || 0) + Number(counts.high || 0)
if (blocking > 0) {
  console.error(`\n存在 ${blocking} 个高危及以上漏洞，需要处理。`)
  process.exit(1)
}
console.log(total === 0 ? '\n✅ 无已知漏洞' : '\n仅有中低危漏洞，可评估后处理')
