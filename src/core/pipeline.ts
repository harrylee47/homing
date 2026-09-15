/**
 * 事件处理管线：入库之后 → 匹配规则 → 分发通知。
 *
 * 与入库解耦：事件一旦落库就立刻回 ack，通知在后台进行。
 * 因为落库成功已经意味着「不会丢」，而推送失败可以重试；
 * 让 Agent 等推送结果只会拖慢队列、增加重复上报。
 */
import type { Cipher } from './crypto.js'
import { log } from './logging.js'
import { crossChannelAlert, dispatch, PROVIDERS, type ChannelConfig } from './notifier.js'
import type { NotifyMessage } from './providers/types.js'
import {
  defaultAction, evaluate, extractCode, render,
  RuleAction, RuleMatch, type MatchableEvent, type Rule,
} from './rules.js'
import type { Store } from './store.js'

export interface PipelineDeps {
  store: Store
  cipher: Cipher
  /** 本地时区偏移（分钟），用于规则的 time_window 判断 */
  tzOffsetMin?: number
  /** 重试退避基数，测试用 */
  retryBaseMs?: number
  /** 控制台地址，用于生成通知里的深链。未配置则通知不带跳转。 */
  baseUrl?: string | null
}

/**
 * 处理一条已入库事件。永不抛异常——通知失败不应影响采集链路。
 */
export async function processEvent(
  deps: PipelineDeps,
  eventId: string,
  e: MatchableEvent,
): Promise<void> {
  try {
    const [rules, channels] = await Promise.all([loadRules(deps.store), loadChannels(deps)])

    const result = evaluate(rules, e, deps.tzOffsetMin ?? 0)

    // 无规则命中走兜底：推送到所有启用渠道并归档。
    // 静默丢弃就是漏报，而漏报是这套系统唯一不能接受的失败（计划 §14）。
    const action = result.matched.length > 0
      ? mergeActions(result.matched)
      : defaultAction(channels.map((c) => c.id))

    const matchedIds = result.matched.map((r) => r.id)
    await deps.store.setMatchedRules(eventId, matchedIds)

    const targetIds = result.matched.length > 0 ? result.channels : action.channels
    const targets = channels.filter((c) => targetIds.includes(c.id))

    if (targets.length === 0) {
      log.info('事件无推送目标，仅归档', { event_id: eventId, matched: matchedIds })
      return
    }

    const code = action.extract_code ? extractCode(e.content) : null
    const msg: NotifyMessage = {
      title: e.from,
      body: render(action.template, {
        sender: e.from,
        content: e.content,
        code: code ?? '',
        time: new Date(e.occurred_at).toISOString(),
        device: e.device_id,
      }),
      priority: result.matched.length > 0 ? result.priority : action.priority,
      code,
      eventId,
      occurredAt: e.occurred_at,
      consoleUrl: deps.baseUrl ?? null,
      ...(action.bark ? { options: { bark: action.bark } } : {}),
    }

    const results = await dispatch(targets, msg, { retryBaseMs: deps.retryBaseMs })
    const failed = results.filter((r) => !r.ok)

    // 记录消息映射：用户在 Telegram 里引用回复这条推送时，据此反查发件人
    for (const r of results) {
      if (!r.ok || !r.ref) continue
      await deps.store.putMessageRef({
        channel_id: r.channelId, ref: r.ref, event_id: eventId,
        sender: e.from, device_id: e.device_id, created_at: Date.now(),
      }).catch((err: unknown) => log.warn('记录消息映射失败', { error: String(err) }))
    }

    for (const r of results) {
      await deps.store.audit({
        actor: 'notifier',
        action: r.ok ? 'notify.ok' : 'notify.fail',
        detail: `${r.channelType}:${r.channelId}${r.error ? ` ${r.error}` : ''}`,
        ip: null,
        created_at: Date.now(),
      })
    }

    if (failed.length > 0) {
      // 三次全败 → 跨渠道告警（计划 §9 可靠性要求）
      await crossChannelAlert(channels, failed, `事件 ${eventId} 推送失败`, { retryBaseMs: deps.retryBaseMs })
    }
  } catch (err) {
    log.error('事件处理管线异常', { event_id: eventId, error: String(err) })
  }
}

/**
 * 多条规则同时命中时合并动作。
 *
 * 取「最宽松」的一侧：任一规则要求提取验证码就提取，任一要求高优先级就高优先级。
 * 模板取优先级最高（priority 数字最小）那条的，避免多条模板互相覆盖导致结果不可预期。
 */
function mergeActions(matched: Rule[]): RuleAction {
  const first = matched[0]!
  return {
    channels: [...new Set(matched.flatMap((r) => r.action.channels))],
    priority: matched.some((r) => r.action.priority === 'high') ? 'high' : 'normal',
    extract_code: matched.some((r) => r.action.extract_code),
    template: first.action.template,
    archive: matched.some((r) => r.action.archive),
    stop_processing: first.action.stop_processing,
    // Bark 选项取优先级最高那条规则的，避免多条互相覆盖导致行为不可预期
    ...(matched.find((r) => r.action.bark)?.action.bark
      ? { bark: matched.find((r) => r.action.bark)!.action.bark }
      : {}),
  }
}

/** 解析失败的规则会被跳过：一条写坏的规则不该让所有短信都收不到。 */
async function loadRules(store: Store): Promise<Rule[]> {
  const rows = await store.listRules()
  const out: Rule[] = []
  for (const r of rows) {
    try {
      out.push({
        id: r.id,
        name: r.name,
        priority: r.priority,
        enabled: r.enabled,
        match: RuleMatch.parse(JSON.parse(r.match_json)),
        action: RuleAction.parse(JSON.parse(r.action_json)),
      })
    } catch (e) {
      log.error('规则解析失败，已跳过', { rule_id: r.id, name: r.name, error: String(e) })
    }
  }
  return out
}

/**
 * 同理：某个渠道配置解不开不应阻断其他渠道。
 *
 * 解密后必须再过一遍 provider 的 schema —— 不能只 JSON.parse。
 * 否则新增带默认值的配置项对**已存在的渠道**不生效（存的是旧结构，
 * 字段缺失就是 undefined），而这种失效是静默的：
 * 比如 telegram 的 spoiler 默认 true，不过 schema 就会退化成不模糊。
 */
async function loadChannels(deps: PipelineDeps): Promise<ChannelConfig[]> {
  const rows = await deps.store.listChannels()
  const out: ChannelConfig[] = []
  for (const c of rows) {
    if (!c.enabled) continue
    try {
      const raw: unknown = JSON.parse(await deps.cipher.decrypt(c.config_enc))
      const provider = PROVIDERS[c.type]
      if (!provider) {
        log.error('渠道类型未注册，已跳过', { channel_id: c.id, type: c.type })
        continue
      }
      const parsed = provider.configSchema.safeParse(raw)
      if (!parsed.success) {
        log.error('渠道配置校验失败，已跳过', {
          channel_id: c.id, type: c.type,
          detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        })
        continue
      }
      out.push({ id: c.id, type: c.type, name: c.name, config: parsed.data, enabled: true })
    } catch (e) {
      log.error('渠道配置解密失败，已跳过', { channel_id: c.id, type: c.type, error: String(e) })
    }
  }
  return out
}
