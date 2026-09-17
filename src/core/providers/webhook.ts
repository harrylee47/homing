/**
 * 通用 Webhook 渠道。
 *
 * 面向自定义集成：把事件推给用户自己的服务。因为目标地址完全由用户指定，
 * 这是唯一一个会把短信正文发往任意第三方的渠道，默认要求 https。
 */
import { z } from 'zod'
import { checkWebhookTarget } from '../ssrf.js'
import { ProviderError, retryAfterMsOf, type Provider } from './types.js'
import { describeFetchError } from '../neterror.js'

export const WebhookConfig = z.object({
  url: z.string().url(),
  method: z.enum(['POST', 'PUT']).default('POST'),
  /** 自定义请求头，如签名或鉴权 */
  headers: z.record(z.string(), z.string()).default({}),
  /**
   * 允许明文 http。默认禁止：正文里有验证码，走明文等于公开广播。
   * 仅在目标是内网地址且用户明确知情时才该打开。
   */
  allow_insecure: z.boolean().default(false),
  /**
   * 允许指向内网 / 回环地址。**只有管理员能开**（api 层判角色）。
   *
   * 不设这道闸的话，任何注册进来的人都拿到了一个「让服务器替我访问它自己
   * 内网」的原语：云元数据接口、只监听回环的管理端口、同机的数据库端口。
   * 而接收端就在同一台机器上确实是常见需求，所以不是禁死，是收归管理员。
   */
  allow_private: z.boolean().default(false),
})
export type WebhookConfig = z.infer<typeof WebhookConfig>

/** 跟随重定向的上限。每一跳都重校验，所以这个数只是防环，不是安全边界。 */
const MAX_REDIRECTS = 3

/**
 * 取响应体片段，但**先把我们自己发过去的内容抹掉**。
 *
 * `ProviderError.message` 的约定是「会写入 audit_log，不得包含短信正文」
 * （见 types.ts）。而这里原样拼响应体恰恰会违反它：很多框架在 4xx 里回显
 * 收到的 payload（Express 的错误页、Spring 的校验报错、各类 API 网关），
 * 而我们的 payload 里就有 `body`（短信正文）和 `code`（验证码）。
 *
 * 这条 message 会流到四个地方，每一个都比库里更暴露：audit_log 的
 * notify.fail、跨渠道告警的正文（**告警是 alert:true，Telegram 不加
 * spoiler**）、控制台「渠道测试」按钮的报错、以及 stdout —— logging.ts 的
 * 脱敏只按**键名**遮蔽，而正文是藏在 `error` 这个字符串的**值**里的，
 * 键名匹配根本够不着，于是明文进 Docker 日志与面板界面。
 *
 * 不整个丢掉响应体：`{"errcode":93000,"errmsg":"invalid webhook url"}`
 * 这种才是排查配错的唯一线索。只把回显的那部分换掉。
 */
async function safeDetail(res: Response, msg: { body: string; title: string; code?: string | null }): Promise<string> {
  let out = (await res.text().catch(() => '')).slice(0, 200)

  // 正文与标题：短的不抹。「您有新消息」这种谁的响应里都可能出现，
  // 抹了反而把正常的报错打成马赛克——和 pipeline 判短信回声是同一个思路。
  for (const secret of [msg.body, msg.title]) {
    if (secret && secret.length >= 8) out = out.split(secret).join('<已抹去>')
  }

  /**
   * 验证码单独处理，**不设长度门槛**。
   *
   * 它只有 4–8 位，套上面那条 >=8 的规则就会被整个放过去——而它恰恰是
   * 这里最不能漏的一项（补这段时的测试就是这么挂的：正文抹干净了，
   * 493021 原样躺在错误信息里）。
   *
   * 代价是可能误伤：目标返回的 `{"errcode":493021}` 也会被抹成
   * `<已抹去>`。用数字边界把这个概率压到很低，而且即使误伤，
   * 后果只是一条报错里少一个数字——比漏一个验证码便宜得多。
   */
  if (msg.code) {
    out = out.replace(
      new RegExp(`(?<![0-9])${msg.code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![0-9])`, 'g'),
      '<已抹去>',
    )
  }
  return out
}

export const webhookProvider: Provider<WebhookConfig> = {
  type: 'webhook',
  configSchema: WebhookConfig,

  async send(cfg, msg) {
    if (!cfg.allow_insecure && !cfg.url.startsWith('https://')) {
      throw new ProviderError('webhook', '目标地址不是 https，且未显式允许明文', false)
    }
    // 保存时已经判过一次，这里再判一次：配置可能是老版本写进去的，
    // 而这一层是真正发起请求的地方——防护要贴着动作放，不能只放在入口
    const bad = checkWebhookTarget(cfg.url, cfg.allow_private)
    if (bad) throw new ProviderError('webhook', bad, false)

    const payload = JSON.stringify({
        title: msg.title,
        body: msg.body,
        code: msg.code,
        priority: msg.priority,
        event_id: msg.eventId,
        kind: msg.kind ?? null,
        direction: msg.direction ?? null,
        device: msg.deviceName ?? null,
        sim: msg.sim ?? null,
        occurred_at: msg.occurredAt,
        /** 已按用户时区格式化，省得下游再猜服务端时区 */
        occurred_at_local: msg.localTime ?? null,
      console_url: msg.consoleUrl ?? null,
    })

    /**
     * **不跟随重定向**，自己一跳一跳地走，每一跳都重新过 SSRF 校验。
     *
     * fetch 默认 `redirect: 'follow'`，最多跟 20 跳,而 checkWebhookTarget 只
     * 校验了**第一个** URL。也就是说填一个自己控制的公网地址、让它 302 到
     * `http://169.254.169.254/`，这道闸就等于不存在——不需要控制 DNS、
     * 不需要卡时序，一跳就到。而这道闸本来就是为「非管理员用户」设的。
     *
     * 连带两件事也在这里一并管住：307/308 会把**短信正文与自定义请求头**
     * 原样转发到新地址；`allow_insecure` 的 https 强制同样只管初始 URL，
     * 不校验每一跳的话 https→http 降级走同一条路就能做到。
     */
    let url = cfg.url
    let res: Response
    for (let hop = 0; ; hop++) {
      res = await fetch(url, {
        method: cfg.method,
        headers: { 'content-type': 'application/json', ...cfg.headers },
        body: payload,
        redirect: 'manual',
        signal: AbortSignal.timeout(15_000),
      }).catch((e: unknown) => {
        throw new ProviderError('webhook', `网络错误: ${describeFetchError(e)}`)
      })

      if (res.status < 300 || res.status >= 400) break

      const loc = res.headers.get('location')
      if (!loc) break
      if (hop >= MAX_REDIRECTS) {
        throw new ProviderError('webhook', `重定向超过 ${MAX_REDIRECTS} 跳，已放弃`, false)
      }
      const next = new URL(loc, url).toString()
      if (!cfg.allow_insecure && !next.startsWith('https://')) {
        throw new ProviderError('webhook', `目标把请求重定向到了非 https 地址，已拒绝`, false)
      }
      const badHop = checkWebhookTarget(next, cfg.allow_private)
      if (badHop) throw new ProviderError('webhook', `目标把请求重定向到了不允许的地址：${badHop}`, false)
      url = next
    }

    if (!res.ok) {
      throw new ProviderError(
        'webhook', `HTTP ${res.status}: ${await safeDetail(res, msg)}`,
        res.status === 429 || res.status >= 500,
        retryAfterMsOf(res),
      )
    }
  },
}
