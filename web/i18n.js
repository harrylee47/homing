/**
 * 界面语言：中文 / 英文。
 *
 * **中文是源语言**（代码里的字面量就是中文），英文靠一张词表翻过去。
 * 反过来做要动三千处字面量，而这个控制台是零构建的 vanilla JS，
 * 那种规模的机械改动带来的回归风险远大于收益。
 *
 * ── 为什么只做「整串精确匹配」，不做片段替换 ──────────────────
 *
 * 这个控制台显示的是**短信正文**。片段替换意味着词表里的「验证码」
 * 会把一条真实短信「您的验证码是 778899」改成「您的 code 是 778899」——
 * 用户的数据被界面翻译弄脏，而且不可逆、不可见。
 *
 * 所以：先查整串（trim 之后完全相等才算命中），命中不了再试一小撮
 * **整串锚定**（^...$）的正则，用来对付 `${n} 条规则` 这类插值出来的串。
 * 两条路径都不可能命中一条真实短信。
 *
 * ── 为什么补 Element.prototype.innerHTML ─────────────────────
 *
 * app.js 里有 86 处 `innerHTML =`、95 处 `textContent =`。挨个包一层要改 181 处，
 * 而这个页面的 CSP 是 `default-src 'none'; script-src 'self'`，没有任何第三方脚本
 * 会被这个补丁波及。补在原型上等于一处改动覆盖全部写入点，
 * 漏掉一处的后果（半中半英）比补丁本身的风险大得多。
 */
