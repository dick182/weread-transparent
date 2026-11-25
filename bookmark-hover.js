/* 透明模式右上角「添加书签」角标的显隐控制（页面主世界，幂等注入）。
 *
 * 为什么不用 CSS :hover：
 *   站点点完书签会给 wrapper 加 _hasBookmark 类、重建节点，并把 actionArea 在
 *   y3~73 与 y72~142 两个位置之间挪动。只要隐藏规则带 transition，新节点就会先以
 *   站点默认可见态露一下 → 用户看到「鼠标移走后上方又闪一个书签」。
 *
 * 为什么不用 getBoundingClientRect 缓存做热区：
 *   按钮位置本身在动（见上），250ms 的 rect 缓存会让判断滞后半拍，鼠标明明在按钮上
 *   却判成不在（或反之），表现成忽隐忽现。
 *
 * 现在：优先用 document.elementFromPoint / 事件 target 做真实命中测试，只在被翻页
 * 点击区挡住时退回 rect 比较；只切 <html> 上的 __wr_bm 属性，CSS 依属性瞬时显隐
 * 整棵子树（含 wrapper 自身与伪元素），与站点节点重建完全解耦。 */
(() => {
  if (window.__wrBmHover) return
  window.__wrBmHover = true

  const AREA = '[class*="float_corner_bookmark_actionArea"]:not([class*="actionArea_"])'
  let mx = -1, my = -1

  function setHover(on) {
    const d = document.documentElement
    if (on) {
      if (!d.hasAttribute('__wr_bm')) d.setAttribute('__wr_bm', '1')
    } else if (d.hasAttribute('__wr_bm')) {
      d.removeAttribute('__wr_bm')
    }
  }

  function inArea(el) {
    return !!(el && el.closest && el.closest(AREA))
  }

  /* 站点 hover 时会把按钮从 y3~73 滑到 y72~142（露出「点击添加书签」文字），
     鼠标停在原处就会一会儿在按钮上、一会儿不在 → 反复显隐。
     所以热区取两个位置的并集：横向跟按钮左右，纵向固定 0~150。 */
  function inHotZone(x, y) {
    if (y < -2 || y > 150) return false
    const a = document.querySelector(AREA)
    const r = a ? a.getBoundingClientRect() : null
    const right = r && r.width > 0 ? r.right : window.innerWidth - 30
    const left = r && r.width > 0 ? r.left : window.innerWidth - 210
    return x >= left - 14 && x <= right + 14
  }

  function check() {
    if (mx < 0 || my < 0) return setHover(false)
    // ① 真实命中：鼠标正下方就是按钮（或其子元素）——最快、最准
    if (inArea(document.elementFromPoint(mx, my))) return setHover(true)
    // ② 并集热区：按钮在滑动途中、或被翻页点击区挡住时兜底
    setHover(inHotZone(mx, my))
  }

  // mousemove 直接同步判定：窗口在后台时 requestAnimationFrame 不触发，
  // 用 rAF 节流会让 hover 判定卡住不动，只能等定时校准，表现成「移上去半天才亮」。
  document.addEventListener('mousemove', e => {
    mx = e.clientX; my = e.clientY
    check()
  }, { passive: true, capture: true })

  // 鼠标静止时站点可能重建节点（点击加/移除书签），定期校准一次状态
  setInterval(() => { if (mx >= 0) check() }, 200)

  // 鼠标离开窗口时立即收起，避免切回来还亮着
  document.addEventListener('mouseleave', () => setHover(false), { passive: true })
  window.addEventListener('blur', () => setHover(false), { passive: true })
})()
