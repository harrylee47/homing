#!/usr/bin/env node
/**
 * 同一只鸟现在有四份手工副本，这个脚本守住它们不漂移。
 *
 *   web/logo.svg                              唯一的源（3 个 path + 2 个 circle）
 *   agent/.../drawable/logo.xml               界面里用的，满幅 64 画布
 *   agent/.../drawable/ic_launcher_foreground.xml   自适应图标前景，108 画布
 *   agent/.../drawable/ic_launcher_monochrome.xml   Android 13+ 主题图标，剪影
 *   agent/.../drawable/ic_notification.xml    通知栏，剪影
 *
 * 为什么要脚本：vector drawable 没有 <circle>，圆得手工转成弧路径，
 * 而「改了 svg 忘了改安卓那几份」的表现是**图标悄悄变成两个样子**——
 * 桌面上一个、通知栏一个，谁都不会去比对。
 *
 * 剪影那两份只含身体/头/喙（翅膀落在身体轮廓内，单色下看不见；
 * 眼睛做成 evenOdd 镂空），所以它们只核这三条。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const RES = join(ROOT, 'agent/app/src/main/res/drawable')

/*
 * 两边写法本来就不同，比对前必须归一到同一种：
 *   - 分隔符：SVG 用空格（"M47 27"），vector drawable 用逗号（"M47,27"）
 *   - 数字：同一个值可能写成 21 或 21.0
 * 所以先把命令字母单独隔开，再按空格/逗号切开，数字统一过一遍 Number。
 */
const norm = (d) => d
  .replace(/([A-Za-z])/g, ' $1 ')
  .split(/[\s,]+/)
  .filter(Boolean)
  .map((t) => (/^-?[\d.]+$/.test(t) ? String(Number(t)) : t))
  .join(' ')

const svg = readFileSync(join(ROOT, 'web/logo.svg'), 'utf8')
const paths = [...svg.matchAll(/<path[^>]*\sd="([^"]+)"/g)].map((m) => m[1])
const circles = [...svg.matchAll(/<circle[^>]*cx="([\d.]+)"[^>]*cy="([\d.]+)"[^>]*r="([\d.]+)"/g)]
  .map(([, cx, cy, r]) => {
    const x = Number(cx), y = Number(cy), rr = Number(r)
    // vector drawable 没有 circle，圆一律写成这个形状的两段弧
    return `M${x},${y - rr} a${rr},${rr} 0 1,0 0,${rr * 2} a${rr},${rr} 0 1,0 0,-${rr * 2} Z`
  })

if (paths.length !== 3 || circles.length !== 2) {
  console.error(`✗ web/logo.svg 的形状数变了（${paths.length} path + ${circles.length} circle，期望 3 + 2）`)
  console.error('  这个脚本按「身体/翅膀/喙 + 头/眼」写死，改了形状要连它一起改')
  process.exit(1)
}
const [body, wing, beak] = paths
const [head, eye] = circles

const FILES = {
  'logo.xml':                   [body, wing, head, beak, eye],
  'ic_launcher_foreground.xml': [body, wing, head, beak, eye],
  // 剪影：没有翅膀；头与眼并成一条 evenOdd 路径，所以逐条核头和眼的片段
  'ic_launcher_monochrome.xml': [body, head, eye, beak],
  'ic_notification.xml':        [body, head, eye, beak],
}

let bad = 0
for (const [file, want] of Object.entries(FILES)) {
  const xml = norm(readFileSync(join(RES, file), 'utf8'))
  for (const d of want) {
    if (!xml.includes(norm(d))) {
      console.error(`✗ ${file} 里找不到这条路径：${d.slice(0, 56)}…`)
      bad++
    }
  }
}
if (bad) {
  console.error(`\n共 ${bad} 条对不上。web/logo.svg 是唯一的源，改了它就要把这几份一起改。`)
  process.exit(1)
}
console.log('✓ 四份 logo 副本与 web/logo.svg 一致')
