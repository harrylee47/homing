/**
 * 落地页 v2 的滚动动效。
 *
 * 与 v1（welcome.js）的分工：两版落地页并存，/welcome 是 v1、/welcome2 是 v2，
 * 各带各的脚本。共用的部分（进场、横滑提示、取本机时间）是照抄的，
 * 真正不同的只有 stage2() 与 copy()。
 *
 * v1 的三条约束在这里同样成立，不再重复论证（见 welcome.js 开头）：
 * CSP 只允许同源外链脚本、JS 挂了内容必须照样看得见、脚本要在 <head> 同步加载。
 *
 * **但「JS 挂了长什么样」这一条的答案不一样。**
 * v1 的第一屏是一段叙事动画，没有动画就没有意义，所以不跑 JS 时它把二、三幕
 * 藏起来。v2 的第一屏是一张**说明链路的图**——家里那台 → 加密 → 云 → 你那台——
 * 它静止时本来就读得懂。所以 v2 的默认状态是**整条链路已经走完**：
 * CSS 里每一处都写 `var(--p, 1)`，不给值就是「已送达」。
 *
 * 代价是反过来的：脚本必须赶在 body 绘制之前把 --p 摁到 0，否则读者会先看到
 * 走完的样子、再看着它倒回去重走。所以下面那行 setProperty 必须在这里，
 * 不能挪进 DOMContentLoaded。--p 挂在 :root 上也是为这个——
 * 这一刻 .stage 还没被解析出来。
 */
