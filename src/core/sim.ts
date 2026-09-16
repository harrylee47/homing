/**
 * SIM 卡的展示逻辑。
 *
 * 只有一张卡时**什么都不显示**——这和「多设备才标设备名」是同一条原则：
 * 单卡下每条消息都缀一个「SIM1」是纯噪音，而双卡下不缀就分不清
 * 这条验证码是哪张卡收到的，也就没法回过去。
 */
import { SimCard } from './protocol.js'

/** 从 `devices.net_json` 里取出卡列表。解析不了就当没有。 */
export function simsOf(netJson: string | null | undefined): SimCard[] {
  if (!netJson) return []
  try {
    const raw: unknown = JSON.parse(netJson)
    const sims = (raw as { sims?: unknown })?.sims
    if (!Array.isArray(sims)) return []
    const parsed = SimCard.array().safeParse(sims)
    return parsed.success ? parsed.data : []
  } catch {
    return []
  }
}

/** 「SIM2」。单卡、卡槽未知都返回空串。 */
export function simShort(sims: SimCard[], slot: number | null | undefined): string {
  if (sims.length < 2 || slot == null) return ''
  return `SIM${slot + 1}`
}

/**
 * 「SIM2 · 尾号1234」。给通知与详情页用。
 *
 * 尾号优先于运营商名：双卡常常是同一家运营商的两张卡，
 * 那时候只写「中国移动」两张卡长得一模一样，等于没说。
 */
export function simLabel(sims: SimCard[], slot: number | null | undefined): string {
  const short = simShort(sims, slot)
  if (!short) return ''
  const card = sims.find((s) => s.slot === slot)
  const tail = card?.tail ? `尾号${card.tail}` : null
  const name = card?.carrier ?? card?.label ?? null
  const extra = tail ?? name
  return extra ? `${short} · ${extra}` : short
}
