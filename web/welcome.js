/**
 * 落地页的下滑进场动效。
 *
 * 三条约束决定了它长这样：
 *
 * 1. **CSP 是 `script-src 'self'`，内联 <script> 一律被挡**，所以只能是这个独立文件。
 * 2. **JS 挂了内容必须照样看得见。** 所以「初始隐藏」这个状态**不写死在 CSS 里**，
 *    而是由这段脚本给 <html> 打上 data-motion="on" 之后才生效——脚本没跑、
 *    被拦截、或者出错，页面就是一张普通的静态页，一个字都不少。
 *    反过来写（CSS 先藏起来、等 JS 来显示）是常见做法，但它把「能不能读到内容」
 *    押在了脚本上，而这是一个介绍「怎么收验证码」的页面，读不到就等于没有。
 * 3. **不能有闪烁。** 所以这个文件在 <head> 里同步加载（不带 defer）：
 *    它必须在 body 开始绘制之前就把 data-motion 打上，否则用户会先看到内容、
 *    再看着它们消失、然后重新淡入。文件只有 1KB 出头，这点阻塞换的是不闪。
 */
;(function () {
  var root = document.documentElement

  // 系统设置里要求减少动画的人，直接不开——不是「动得慢一点」，是根本不动
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  if (reduce || !('IntersectionObserver' in window)) return

  root.setAttribute('data-motion', 'on')

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
    }, {
      // 元素露出一点就开始，而不是等它完全进视口——
      // 后者在长section上会让人滚过头了才看见动画
      threshold: 0.12,
      // 底部留 -8%：太靠近屏幕边缘触发会显得「卡了一下才动」
      rootMargin: '0px 0px -8% 0px',
    })

    for (var j = 0; j < items.length; j++) {
      /**
       * 首屏内的元素直接显示，不做进场。
       *
       * 页面刚打开时首屏元素已经在视口里，IntersectionObserver 会立刻回调，
       * 于是它们「淡入」得和滚动到的那些一样——但用户根本没滚动，
       * 看起来就是页面自己抖了一下。
       */
      if (items[j].getBoundingClientRect().top < window.innerHeight * 0.9) {
        items[j].setAttribute('data-shown', '')
      } else {
        io.observe(items[j])
      }
    }
  }

  /**
   * 横滑条第一次进入视口时，自己轻轻滑一下再滑回来。
   *
   * 截图条是整页唯一需要教一个手势的地方。一行「← 左右滑动 →」的提示字，
   * 读的人多、照做的人少；让它自己动 14 像素，「这东西能滑」就不用说了。
   *
   * 只做一次，而且用户已经自己滑过就不做——抢在人手底下动是很讨厌的。
   */
  function nudge() {
    var strip = document.querySelector('[data-nudge]')
    if (!strip || strip.scrollWidth <= strip.clientWidth) return
    var done = false
    var io = new IntersectionObserver(function (es) {
      if (done || !es[0].isIntersecting) return
      done = true
      io.disconnect()
      if (strip.scrollLeft > 0) return   // 人已经自己滑过了
      strip.scrollTo({ left: 14, behavior: 'smooth' })
      setTimeout(function () {
        if (strip.scrollLeft <= 16) strip.scrollTo({ left: 0, behavior: 'smooth' })
      }, 320)
    }, { threshold: 0.35 })
    io.observe(strip)
  }

  /**
   * 第一屏那三幕的滚动进度。
   *
   * 只做一件事：把 0→1 的进度写成 `--p`（以及重映射过的 `--fly`）。
   * 透明度、航线的揭开、鸽子的位置全部由 CSS 从这一个变量算出来——
   * 逐帧改样式的话，三幕十几个元素每帧都要碰一遍，滚动会发涩。
   *
   * 读 `getBoundingClientRect` 放在 rAF 里、写样式紧跟其后，一帧内
   * 只有一次读一次写，不会来回触发同步布局。
   */
  function stage() {
    var el = document.getElementById('stage')
    if (!el) return
    var inner = el.querySelector('.stage-in')
    var cue = document.getElementById('stage_cue_t')
    var ticking = false
    var lastCue = ''

    function frame() {
      ticking = false
      var span = el.offsetHeight - inner.offsetHeight
      if (span <= 0) return
      var p = -el.getBoundingClientRect().top / span
      if (p < 0) p = 0
      if (p > 1) p = 1
      el.style.setProperty('--p', p.toFixed(4))
      /*
       * 鸽子的飞行区间拉宽到 0.18–0.86。
       *
       * 原来是 0.25–0.75，两头各留四分之一什么都不动，滑起来像「推半天没反应」。
       * 现在它在第一幕快结束时就已经起飞、到第三幕淡入时才落地，
       * 加上手机的上浮与气泡的横移，整段滚动全程都有东西在响应。
       */
      var fly = (p - 0.18) / 0.68
      if (fly < 0) fly = 0
      if (fly > 1) fly = 1
      el.style.setProperty('--fly', fly.toFixed(4))

      /*
       * `--land` 只管第三幕那几秒：航线的最后一截被画出来、鸽子沉下去
       * 落到肩上、然后才开口。默认值写成 1（已落地），所以不跑 JS 或
       * 关了动效时它本来就站在肩上，而不是悬在半空等一个永远不来的信号。
       */
      var land = (p - 0.77) / 0.11
      if (land < 0) land = 0
      if (land > 1) land = 1
      el.style.setProperty('--land', land.toFixed(4))

      if (cue) {
        var t = p < 0.22 ? '往下滑' : p < 0.78 ? '继续往下滑' : '再往下，是正文'
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
   * 第一幕那台手机上的时间，取**读者自己**浏览器的。
   *
   * 写死一个 20:23 的代价不是不准，是不真：这一屏讲的是「此刻家里那台
   * 收到了一条」，而屏幕上挂着一个与读者无关的时间，整件事就退回成一张插图。
   *
   * HTML 里留了一个静态默认值，JS 没跑就用它——这一段是装饰，
   * 不值得为它多一个空白位。
   */
  function clock() {
    var d = new Date()
    var hh = String(d.getHours()).padStart(2, '0')
    var mm = String(d.getMinutes()).padStart(2, '0')
    var t = hh + ':' + mm
    var a = document.getElementById('ph_clock')
    var b = document.getElementById('ph_time')
    if (a) a.textContent = t
    if (b) b.textContent = t
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { start(); nudge(); stage(); clock() })
  } else {
    start()
    nudge()
    stage()
    clock()
  }
})()