;(function () {
  var root = document.documentElement

  // 系统设置里要求减少动画的人，直接不开——不是「动得慢一点」，是根本不动。
  // 这时候 --p 保持未设置，于是那张图就是一张画完的静态链路图。
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  var motion = !reduce && ('IntersectionObserver' in window)

  if (motion) {
    root.setAttribute('data-motion', 'on')
    root.style.setProperty('--p', '0')
  }

  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v }

  function start() {
    var items = document.querySelectorAll('[data-reveal]')
    if (!items.length) return

    var io = new IntersectionObserver(function (entries) {
      for (var i = 0; i < entries.length; i++) {
        var e = entries[i]
        if (!e.isIntersecting) continue
        e.target.setAttribute('data-shown', '')
        io.unobserve(e.target)   // 只进场一次，来回滚不要反复闪
      }
    }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' })

    for (var i = 0; i < items.length; i++) {
      // 首屏之内的直接置为已显示：它们本来就在视口里，做进场等于页面自己抖一下
      if (items[i].getBoundingClientRect().top < window.innerHeight * 0.9) {
        items[i].setAttribute('data-shown', '')
      } else io.observe(items[i])
    }
  }

  /** 截图条第一次进入视口时自己滑一下，把「这东西能滑」演出来。见 welcome.js */
  function nudge() {
    var strip = document.querySelector('[data-nudge]')
    if (!strip || strip.scrollWidth <= strip.clientWidth) return
    var done = false
    var io = new IntersectionObserver(function (es) {
      if (done || !es[0].isIntersecting) return
      done = true
      io.disconnect()
      if (strip.scrollLeft > 0) return
      strip.scrollTo({ left: 14, behavior: 'smooth' })
      setTimeout(function () {
        if (strip.scrollLeft <= 16) strip.scrollTo({ left: 0, behavior: 'smooth' })
      }, 320)
    }, { threshold: 0.35 })
    io.observe(strip)
  }

  /**
   * 链路的滚动进度。
   *
   * 写三个自定义属性，其余全部由 CSS 从它们算出来：
   *
   * - `--p`    0→1 总进度。导线的生长、数据包的位置、明文与打码的交叉淡、
   *            两站的高亮环、状态梯的三个点，都是它的 calc()。
   * - `--mid`  数据包在中间那一段里的进度（0→1）。它是 --p 的重映射：
   *            镜头从 p=0.20 才开始走那条线、到 0.82 走完，两头留给首尾两个场景。
   *            导线的生长、包的位置、两站的高亮环都读它。
   * - `--land` 最后一段：线尾从两幕的接缝往下长到手机里，那颗点跟着它走，
   *            中段那颗同时淡出——从头到尾只有一颗点在动。
   * - `--wake` 鸽子抬头。单独一个是因为它要在 CSS 里乘上 deg，
   *            而 `clamp(0, calc(...), 1)` 这种无单位夹取写在 calc 里可读性太差。
   *
   * 两个的默认值都是 1（走完 / 醒着），和 --p 的默认值 1 是一套的：
   * 不跑 JS 时这三段是完成态，而不是「等一个永远不来的信号」。
   */
  function stage2() {
    var el = document.getElementById('stage')
    if (!el || !motion) return
    var inner = el.querySelector('.stage-in')
    var cue = document.getElementById('stage_cue_t')
    var where = document.getElementById('v2_where')

    /*
     * 方案里的 Scene 06：家里那台不动，**你在动**。所以随着下滑换地点，
     * 而不是换画面——「短信跟着你走」这句话只有在你的位置一直变、
     * 而链路一直通的时候才立得住。
     */
    var WHERE = [[0.35, '在路上'], [0.58, '地铁上'], [0.80, '咖啡馆'], [1.01, '机场']]
    var lastWhere = '', lastCue = '', swapTimer = 0, ticking = false

    function frame() {
      ticking = false
      var span = el.offsetHeight - inner.offsetHeight
      if (span <= 0) return
      var p = clamp01(-el.getBoundingClientRect().top / span)

      root.style.setProperty('--p', p.toFixed(4))
      root.style.setProperty('--wake', clamp01((p - 0.005) / 0.022).toFixed(3))
      root.style.setProperty('--mid', clamp01((p - 0.10) / 0.70).toFixed(4))
      root.style.setProperty('--land', clamp01((p - 0.80) / 0.11).toFixed(4))

      if (where) {
        var w = ''
        for (var i = 0; i < WHERE.length; i++) {
          if (p < WHERE[i][0]) { w = WHERE[i][1]; break }
        }
        if (w && w !== lastWhere) {
          lastWhere = w
          // 直接换字会「啪」地跳一下。淡出 → 换 → 淡入，130ms 对齐 CSS 里的 transition
          where.setAttribute('data-swap', '')
          clearTimeout(swapTimer)
          swapTimer = setTimeout(function () {
            where.textContent = lastWhere
            where.removeAttribute('data-swap')
          }, 130)
        }
      }

      if (cue) {
        /* 提示要跟着分镜走：先「看一眼」，再「传过去」，最后「这就到了」 */
        var t = p < 0.04 ? '下滑查看' : p < 0.13 ? '下滑，把它传过去'
              : p < 0.88 ? '继续下滑' : '往下看它怎么用'
        if (t !== lastCue) { cue.textContent = t; lastCue = t }
      }
    }

    function onScroll() {
      if (ticking) return
      ticking = true
      requestAnimationFrame(frame)
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    frame()
  }

  /**
   * 通知横幅上那颗「复制」。
   *
   * 这是整页唯一一处真交互，留着是因为它演示的正是这个产品日常体感最好的
   * 一下：验证码到了手边，长按即复制，不用打开任何 App。
   *
   * `navigator.clipboard` 要安全上下文。自托管的人可能跑在 http 的内网地址上，
   * 那里它是 undefined。不给回落的话按钮在那种部署上是**点了没反应**——
   * 偏偏这一下就是这一屏想说的事，所以回落成「把那串码选中」，
   * 让人自己按一下系统的复制。
   */
  function copy() {
    var btn = document.getElementById('v2_copy')
    var code = document.getElementById('v2_code')
    if (!btn || !code) return
    var back = 0

    function ok() {
      clearTimeout(back)
      btn.textContent = '已复制'
      btn.setAttribute('data-done', '')
      back = setTimeout(function () {
        btn.textContent = '复制'
        btn.removeAttribute('data-done')
      }, 1800)
    }
    /*
     * 回落也要给反馈。只是把码选中、按钮一动不动的话，从用户那边看
     * 「点了没反应」和「点了失败」长得一模一样——而这颗按钮整屏就这一个作用。
     */
    function select() {
      if (!window.getSelection || !document.createRange) return
      var r = document.createRange()
      r.selectNodeContents(code)
      var s = window.getSelection()
      s.removeAllRanges()
      s.addRange(r)
      clearTimeout(back)
      btn.textContent = '已选中'
      btn.setAttribute('data-done', '')
      back = setTimeout(function () {
        btn.textContent = '复制'
        btn.removeAttribute('data-done')
      }, 1800)
    }

    btn.addEventListener('click', function () {
      var text = (code.textContent || '').trim()
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(ok, select)
      } else select()
    })
  }

  /**
   * 家里那台上的时间，取**读者自己**浏览器的。
   * 写死一个时间的代价不是不准，是不真：这一屏讲的是「此刻家里那台收到了一条」。
   */
  function clock() {
    var d = new Date()
    var t = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
    var a = document.getElementById('v2_clock')
    if (a) a.textContent = t
  }

  function boot() { start(); nudge(); stage2(); copy(); clock() }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
  else boot()
})()
