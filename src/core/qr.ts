/**
 * 二维码生成（TOTP 绑定、设备配对、Bark 服务器地址、APK 下载）。
 *
 * 服务端生成 SVG 而不是前端画：控制台的 CSP 收得很紧（script-src 'self'），
 * 不能从 CDN 加载二维码库，而把整个编码器塞进前端又会让零构建的 app.js 膨胀。
 *
 * 只用依赖做编码，SVG 自己合成单条 path —— 库自带的 createSvgTag 会为每个
 * 模块输出一个 <rect>，45×45 的码要 26KB，合成路径后不到 3KB。
 */
import qrcode from 'qrcode-generator'

/** label 会进 SVG 属性，调用方给的字符串不一定干净 */
const escapeAttr = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export interface QrOptions {
  /**
   * 每个模块的尺寸。默认 1：SVG 靠 viewBox 缩放，画多大由 CSS 决定，
   * 而坐标只有一两位数，路径串比 cell=4 时短一半。
   */
  cell?: number
  /** 静区宽度，按模块计。规范要求至少 4，低于此扫描器可能识别不到 */
  margin?: number
  /**
   * 读屏软件念出来的那句话。
   *
   * 一张二维码对读屏用户是完全不可用的，这句 label 是他唯一能拿到的信息——
   * 所以它必须说清这是**哪一种**码。早先写死成「TOTP 二维码」，
   * 而同一个函数还在给配对码、Bark 地址、APK 下载用，念出来全是错的。
   */
  label?: string
}

export function toSvg(text: string, opts: QrOptions = {}): string {
  const cell = opts.cell ?? 1
  const margin = opts.margin ?? 4

  // 0 = 自动选择版本；'M' 级纠错在尺寸与容错间平衡，是二维码的通行选择
  const qr = qrcode(0, 'M')
  qr.addData(text)
  qr.make()

  const n = qr.getModuleCount()
  const size = (n + margin * 2) * cell

  // 把同一行里连续的深色模块合成一段，而不是逐个输出：
  // 45×45 的码约有一千个深色模块，逐个输出 15KB，合并游程后不到 5KB。
  const parts: string[] = []
  for (let r = 0; r < n; r++) {
    let runStart = -1
    for (let c = 0; c <= n; c++) {
      const dark = c < n && qr.isDark(r, c)
      if (dark && runStart === -1) runStart = c
      if (!dark && runStart !== -1) {
        const x = (runStart + margin) * cell
        const y = (r + margin) * cell
        const w = (c - runStart) * cell
        parts.push(`M${x} ${y}h${w}v${cell}h-${w}z`)
        runStart = -1
      }
    }
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" role="img" aria-label="${escapeAttr(opts.label ?? '二维码')}" shape-rendering="crispEdges">`,
    `<rect width="${size}" height="${size}" fill="#fff"/>`,
    `<path fill="#000" d="${parts.join('')}"/>`,
    `</svg>`,
  ].join('')
}
