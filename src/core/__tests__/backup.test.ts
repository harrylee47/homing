/**
 * 配置备份的脱敏规则。
 *
 * 这组用例守的是一件事：**导出物是明文的，而它会经浏览器下载**——
 * 落在下载目录、大概率被网盘自动同步。漏脱一个字段的代价是一份
 * 可以直接冒充你的文件。
 */
import { describe, expect, it } from 'vitest'
import {
  BACKUP_VERSION, CHANNEL_SECRETS, EXPORTABLE_USER_SETTINGS,
  redactChannelConfig, redactUserSetting, SETTING_SECRETS, validateBackup,
} from '../backup.js'
import { SmsCommandConfig } from '../protocol.js'
import { PROVIDERS } from '../notifier.js'

describe('渠道密钥脱敏', () => {
  it('telegram 的 bot_token 不出现在导出里', () => {
    const r = redactChannelConfig('telegram', {
      bot_token: '8123:AAH', chat_id: '111', api_base: 'https://api.telegram.org', spoiler: true,
    })
    expect(r.config).toEqual({ chat_id: '111', api_base: 'https://api.telegram.org', spoiler: true })
    expect(r.removed).toContain('bot_token')
    expect(JSON.stringify(r.config)).not.toContain('AAH')
  })

  /**
   * ntfy 的 topic 是这批里最容易漏的：它长得完全不像密钥，
   * 但公共实例上知道 topic 就能订阅，拿到的是此后每一条验证码。
   */
  it('ntfy 的 topic 和 token 都脱掉 —— topic 本身就是订阅能力', () => {
    const r = redactChannelConfig('ntfy', {
      server: 'https://ntfy.sh', topic: 'homing-abcd1234efgh', token: 'tk_x', icon: 'https://a/b.png',
    })
    expect(r.config).toEqual({ server: 'https://ntfy.sh', icon: 'https://a/b.png' })
    expect(JSON.stringify(r.config)).not.toContain('homing-abcd1234efgh')
  })

  it('webhook 的 url 整个脱掉 —— Slack/Discord 把 token 写在路径里', () => {
    const r = redactChannelConfig('webhook', { url: 'https://hooks.slack.com/services/T/B/XXXX', headers: { authorization: 'Bearer x' } })
    expect(r.config).toEqual({})
    expect(JSON.stringify(r.config)).not.toContain('XXXX')
  })

  it('webpush 整份都不导 —— endpoint 就是投递地址，还带私钥', () => {
    const r = redactChannelConfig('webpush', {
      endpoint: 'https://fcm.googleapis.com/fcm/send/abc', p256dh: 'x', auth: 'y',
      vapid_private: 'secret', vapid_public: 'pub', label: 'Mac Chrome',
    })
    expect(JSON.stringify(r.config)).not.toContain('secret')
    expect(JSON.stringify(r.config)).not.toContain('fcm.googleapis.com')
  })

  /**
   * 默认行为必须是「不导出」。加一个新 provider 时人会记得写 configSchema，
   * 不一定会记得回来改脱敏表——那时漏出去的是全部字段。
   */
  it('没登记过的渠道类型整份脱掉，而不是原样导出', () => {
    const r = redactChannelConfig('某个还没写脱敏规则的新渠道', { token: '天大的秘密', name: 'x' })
    expect(r.config).toEqual({})
    expect(r.removed).toEqual(['token', 'name'])
  })

  /** 防止「加了 provider 忘了加脱敏规则」——这条会在新增渠道时直接报红 */
  it('每一个已注册的 provider 都要有脱敏规则', () => {
    for (const type of Object.keys(PROVIDERS)) {
      expect(CHANNEL_SECRETS[type], `渠道 ${type} 没有在 CHANNEL_SECRETS 里登记`).toBeDefined()
    }
  })
})

