/* 沉浸模式翻页补丁（注入页面主世界执行）
 * 微信读书把「上一页/下一页」的响应绑在指针事件上，而且会拦截冒泡，
 * 所以：① 必须在主世界派发完整指针序列；② 用覆盖层接管左右两侧的点击。
 * 由主进程在每次页面加载后注入，内部幂等。
 */
(() => {
  const ATTR = '__wr_t'

  if (window.__wrTurn) {
    window.__wrTurn.sync()
    return 'page-turn already ready'
  }

  function pagerButton(dir) {
    const want = dir < 0 ? /上一页/ : /下一页/
    // 只能命中真正的按钮：外层容器的文字相同，但没有绑定事件
    const pools = [
      [...document.querySelectorAll('.renderTarget_pager_button')],
      [...document.querySelectorAll('button, [role="button"]')]
    ]
    for (const pool of pools) {
      const hit = pool.find(b => want.test((b.textContent || '').trim()))
      if (hit) return hit
    }
    return null
  }

  function press(btn) {
    const r = btn.getBoundingClientRect()
    const x = Math.round(r.x + r.width / 2)
    const y = Math.round(r.y + r.height / 2)
    const base = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, view: window }
    const seq = [
      [PointerEvent, 'pointerdown', { ...base, buttons: 1, pointerId: 1, isPrimary: true }],
      [MouseEvent, 'mousedown', { ...base, buttons: 1 }],
      [PointerEvent, 'pointerup', { ...base, buttons: 0, pointerId: 1, isPrimary: true }],
      [MouseEvent, 'mouseup', { ...base, buttons: 0 }],
      [MouseEvent, 'click', base]
    ]
    for (const [Ctor, type, opts] of seq) {
      try { btn.dispatchEvent(new Ctor(type, opts)) } catch (_) { btn.dispatchEvent(new Event(type, { bubbles: true })) }
    }
  }

  let lastTurn = 0
  function turn(dir) {
    if (!document.documentElement.hasAttribute(ATTR)) return false
    const now = Date.now()
    if (now - lastTurn < 200) return false // 滚轮连发时不要一次翻多页
    const btn = pagerButton(dir)
    if (!btn) return false
    lastTurn = now
    press(btn)
    return true
  }

  /* 书籍内的浮层（热门想法 / 划线笔记 / 想法详情）打开时，滚轮和点击都必须归浮层自己。
     否则补丁会把滚轮当成"翻页"，派发点击到下一页按钮——浮层随之被站点关掉，
     表现为「滚一下热门想法就消失并翻页」。 */
  /* 只用「真正承载面板内容」的容器判断，不能用 [class*=float_panel] 通配：
     页面上常驻着几个 pointer-events:none 的全屏 wrapper（top_reviews / search /
     review_with_range），通配会把它们也算成浮层，导致正文滚轮永久失效。 */
  const PANEL_SEL = '.reviews_panel, .reader_float_panel_container, .float_panel_position_wrapper'
  function panelOpen() {
    const list = document.querySelectorAll('.reviews_panel, .reader_float_panel_container, .float_panel_position_wrapper')
    for (const el of list) {
      const cs = getComputedStyle(el)
      if (cs.display === 'none' || cs.visibility === 'hidden') continue
      if (parseFloat(cs.opacity) === 0) continue
      const r = el.getBoundingClientRect()
      if (r.width > 150 && r.height > 150) return true   // 关闭态是 0×0 或 display:none
    }
    return false
  }
  function insidePanel(target) {
    try { return !!(target && target.closest && target.closest(PANEL_SEL)) } catch (_) { return false }
  }

  function setStyle(el, props) {
    for (const k in props) el.style.setProperty(k, props[k], 'important')
  }

  function makeZone(side, arrow, dir, top) {
    const z = document.createElement('div')
    z.textContent = arrow
    setStyle(z, {
      // 右侧点击区从书签角标下方开始：透明模式保留了右上角「添加书签」，
      // 它正好落在右侧 13% 的顶部，不能让翻页区把它盖住。
      // 注意书签按钮会在 y3~73 与 y72~142 之间跳动（站点 hover 时下移 70px），
      // 所以让出的是整个 3~142 区间，而不是只让 84px —— 否则按钮下移后被盖住，
      // 既点不到、也会让 hover 探测拿不到真实命中元素。
      position: 'fixed', top: top || '0', bottom: '0', width: '13%',
      // z-index 必须低于书籍浮层（.reader_float_top_reviews_panel_wrapper 是 99999），
      // 否则浮层两侧 13% 的点击会被点击区吞掉
      [side]: '0', 'z-index': '9998',
      display: 'none', 'align-items': 'center', 'justify-content': 'center',
      cursor: 'pointer', background: 'transparent',
      'font-size': '34px', 'line-height': '1',
      color: 'rgba(120,120,120,0)', 'font-family': '"Microsoft YaHei",sans-serif',
      transition: 'color .15s', 'user-select': 'none', '-webkit-app-region': 'no-drag'
    })
    z.addEventListener('mouseenter', () => z.style.setProperty('color', 'rgba(120,120,120,.5)', 'important'))
    z.addEventListener('mouseleave', () => z.style.setProperty('color', 'rgba(120,120,120,0)', 'important'))
    z.addEventListener('click', e => {
      e.preventDefault()
      e.stopPropagation()
      if (panelOpen()) return      // 浮层打开时点击区让位
      turn(dir)
    })
    document.body.appendChild(z)
    return z
  }

  const zonePrev = makeZone('left', '‹', -1, '0')
  const zoneNext = makeZone('right', '›', 1, '152px')

  // 沉浸模式（<html __wr_t>）开启时显示左右点击区
  function sync() {
    const on = document.documentElement.hasAttribute(ATTR)
    const d = on ? 'flex' : 'none'
    zonePrev.style.setProperty('display', d, 'important')
    zoneNext.style.setProperty('display', d, 'important')
    if (on && document.body) {
      if (!document.body.contains(zonePrev)) document.body.appendChild(zonePrev)
      if (!document.body.contains(zoneNext)) document.body.appendChild(zoneNext)
    }
  }

  new MutationObserver(sync).observe(document.documentElement, {
    attributes: true, attributeFilter: [ATTR]
  })

  // 滚轮翻页（浮层打开时完全不接管，滚轮只用来浏览浮层内容）
  window.addEventListener('wheel', e => {
    if (!document.documentElement.hasAttribute(ATTR)) return
    if (Math.abs(e.deltaY) < 2) return
    if (panelOpen() || insidePanel(e.target)) return
    turn(e.deltaY > 0 ? 1 : -1)
  }, { passive: true, capture: true })

  // ←/→ 、PageUp/PageDown：交给站点自己的键盘翻页，这里绝不能再翻一次
  // （早先自行派发指针事件，导致按键时"站点翻一页 + 补丁再翻一页"= 一次跳两页）

  window.__wrTurn = { sync, turn }
  sync()
  return 'page-turn ready'
})()
