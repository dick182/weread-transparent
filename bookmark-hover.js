/* 透明模式右上角「添加书签」角标的显隐控制（页面主世界，幂等注入）。
 *
 * 为什么不用 CSS :hover：
 *   站点在点击添加/移除书签后会给 wrapper 加上 _hasBookmark 类并重建节点，
 *   新节点带着站点默认样式出现；如果隐藏规则带 transition，就会先以 opacity:1
 *   露一下再淡出，看起来像「鼠标移走后又闪现一个书签按钮」。
 *
 * 这里改成：用鼠标坐标判断右上角热区，只切换 <html> 上的 __wr_bm 属性，
 * CSS 依据属性瞬时显隐整套书签子树（无 transition），与站点节点重建完全解耦。
 * 不创建遮挡层，站点的 hover / click 事件链保持原样。 */
(() => {
  if (window.__wrBmHover) return
  window.__wrBmHover = true

  const AREA_SEL = '[class*="float_corner_bookmark_actionArea"]:not([class*="actionArea_"])'
  let rect = null
  let lastCheck = 0

  function currentRect() {
    const now = Date.now()
    // 站点会重建节点，rect 定期刷新即可；避免每次 mousemove 都查 DOM
    if (!rect || now - lastCheck > 250) {
      lastCheck = now
      const a = document.querySelector(AREA_SEL)
      rect = a ? a.getBoundingClientRect() : null
    }
    return rect
  }

  function setHover(on) {
    const d = document.documentElement
    if (on) {
      if (!d.hasAttribute('__wr_bm')) d.setAttribute('__wr_bm', '1')
    } else if (d.hasAttribute('__wr_bm')) {
      d.removeAttribute('__wr_bm')
    }
  }

  document.addEventListener('mousemove', e => {
    const r = currentRect()
    // 热区 = 书签按钮矩形向外扩一圈，向下多留 40px 便于从正文移上来
    const inHot = !!r && r.width > 0 &&
      e.clientX >= r.left - 12 && e.clientX <= r.right + 12 &&
      e.clientY >= r.top - 12 && e.clientY <= r.bottom + 40
    setHover(inHot)
  }, { passive: true, capture: true })

  // 鼠标离开窗口时立即收起，避免切回来还亮着
  document.addEventListener('mouseleave', () => setHover(false), { passive: true })
  window.addEventListener('blur', () => setHover(false), { passive: true })
})()
