/**
 * 硬约束落点检查：src/core 不得引入任何运行时特有的 import。
 * CI 里跑这条，比口头约定可靠（计划 §7.2）。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const FORBIDDEN = [
  /from\s+['"]node:/,            // Node 内置模块
  /require\s*\(\s*['"]node:/,
  /from\s+['"](fs|path|http|net|crypto|os|child_process)['"]/,
  /from\s+['"]ws['"]/,           // 具体 WS 实现
  /from\s+['"]cloudflare:/,      // Workers 特有
  /\bprocess\.env\b/,            // 环境变量读取属适配层
]

const walk = (dir) =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : []
  })

let bad = 0
for (const file of walk('src/core')) {
  const src = readFileSync(file, 'utf8')
  src.split('\n').forEach((line, i) => {
    if (line.trimStart().startsWith('*') || line.trimStart().startsWith('//')) return
    for (const re of FORBIDDEN) {
      if (re.test(line)) {
        console.error(`✗ ${file}:${i + 1}  ${line.trim()}`)
        bad++
      }
    }
  })
}

if (bad > 0) {
  console.error(`\ncore 层引入了 ${bad} 处运行时特有依赖。这会堵死 Workers 适配路径（硬约束①-④）。`)
  process.exit(1)
}
console.log('✓ core 层无运行时特有依赖')
