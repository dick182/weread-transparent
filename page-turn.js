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

  function setStyle(el, props) {
    for (const k in props) el.style.setProperty(k, props[k], 'important')
  }

  function makeZone(side, arrow, dir) {
    const z = document.createElement('div')
    z.textContent = arrow
    setStyle(z, {
      position: 'fixed', top: '0', bottom: '0', width: '13%',
      [side]: '0', 'z-index': '2147482995',
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
      turn(dir)
    })
    document.body.appendChild(z)
    return z
  }

  const zonePrev = makeZone('left', '‹', -1)
  const zoneNext = makeZone('right', '›', 1)

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

  // 滚轮翻页
  window.addEventListener('wheel', e => {
    if (!document.documentElement.hasAttribute(ATTR)) return
    if (Math.abs(e.deltaY) < 2) return
    turn(e.deltaY > 0 ? 1 : -1)
  }, { passive: true })

  // ←/→ 、PageUp/PageDown：交给站点自己的键盘翻页，这里绝不能再翻一次
  // （早先自行派发指针事件，导致按键时"站点翻一页 + 补丁再翻一页"= 一次跳两页）

  window.__wrTurn = { sync, turn }
  sync()
  return 'page-turn ready'
})()
