/**
 * 事件处理管线：入库之后 → 匹配规则 → 分发通知。
 *
 * 与入库解耦：事件一旦落库就立刻回 ack，通知在后台进行。
 * 因为落库成功已经意味着「不会丢」，而推送失败可以重试；
 * 让 Agent 等推送结果只会拖慢队列、增加重复上报。
 */
import type { Cipher } from './crypto.js'
import { log } from './logging.js'
import { crossChannelAlert, dispatch, type ChannelConfig } from './notifier.js'
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
    }

    const results = await dispatch(targets, msg, { retryBaseMs: deps.retryBaseMs })
    const failed = results.filter((r) => !r.ok)

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

/** 同理：某个渠道配置解不开不应阻断其他渠道。 */
async function loadChannels(deps: PipelineDeps): Promise<ChannelConfig[]> {
  const rows = await deps.store.listChannels()
  const out: ChannelConfig[] = []
  for (const c of rows) {
    if (!c.enabled) continue
    try {
      out.push({
        id: c.id,
        type: c.type,
        name: c.name,
        config: JSON.parse(await deps.cipher.decrypt(c.config_enc)),
        enabled: true,
      })
    } catch (e) {
      log.error('渠道配置解密失败，已跳过', { channel_id: c.id, type: c.type, error: String(e) })
    }
  }
  return out
}
