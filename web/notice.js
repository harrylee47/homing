/**
 * 通知页：公告 + 公开邀请码。
 *
 * 一件事贯穿全文：**这一页显示的每一个字都来自别人**——公告是运营者敲的，
 * 邀请码是服务端给的。所以全程只用 `textContent` 与 `createElement`，
 * 一次 `innerHTML` 都不出现。
 *
 * 这不是过度谨慎：管理员在后台写公告，正文原样存进库、原样发给所有未登录的
 * 访客。哪天管理员账号被撞开，`innerHTML` 就是一条从后台直通所有访客浏览器
 * 的脚本注入路径——而这台网关的每个用户账号里都是银行验证码。
 * 服务端那边也不做 HTML 转义，因为转义意味着「打算当 HTML 用」。
 */
;(function () {
  /*
   * 这个文件在 <head> 里同步加载（和落地页同一个理由：不要先绘制再改）。
   * 所以**元素要等 DOM 解析完才拿得到**——直接在顶层 getElementById
   * 拿到的是三个 null，页面会永远停在「加载中…」，而且一声不吭。
   */
  var annBox, invBox, invNote

  function el(tag, cls, text) {
    var n = document.createElement(tag)
    if (cls) n.className = cls
    if (text !== undefined && text !== null) n.textContent = String(text)
    return n
  }

  function empty(box, text) {
    box.replaceChildren(el('p', 'empty', text))
  }

  /** 「3 天后过期」这种相对说法比一串时间戳好读，但过去式要说清楚是过去 */
  function rel(ts) {
    var d = ts - Date.now()
    var abs = Math.abs(d)
    var unit = abs < 3_600_000 ? [Math.round(abs / 60_000), '分钟']
      : abs < 86_400_000 ? [Math.round(abs / 3_600_000), '小时']
      : [Math.round(abs / 86_400_000), '天']
    return d >= 0 ? unit[0] + ' ' + unit[1] + '后过期' : unit[0] + ' ' + unit[1] + '前过期'
  }

  function when(ts) {
    var d = new Date(ts)
    var p = function (n) { return String(n).padStart(2, '0') }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
  }

  function renderAnnouncements(list) {
    if (!list.length) return empty(annBox, '暂无公告。')
    var frag = document.createDocumentFragment()
    for (var i = 0; i < list.length; i++) {
      var a = list[i]
      var card = el('article', 'ann')
      var h = el('h3')
      h.appendChild(el('span', null, a.title))
      if (a.pinned) h.appendChild(el('span', 'pin', '置顶'))
      card.appendChild(h)
      card.appendChild(el('p', 'body', a.body))
      var t = el('time', null, when(a.updated_at))
      t.setAttribute('datetime', new Date(a.updated_at).toISOString())
      card.appendChild(t)
      frag.appendChild(card)
    }
    annBox.replaceChildren(frag)
  }

  /**
   * 「复制」按钮的回落和落地页那颗是同一件事：`navigator.clipboard` 要安全
   * 上下文，http 的自建部署上拿不到。不给回落的话按钮是点了没反应，
   * 而这颗按钮就是这一屏的全部用处。
   */
  function copyBtn(code) {
    var b = el('button', 'sm', '复制')
    b.type = 'button'
    var back = 0
    b.addEventListener('click', function () {
      var done = function (word) {
        clearTimeout(back)
        b.textContent = word
        back = setTimeout(function () { b.textContent = '复制' }, 1800)
      }
      var select = function () {
        var node = b.parentNode && b.parentNode.querySelector('.ivc')
        if (node && window.getSelection && document.createRange) {
          var r = document.createRange()
          r.selectNodeContents(node)
          var s = window.getSelection()
          s.removeAllRanges()
          s.addRange(r)
        }
        done('已选中')
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(code).then(function () { done('已复制') }, select)
      } else select()
    })
    return b
  }

  function renderInvites(list, open) {
    if (!list.length) {
      return empty(invBox, '现在没有公开的邀请码。管理员放出新的之后会出现在这里。')
    }
    var frag = document.createDocumentFragment()
    for (var i = 0; i < list.length; i++) {
      var v = list[i]
      var alive = v.state === 'open'
      var row = el('div', 'inv' + (alive ? '' : ' gone'))
      row.appendChild(el('span', 'ivc', v.code))
      row.appendChild(el('span', 'badge ' + (alive ? 'ok' : v.state === 'used' ? 'err' : 'plain'),
        alive ? '可用' : v.state === 'used' ? '已使用' : '已过期'))
      if (v.state !== 'used') row.appendChild(el('span', 'when', rel(v.expires_at)))
      // 只给还能用的码配按钮：给一个已经用掉的码配「复制」是在骗人白跑一趟
      if (alive && open) row.appendChild(copyBtn(v.code))
      frag.appendChild(row)
    }
    invBox.replaceChildren(frag)
  }

  function boot() {
    annBox = document.getElementById('ann')
    invBox = document.getElementById('inv')
    invNote = document.getElementById('inv_note')
    if (!annBox || !invBox) return
    load()
  }

  function load() {
    fetch('/api/notice', { headers: { accept: 'application/json' } })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status)
        return r.json()
      })
      .then(function (d) {
        renderAnnouncements(d.announcements || [])
        renderInvites(d.invites || [], d.open !== false)
        if (d.open === false) {
          invNote.textContent = '· 这台网关当前关闭了自助注册，码暂时用不了'
        }
      })
      .catch(function () {
        empty(annBox, '取不到公告。可能是这台网关正在重启，过一会儿刷新试试。')
        empty(invBox, '取不到邀请码。')
      })
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
  else boot()
})()
