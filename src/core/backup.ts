/**
 * 配置导出与恢复。
 *
 * 这个文件的核心不是「怎么把数据搬出去」，而是**哪些东西绝对不能搬出去**。
 *
 * 要记住一件反直觉的事：**明文配置 JSON 比整机数据库快照危险得多。**
 * 快照里全是密文，没有 DEK 就是一堆废字节；而配置 JSON 不需要任何钥匙就能读，
 * 里面是渠道密钥、短信指令口令、你的全部规则。它是这台机器能生成的
 * 最危险的单个文件，而它会经浏览器下载——落在下载目录，大概率被网盘自动同步，
 * 甚至可能就落在那台收验证码的手机上。
 *
 * 所以两条硬规矩：
 * ① 导出物里**永远不含 DEK**，界面上也不显示它。DEK 是运维物件（.env /
 *    data/dek.key），把它放进导出等于把本该分开保管的两份重新合成一份。
 * ② 密钥按**字段白名单**脱敏，新增 provider 时默认「整个 config 都算密钥」。
 *    宁可多脱——漏脱一个的代价是一份可以直接冒充你的文件。
 */

/** 导出格式的版本。改了结构就 +1，导入时据此拒绝看不懂的文件 */
export const BACKUP_VERSION = 1

/**
 * 每种渠道里**不能导出**的字段。
 *
 * 判断标准不是「看起来像不像密钥」，是「拿到它能干什么」：
 *
 * - telegram.bot_token —— 全部控制权，还能抢长轮询
 * - bark.key —— 能往人家通知栏塞东西（写能力）
 * - ntfy.token —— 显然
 * - **ntfy.topic —— 这条最容易漏**。它长得完全不像密钥，但在公共实例上
 *   知道 topic 就能订阅，拿到的是此后每一条验证码。这是**读**能力，
 *   比 bark key 的写能力严重得多。
 * - webhook.url —— Slack / Discord 这类的 webhook 地址把 token 写在路径里
 * - webhook.headers —— 通常是 Authorization
 * - webpush 的整份配置 —— endpoint 就是投递地址，vapid_private 是私钥
 */
export const CHANNEL_SECRETS: Record<string, string[]> = {
  telegram: ['bot_token'],
  bark: ['key'],
  ntfy: ['token', 'topic'],
  webhook: ['url', 'headers'],
  webpush: ['endpoint', 'p256dh', 'auth', 'vapid_public', 'vapid_private'],
}

/**
 * 没登记过的渠道类型一律整份脱掉。
 *
 * 默认行为必须是「不导出」而不是「忘了改白名单就漏出去」——
 * 加一个新 provider 时人会记得写 configSchema，不一定会记得回来改这里。
 */
export function redactChannelConfig(
  type: string, config: Record<string, unknown>,
): { config: Record<string, unknown>; removed: string[] } {
  const secrets = CHANNEL_SECRETS[type]
  if (!secrets) return { config: {}, removed: Object.keys(config) }
  const out: Record<string, unknown> = {}
  const removed: string[] = []
  for (const [k, v] of Object.entries(config)) {
    if (secrets.includes(k)) { removed.push(k); continue }
    out[k] = v
  }
  return { config: out, removed }
}

/**
 * 可以导出的 user_settings。**必须是白名单，不能是「除了这几个之外都导」。**
 *
 * 同一张表里还住着 totp_pending（还没确认完的 TOTP 种子）和 recovery_pending
 * （口令找回码的待验证状态）。「导出所有设置」听起来天经地义，
 * 而它会把这两样写进一个明文文件——这是最容易顺手踩的一脚。
 */
export const EXPORTABLE_USER_SETTINGS = ['timezone', 'notification_capture', 'battery_alerts', 'sms_command']

/**
 * 每种 user_setting 里不能导出的字段。
 *
 * 短信指令的口令字段叫 **`secret`**（见 protocol.ts 的 SmsCommandConfig），
 * 不叫 password——第一版按 `password` 写，于是口令被原样导进了明文文件，
 * 而单测因为造的假数据用的也是 `password` 所以一路绿灯。
 * 所以下面那条「字段名必须和真的 schema 对得上」的测试比脱敏本身还重要。
 *
 * 知道这个口令就能用短信查那台手机的电量、网络、**定位**。
 * 号码白名单和开关值得备份，口令不值得——恢复时重新生成一个即可。
 */
export const SETTING_SECRETS: Record<string, string[]> = {
  sms_command: ['secret'],
}

export function redactUserSetting(key: string, value: string): string {
  const secrets = SETTING_SECRETS[key]
  if (!secrets) return value
  try {
    const v = JSON.parse(value) as Record<string, unknown>
    for (const k of secrets) if (k in v) v[k] = null
    return JSON.stringify(v)
  } catch {
    // 解不开就整个丢掉：宁可少备份一项，也不要把一个没看懂的串原样吐出去
    return ''
  }
}

export interface BackupFile {
  version: number
  exported_at: number
  /** 提醒读到这个文件的人：它是明文的 */
  notice: string
  rules: { name: string; priority: number; enabled: boolean; match: unknown; action: unknown }[]
  tasks: {
    name: string; enabled: boolean; to: string; text: string
    sim_slot: number | null; schedule: unknown
  }[]
  channels: { type: string; name: string; enabled: boolean; config: Record<string, unknown>; missing: string[] }[]
  settings: Record<string, string>
}

export const BACKUP_NOTICE =
  '这是明文配置备份。渠道密钥、短信指令口令已经去掉，但规则、号码、'
  + '任务正文仍然是明文。请当作敏感文件保管，不要放进会自动同步的目录。'

/**
 * 导入时对一份文件做结构校验。
 *
 * 只检查「能不能安全地读」，不检查业务合法性——那交给各自的 zod schema，
 * 一条坏规则不该让整份文件导不进来。
 */
export function validateBackup(raw: unknown): { ok: true; file: BackupFile } | { ok: false; error: string } {
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: '不是一个 JSON 对象' }
  const f = raw as Partial<BackupFile>
  if (typeof f.version !== 'number') return { ok: false, error: '缺少 version 字段，这多半不是本系统导出的文件' }
  if (f.version > BACKUP_VERSION) {
    return { ok: false, error: `这份文件来自更新的版本（v${f.version}），当前只认到 v${BACKUP_VERSION}` }
  }
  for (const k of ['rules', 'tasks', 'channels'] as const) {
    if (f[k] !== undefined && !Array.isArray(f[k])) return { ok: false, error: `${k} 不是数组` }
  }
  return {
    ok: true,
    file: {
      version: f.version,
      exported_at: f.exported_at ?? 0,
      notice: f.notice ?? '',
      rules: f.rules ?? [],
      tasks: f.tasks ?? [],
      channels: f.channels ?? [],
      settings: f.settings ?? {},
    },
  }
}