;(function () {
  var KEY = 'gw_lang'

  function detect() {
    try {
      var v = localStorage.getItem(KEY)
      if (v === 'zh' || v === 'en') return v
    } catch (e) { /* 隐私模式 */ }
    // 没选过就跟浏览器：中文用中文，其余一律英文
    var nav = (navigator.language || navigator.userLanguage || 'en')
    return /^zh\b/i.test(nav) ? 'zh' : 'en'
  }

  var LANG = detect()
  var DICT = (window.I18N_EN && window.I18N_EN.exact) || {}
  var RULES = []
  var raw = (window.I18N_EN && window.I18N_EN.rules) || []
  for (var i = 0; i < raw.length; i++) {
    try { RULES.push([new RegExp(raw[i].pattern), raw[i].to]) } catch (e) { /* 坏规则跳过，不能拖垮整页 */ }
  }

  /** 一个串。命中就换，命中不了原样返回——**永远不返回半成品**。 */
  function t(s) {
    if (LANG === 'zh' || typeof s !== 'string' || !s) return s
    var key = s.trim()
    if (!key) return s
    var hit = DICT[key]
    if (hit !== undefined) return s.replace(key, hit)
    for (var i = 0; i < RULES.length; i++) {
      if (RULES[i][0].test(key)) return s.replace(key, key.replace(RULES[i][0], RULES[i][1]))
    }
    return s
  }

  var CJK = new RegExp("[\\u4e00-\\u9fff]")

  // 要翻的属性值。其余属性（class/href/id…）碰都不碰
  var ATTR = /\s(placeholder|title|aria-label|alt)="([^"]*)"/g

  /** 一段 HTML：只动标签之间的文本与上面那几个属性，标签本身一个字符不改。 */
  function tHtml(html) {
    if (LANG === 'zh') return html
    // 没有中文就原样回去，省掉整轮正则（控制台里大部分写入是纯数据）
    if (typeof html !== 'string' || !CJK.test(html)) return html
    var out = html.replace(ATTR, function (m, k, v) { return ' ' + k + '="' + t(v) + '"' })
    return out.replace(/(^|>)([^<>]+)(?=<|$)/g, function (m, lead, text) { return lead + t(text) })
  }

  /** 已经在文档里的静态页（落地页、通知页）：走一遍 DOM。 */
  function tDom(root) {
    if (LANG === 'zh') return
    var w = document.createTreeWalker(root || document.body, NodeFilter.SHOW_TEXT, null)
    var nodes = []
    while (w.nextNode()) nodes.push(w.currentNode)
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i]
      // <script>/<style> 里的文本不能碰
      var p = n.parentNode && n.parentNode.nodeName
      if (p === 'SCRIPT' || p === 'STYLE') continue
      var v = t(n.nodeValue)
      if (v !== n.nodeValue) n.nodeValue = v
    }
    var attrs = ['placeholder', 'title', 'aria-label', 'alt']
    var all = (root || document.body).querySelectorAll('[placeholder],[title],[aria-label],[alt]')
    for (var j = 0; j < all.length; j++) {
      for (var k = 0; k < attrs.length; k++) {
        var cur = all[j].getAttribute(attrs[k])
        if (cur) { var nv = t(cur); if (nv !== cur) all[j].setAttribute(attrs[k], nv) }
      }
    }
  }

  /**
   * 把写入点全接管掉。
   *
   * **必须在任何渲染之前装上**，所以这个文件要排在页面脚本前面。
   * 中文时一个补丁都不装：源语言就是中文，走原生路径零开销。
   */
  function patch() {
    if (LANG === 'zh') return
    // 标出来给 CSS 用：英文词比两个汉字长得多，底部那七格导航要单独收一收字号
    document.documentElement.lang = 'en'
    var eD = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML')
    if (eD && eD.set) {
      Object.defineProperty(Element.prototype, 'innerHTML', {
        configurable: true, enumerable: eD.enumerable,
        get: eD.get,
        /*
         * `el.innerHTML = null` 按规范是**清空**（LegacyNullToEmptyString），
         * 不是写进字符串 "null"。原样把 null/undefined 透传给原生 setter——
         * 在这里 String() 它会让页面上凭空长出一个 "null"。
         */
        set: function (v) { eD.set.call(this, v == null ? v : tHtml(v)) },
      })
    }
    /*
     * 原生对话框也要接管。
     *
     * 它们不经过 innerHTML/textContent，所以上面那两个补丁够不着——
     * 表现是英文界面上突然弹出一个中文的「确定要删除吗」，
     * 而那恰恰是**不可逆操作前最后一次确认**，看不懂就只能瞎点。
     * app.js 里有 20 多处 confirm。
     */
    var nativeConfirm = window.confirm
    window.confirm = function (msg) { return nativeConfirm.call(window, t(String(msg == null ? '' : msg))) }
    var nativeAlert = window.alert
    window.alert = function (msg) { return nativeAlert.call(window, t(String(msg == null ? '' : msg))) }
    var nativePrompt = window.prompt
    window.prompt = function (msg, def) {
      return nativePrompt.call(window, t(String(msg == null ? '' : msg)), def)
    }

    var nD = Object.getOwnPropertyDescriptor(Node.prototype, 'textContent')
    if (nD && nD.set) {
      Object.defineProperty(Node.prototype, 'textContent', {
        configurable: true, enumerable: nD.enumerable,
        get: nD.get,
        // 同上：textContent = null 是清空，不是写 "null"
        set: function (v) { nD.set.call(this, v == null ? v : t(String(v))) },
      })
    }
  }
  patch()

  /**
   * 静态页（落地页、通知页）用：正文已经在文档里，只能翻完 DOM 再让它显示。
   *
   * 英文时先把整页藏起来，翻完再放出来——否则会先闪一屏中文。
   * **只在脚本真的跑起来时才藏**：不跑 JS 就一行样式都没设，
   * 页面照常是一张中文静态页，一个字都不少（落地页那条硬要求）。
   */
  function static_() {
    if (LANG === 'zh') return
    var root = document.documentElement
    root.style.visibility = 'hidden'
    var done = false
    function go() {
      if (done) return
      done = true
      try {
        tDom(document.body)
        // 标题与 description 在 <head> 里，tDom 走的是 body，得单独来一趟。
        // 落地页是这个项目唯一希望被搜到的页面，这两项正是搜索结果里显示的东西
        if (document.title) document.title = t(document.title)
        var md = document.querySelector('meta[name="description"]')
        if (md) md.setAttribute('content', t(md.getAttribute('content') || ''))
      } catch (e) { /* 翻译失败也得把页面放出来 */ }
      root.lang = 'en'
      root.style.visibility = ''
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go)
    else go()
    // 兜底：万一 DOMContentLoaded 因为什么原因没来，别把页面永远藏着
    setTimeout(go, 3000)
  }

  window.I18N = {
    lang: LANG,
    static: static_,
    t: t,
    tHtml: tHtml,
    tDom: tDom,
    /** 切语言要整页重载：补丁装在原型上，已经渲染出来的东西改不回去。 */
    set: function (v) {
      try { localStorage.setItem(KEY, v) } catch (e) { /* 隐私模式下切不了，无妨 */ }
      location.reload()
    },
  }
})()
