/* 主题 → 正文自动色同步（注入页面主世界）
 * 维护 <html> 上的 --wr-auto-fg 与 __wr_dark：
 *   透明模式 / 亮色主题 → #000000（纯黑）
 *   暗色主题           → #f2f2f2（近白）
 *   「白字 / 黑字」按钮 → 按钮指定的颜色（优先级最高）
 * canvas 文字补丁（black-text-patch.js）与注入 CSS 都读 --wr-auto-fg。
 */
;(() => {
  if (window.__wrTheme) {
    window.__wrTheme.sync()
    return 'theme-sync already ready'
  }

  const d = document.documentElement
  let syncing = false
  let lastColor = null

  function parseBg(el) {
    try {
      const bg = getComputedStyle(el).backgroundColor || ''
      const m = bg.match(/[\d.]+/g)
      if (!m || m.length < 3) return null
      const a = m.length > 3 ? +m[3] : 1
      if (a < 0.2) return null
      return [+m[0], +m[1], +m[2]]
    } catch (_) { return null }
  }

  // 从阅读区往上找第一个真正有颜色的背景（站点常把背景设在父容器上）
  function effectiveBg() {
    let el = document.querySelector('.readerChapterContent') ||
      document.querySelector('.renderTargetContainer') ||
      document.body
    let hops = 0
    while (el && hops++ < 12) {
      const c = parseBg(el)
      if (c) return c
      el = el.parentElement
    }
    return null
  }

  function isDarkTheme() {
    const cls = (d.className || '') + ' ' + (document.body ? document.body.className || '' : '')
    const b = document.body
    if ((b && b.getAttribute('data-theme') === 'dark') || d.getAttribute('data-theme') === 'dark') return true
    if (/wr_(dark|black|night)[A-Za-z_]*Theme/i.test(cls)) return true

    // 背景亮度是最可靠的信号：站点切暗色时阅读区背景一定会变深，
    // 不依赖主题 class 的具体命名（站点改版也不会失效）
    const bg = effectiveBg()
    if (!bg) return /wr_(dark|black|night)/i.test(cls)
    const lum = (0.2126 * bg[0] + 0.7152 * bg[1] + 0.0722 * bg[2]) / 255
    if (lum < 0.45) return true
    if (lum > 0.6) return false
    return /wr_(dark|black|night)/i.test(cls)
  }

  // 透明模式会把所有背景抹成透明，此时「看背景亮度判断主题」必然失效，
  // 所以在正常模式下采样并缓存，进入透明模式后继续沿用上一次的主题判断。
  let lastDark = null
  function themeIsDark() {
    const transparent = d.hasAttribute('__wr_t')
    if (transparent) {
      if (lastDark !== null) return lastDark
      const cls = (d.className || '') + ' ' + (document.body ? document.body.className || '' : '')
      return /wr_(dark|black|night)/i.test(cls)
    }
    lastDark = isDarkTheme()
    return lastDark
  }

  function sync() {
    if (syncing || !document.body) return null
    syncing = true
    try {
      const transparent = d.hasAttribute('__wr_t')
      const override = d.hasAttribute('__wr_fg')
        ? (getComputedStyle(d).getPropertyValue('--wr-fg') || '').trim()
        : ''
      const themeDark = themeIsDark()
      // 透明模式一律按亮色（黑字），符合用户要求
      const dark = !transparent && themeDark
      if (dark) d.setAttribute('__wr_dark', '1')
      else d.removeAttribute('__wr_dark')

      const color = override || (dark ? '#f2f2f2' : '#000000')
      if (d.style.getPropertyValue('--wr-auto-fg') !== color) {
        d.style.setProperty('--wr-auto-fg', color)
      }
      // 浮层（热门想法/划线笔记）字色：跟站点主题走，不看透明状态。
      // 透明模式会把正文强制成黑色，若不单独给浮层一个值，暗色面板里会出现黑字黑底。
      const panelFg = themeDark ? '#eef0f4' : '#26282c'
      if (d.style.getPropertyValue('--wr-panel-fg') !== panelFg) {
        d.style.setProperty('--wr-panel-fg', panelFg)
      }
      // 正文是 canvas 绘制的，颜色变了必须让站点重绘一次，否则旧颜色留在画布上
      if (color !== lastColor) {
        lastColor = color
        try { window.dispatchEvent(new Event('resize')) } catch (_) {}
      }
      return color
    } finally {
      syncing = false
    }
  }

  // 站点切主题 / 开关透明或文字色时会改这些属性；另加低频轮询兜底
  new MutationObserver(sync).observe(d, {
    attributes: true, attributeFilter: ['class', '__wr_t', '__wr_fg']
  })
  new MutationObserver(sync).observe(document.body, {
    attributes: true, attributeFilter: ['class', 'style']
  })
  setInterval(sync, 500)

  window.__wrTheme = { sync }
  sync()
  return 'theme-sync ready'
})()