describe('user_settings 白名单', () => {
  /**
   * 同一张表里住着 totp_pending（没确认完的 TOTP 种子）和 recovery_pending
   * （找回码状态）。「导出所有设置」听起来天经地义，而它会把这两样
   * 写进一个明文文件。
   */
  it('TOTP 待绑种子与找回码状态不在白名单里', () => {
    expect(EXPORTABLE_USER_SETTINGS).not.toContain('totp_pending')
    expect(EXPORTABLE_USER_SETTINGS).not.toContain('recovery_pending')
  })

  it('时区、通知捕获、电量告警这些该导的在', () => {
    for (const k of ['timezone', 'notification_capture', 'battery_alerts']) {
      expect(EXPORTABLE_USER_SETTINGS).toContain(k)
    }
  })

  /**
   * **用真的 schema 造样本，不要手写字段名。**
   *
   * 第一版脱敏写的是 `password`，而 SmsCommandConfig 里那个字段实际叫
   * `secret`——于是口令被原样导进了明文文件。而当时的单测因为假数据用的
   * 也是 `password`，一路绿灯。手写 fixture 会把脱敏规则和真实结构一起写错，
   * 然后自己验证自己。
   */
  it('短信指令导出时去掉口令，保留号码白名单与开关', () => {
    const real = SmsCommandConfig.parse({
      enabled: true, secret: 'Xk7m2pQ9', allow_numbers: ['13800138000'], reply: true,
    })
    const v = redactUserSetting('sms_command', JSON.stringify(real))
    const p = JSON.parse(v) as Record<string, unknown>
    expect(v, '口令原样出现在导出里').not.toContain('Xk7m2pQ9')
    expect(p.secret).toBeNull()
    expect(p.enabled).toBe(true)
    expect(p.allow_numbers).toEqual(['13800138000'])
  })

  /**
   * 脱敏表里写的字段名必须真的存在于对应的 schema 上。
   * 字段改名或者一开始就写错时，这条会红——而只测「脱敏后不含某个串」
   * 的用例不会。
   */
  it('脱敏表里的字段名在真实 schema 上存在', () => {
    const shapes: Record<string, string[]> = {
      sms_command: Object.keys(SmsCommandConfig.shape),
    }
    for (const [key, fields] of Object.entries(SETTING_SECRETS)) {
      for (const f of fields) {
        expect(shapes[key], `没有登记 ${key} 的真实结构`).toBeDefined()
        expect(shapes[key], `${key}.${f} 在 schema 上不存在，脱敏形同虚设`).toContain(f)
      }
    }
  })

  it('其余设置原样导出', () => {
    expect(redactUserSetting('timezone', 'Asia/Tokyo')).toBe('Asia/Tokyo')
  })

  it('sms_command 解不开就整个丢掉，不原样吐出去', () => {
    expect(redactUserSetting('sms_command', '这不是 JSON')).toBe('')
  })
})

describe('导入时的结构校验', () => {
  const good = { version: BACKUP_VERSION, exported_at: 1, notice: '', rules: [], tasks: [], channels: [], settings: {} }

  it('认得出自家文件', () => {
    const r = validateBackup(good)
    expect(r.ok).toBe(true)
  })

  it('不是对象、没有 version 的一律拒绝并说清原因', () => {
    expect(validateBackup(null)).toMatchObject({ ok: false })
    expect(validateBackup('{}')).toMatchObject({ ok: false })
    const r = validateBackup({ rules: [] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('version')
  })

  it('来自更新版本的文件拒绝导入，而不是猜着读', () => {
    const r = validateBackup({ ...good, version: BACKUP_VERSION + 1 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain(`v${BACKUP_VERSION + 1}`)
  })

  it('缺了某一段就当空，不让整份文件导不进来', () => {
    const r = validateBackup({ version: BACKUP_VERSION })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.file.rules).toEqual([])
  })

  it('字段类型不对时明确指出是哪一段', () => {
    const r = validateBackup({ ...good, rules: 'oops' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('rules')
  })
})
