// 注入到页面主世界：把 canvas 上绘制的“灰色文字”改为当前主题的目标色
// 目标色由 theme-sync.js 写在 <html> 的 --wr-auto-fg 上：
//   亮色 / 透明 → #000000，暗色 → #f2f2f2，白字/黑字按钮 → 按钮指定色
// 只拦截 fillText / strokeText 调用期间的颜色，不动背景填充，避免误伤
;(() => {
  if (window.__wrTextPatch) return 'already patched'
  window.__wrTextPatch = true

  const proto = CanvasRenderingContext2D.prototype

  let cachedColor = '#000000'
  let cachedAt = 0
  function targetColor() {
    const now = Date.now()
    if (now - cachedAt < 150) return cachedColor
    cachedAt = now
    try {
      const d = document.documentElement
      const v = getComputedStyle(d).getPropertyValue('--wr-auto-fg')
      cachedColor = (v && v.trim()) || (d.hasAttribute('__wr_dark') ? '#f2f2f2' : '#000000')
    } catch (_) { /* 页面还没准备好时沿用上次值 */ }
    return cachedColor
  }

  // 判断某个颜色是否是“中性灰”
  function isNeutralGray(v) {
    if (typeof v !== 'string') return false
    let m = v.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i)
    if (m) {
      const r = +m[1], g = +m[2], b = +m[3]
      const a = m[4] === undefined ? 1 : +m[4]
      if (a < 0.6) return false                      // 半透明（高亮、底纹）不动
      return r === g && g === b && r >= 30 && r <= 220
    }
    m = v.match(/^#([0-9a-f]{6})$/i)
    if (m) {
      const r = parseInt(m[1].slice(0, 2), 16)
      const g = parseInt(m[1].slice(2, 4), 16)
      const b = parseInt(m[1].slice(4, 6), 16)
      return r === g && g === b && r >= 30 && r <= 220
    }
    return false
  }

  const wrap = (name) => {
    const orig = proto[name]
    if (typeof orig !== 'function') return
    proto[name] = function (...args) {
      const prevFill = this.fillStyle
      const prevStroke = this.strokeStyle
      const color = targetColor()
      try {
        if (isNeutralGray(prevFill)) this.fillStyle = color
        if (isNeutralGray(prevStroke)) this.strokeStyle = color
      } catch (_) { /* 某些上下文只读，忽略 */ }
      try {
        return orig.apply(this, args)
      } finally {
        try {
          this.fillStyle = prevFill
          this.strokeStyle = prevStroke
        } catch (_) {}
      }
    }
  }
  wrap('fillText')
  wrap('strokeText')

  return 'patched'
})()
