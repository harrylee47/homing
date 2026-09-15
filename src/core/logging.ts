/**
 * 日志脱敏。
 *
 * 硬约束③要求日志走 stdout，而 stdout 会进 Docker 日志文件并长期留存，
 * 也会显示在 1Panel 的容器日志界面上。短信正文与验证码一旦打进日志，
 * 等于绕过了落库加密——库里是密文、日志里是明文。
 *
 * 因此：任何含 content / token / from 的对象都必须经过 redact() 才能输出。
 */

const SECRET_KEYS = new Set([
  'token', 'password', 'secret', 'dek', 'key', 'authorization',
  'bot_token', 'api_key', 'token_hash', 'pairing_code',
])
// 注意不含 'message'：协议错误、异常说明都用这个字段名，
// 遮蔽它会让线上问题无法排查。短信正文在本项目里一律叫 content。
const CONTENT_KEYS = new Set(['content', 'text', 'body'])
const PHONE_KEYS = new Set(['from', 'to', 'to_number', 'sender', 'phone'])

/** 号码保留前 3 后 2：`138****38` —— 足以人工辨认来源，不足以泄露完整号码。 */
export function maskPhone(v: string): string {
  if (v.length <= 5) return '*'.repeat(v.length)
  return `${v.slice(0, 3)}${'*'.repeat(Math.max(1, v.length - 5))}${v.slice(-2)}`
}

/** 正文只保留长度，绝不输出任何片段——验证码通常就在前几个字符里。 */
export const maskContent = (v: string): string => `<${v.length} chars>`

export function redact(input: unknown, depth = 0): unknown {
  if (depth > 8) return '<deep>'
  if (input === null || typeof input !== 'object') return input
  if (Array.isArray(input)) return input.map((x) => redact(x, depth + 1))

  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    const key = k.toLowerCase()
    if (SECRET_KEYS.has(key)) out[k] = '<redacted>'
    else if (CONTENT_KEYS.has(key) && typeof v === 'string') out[k] = maskContent(v)
    else if (PHONE_KEYS.has(key) && typeof v === 'string') out[k] = maskPhone(v)
    else out[k] = redact(v, depth + 1)
  }
  return out
}

type Level = 'debug' | 'info' | 'warn' | 'error'

/** 结构化日志，输出 JSON 行到 stdout。所有 ctx 自动脱敏。 */
function emit(level: Level, msg: string, ctx?: Record<string, unknown>): void {
  const line = { ts: new Date().toISOString(), level, msg, ...(ctx ? { ctx: redact(ctx) } : {}) }
  console.log(JSON.stringify(line))
}

export const log = {
  debug: (m: string, c?: Record<string, unknown>) => emit('debug', m, c),
  info: (m: string, c?: Record<string, unknown>) => emit('info', m, c),
  warn: (m: string, c?: Record<string, unknown>) => emit('warn', m, c),
  error: (m: string, c?: Record<string, unknown>) => emit('error', m, c),
}
