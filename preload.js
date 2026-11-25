const { contextBridge, ipcRenderer } = require('electron')

// 暴露给页面主世界（调试用）；preload 自身用下面的本地包装
contextBridge.exposeInMainWorld('reader', {
  getStyle: () => ipcRenderer.invoke('wr-get-style'),
  setStyle: patch => ipcRenderer.invoke('wr-style', patch),
  getKeys: () => ipcRenderer.invoke('wr-get-keys'),
  setKey: p => ipcRenderer.invoke('wr-set-key', p),
  resetKeys: () => ipcRenderer.invoke('wr-reset-keys'),
  zoom: f => ipcRenderer.send('wr-zoom', f),
  minimize: () => ipcRenderer.send('wr-minimize'),
  close: () => ipcRenderer.send('wr-close'),
  pin: () => ipcRenderer.invoke('wr-pin'),
  reload: () => ipcRenderer.send('wr-reload')
})

// preload 隔离世界内部使用的 API（关键：不能用 window.reader）
const api = {
  getStyle: () => ipcRenderer.invoke('wr-get-style'),
  setStyle: patch => ipcRenderer.invoke('wr-style', patch),
  getKeys: () => ipcRenderer.invoke('wr-get-keys'),
  setKey: p => ipcRenderer.invoke('wr-set-key', p),
  resetKeys: () => ipcRenderer.invoke('wr-reset-keys'),
  captureBegin: () => ipcRenderer.invoke('wr-capture-begin'),
  captureEnd: () => ipcRenderer.invoke('wr-capture-end'),
  fire: a => ipcRenderer.send('wr-fire', a),
  zoom: f => ipcRenderer.send('wr-zoom', f),
  minimize: () => ipcRenderer.send('wr-minimize'),
  close: () => ipcRenderer.send('wr-close'),
  pin: () => ipcRenderer.invoke('wr-pin'),
  reload: () => ipcRenderer.send('wr-reload')
}

/* ============ 向微信读书页面注入悬浮控制面板 ============ */
;(function injectPanel() {
  let zoomFactor = 1
  let pinned = false       // Esc 切换：true=面板常驻，false=自动隐藏（默认）
  let hovering = false     // 鼠标正悬停在面板上
  let hideTimer = null

  function whenReady(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn, { once: true })
    } else fn()
  }

  // 用 CSSOM 设置样式（绕过站点可能的 CSP 内联样式限制）
  function css(el, props) {
    for (const k in props) el.style.setProperty(k, props[k], 'important')
  }

  /* ---- 键位工具：Electron Accelerator 字符串 <-> KeyboardEvent ---- */
  const KEY_LABELS = { transparent: '透明切换', noImage: '无图切换', boss: '老板键', bookmark: '添加/移除书签' }
  const DEFAULTS = {
    transparent: { key: 'F12', mode: 'app' },
    noImage:     { key: 'Alt+X', mode: 'app' },
    boss:        { key: 'Alt+Z', mode: 'global' },
    bookmark:    { key: 'Alt+B', mode: 'app' }
  }
  const ACTIONS = ['transparent', 'noImage', 'boss', 'bookmark']
  function modeLabel(m) { return m === 'global' ? '全局' : m === 'app' ? '应用内' : '关闭' }

  function parseAcc(acc) {
    const parts = String(acc || '').split('+')
    const key = parts.pop().toLowerCase()
    const mods = { ctrl: false, alt: false, shift: false, meta: false }
    for (const p of parts) {
      const q = p.toLowerCase()
      if (q === 'ctrl' || q === 'control' || q === 'commandorcontrol') mods.ctrl = true
      else if (q === 'alt' || q === 'option') mods.alt = true
      else if (q === 'shift') mods.shift = true
      else if (q === 'meta' || q === 'super' || q === 'cmd' || q === 'command') mods.meta = true
    }
    return { key, mods }
  }
  function domKey(e) {
    const map = {
      ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
      ' ': 'space', Spacebar: 'space', Esc: 'escape', Escape: 'escape', Del: 'delete', Delete: 'delete'
    }
    let k
    if (/^Key[A-Z]$/.test(e.code)) k = e.code.slice(3)
    else if (/^Digit[0-9]$/.test(e.code)) k = e.code.slice(5)
    else if (e.code === 'Space') k = 'space'
    else if (/^F([1-9]|1[0-2])$/.test(e.code)) k = e.code
    else k = map[e.key] || e.key || ''
    return String(k).toLowerCase()
  }
  function accelFromEvent(e) {
    const mods = []
    if (e.ctrlKey) mods.push('Ctrl')
    if (e.altKey) mods.push('Alt')
    if (e.shiftKey) mods.push('Shift')
    if (e.metaKey) mods.push('Meta')
    const k = domKey(e)
    if (!k) return ''
    const cap = /^f([1-9]|1[0-2])$/.test(k) ? k.toUpperCase()
      : k === 'space' ? 'Space'
      : k === 'escape' ? 'Escape'
      : k === 'up' ? 'Up' : k === 'down' ? 'Down'
      : k === 'left' ? 'Left' : k === 'right' ? 'Right'
      : k === 'tab' ? 'Tab'
      : k === 'pageup' ? 'PageUp' : k === 'pagedown' ? 'PageDown'
      : k === 'home' ? 'Home' : k === 'end' ? 'End'
      : k === 'insert' ? 'Insert' : k === 'delete' ? 'Delete'
      : k.length === 1 ? k.toUpperCase() : k
    return [...mods, cap].join('+')
  }
  function matchDom(acc, e) {
    const p = parseAcc(acc)
    if (e.ctrlKey !== p.mods.ctrl || e.altKey !== p.mods.alt ||
        e.shiftKey !== p.mods.shift || e.metaKey !== p.mods.meta) return false
    return domKey(e) === p.key
  }

  function flashBtn(btn, on) {
    btn.__on = on
    btn.style.setProperty('background', on ? 'rgba(80,140,255,.85)' : 'rgba(24,26,32,.9)', 'important')
    btn.style.setProperty('color', on ? '#fff' : '#cfd2d8', 'important')
  }

  whenReady(() => {
    // 快捷键配置（主进程持久化），由 wr-keys 广播 / getKeys 同步
    let keys = {
      transparent: { key: 'F12', mode: 'app' },
      noImage:     { key: 'Alt+X', mode: 'app' },
      boss:        { key: 'Alt+Z', mode: 'global' },
      bookmark:    { key: 'Alt+B', mode: 'app' }
    }
    let settingsOpen = false   // 设置弹层是否打开
    let captureAction = null   // 正在为哪个动作录制新键位

    /* ---- 顶部拖动条（无边框窗口拖动区，鼠标靠近顶部浮现） ---- */
    const drag = document.createElement('div')
    css(drag, {
      position: 'fixed', top: '0', left: '0', right: '0', height: '24px',
      'z-index': '2147483000', '-webkit-app-region': 'drag',
      opacity: '0', 'pointer-events': 'none',
      background: 'linear-gradient(to bottom, rgba(0,0,0,.30), transparent)',
      transition: 'opacity .15s'
    })
    document.body.appendChild(drag)

    /* ---- 悬浮控制面板（顶部居中 + 自动隐藏） ---- */
    const panel = document.createElement('div')
    panel.className = 'wr-ui-solid'   // 透明模式下不被抹背景（main.js 的 CSS 会跳过这个子树）
    css(panel, {
      position: 'fixed', top: '10px', left: '50%', 'transform': 'translateX(-50%)',
      'z-index': '2147483001',
      '-webkit-app-region': 'drag',
      display: 'flex', 'align-items': 'center', gap: '4px',
      padding: '6px 8px', 'border-radius': '10px',
      background: 'rgba(18,20,26,.88)', 'backdrop-filter': 'blur(10px)',
      'font-size': '12px', 'font-family': '"Microsoft YaHei",sans-serif',
      'user-select': 'none', 'box-shadow': '0 4px 18px rgba(0,0,0,.35)',
      opacity: '0', 'pointer-events': 'none', transition: 'opacity .18s',
      border: '1px solid rgba(128,128,128,0)'
    })

    function showPanel() {
      clearTimeout(hideTimer)
      panel.style.setProperty('opacity', '1', 'important')
      panel.style.setProperty('pointer-events', 'auto', 'important')
    }
    function hidePanel() {
      clearTimeout(hideTimer)
      hideTimer = setTimeout(() => {
        if (!pinned && !hovering) {
          panel.style.setProperty('opacity', '0', 'important')
          panel.style.setProperty('pointer-events', 'none', 'important')
        }
      }, 350)
    }
    function setPinned(on) {
      pinned = on
      // 常驻时描一圈高亮边框，提示当前是“锁定显示”状态
      panel.style.setProperty('border', on ? '1px solid rgba(80,140,255,.75)' : '1px solid rgba(128,128,128,0)', 'important')
      if (on) showPanel()
      else hidePanel()
    }

    panel.addEventListener('mouseenter', () => { hovering = true; showPanel() })
    panel.addEventListener('mouseleave', () => { hovering = false; hidePanel() })

    // 触发区：鼠标移动到窗口顶部中间区域，面板浮现
    document.addEventListener('mousemove', e => {
      const w = window.innerWidth
      const inTrigger = e.clientY < 34 && e.clientX > w * 0.3 && e.clientX < w * 0.7
      if (inTrigger || hovering || pinned) {
        showPanel()
      } else if (e.clientY > 60) {
        hidePanel()
      }
      // 顶部拖动条：鼠标靠近顶部即浮现（避开面板中央区域，避免挡按钮）
      const near = e.clientY < 24 && !(e.clientX > w * 0.3 && e.clientX < w * 0.7 && (pinned || hovering || inTrigger))
      drag.style.setProperty('opacity', near ? '1' : '0', 'important')
      drag.style.setProperty('pointer-events', near ? 'auto' : 'none', 'important')
    })

    function mkBtn(text, title) {
      const b = document.createElement('button')
      b.textContent = text
      b.title = title
      css(b, {
        '-webkit-app-region': 'no-drag',
        border: 'none', 'border-radius': '6px', padding: '5px 10px',
        background: 'rgba(24,26,32,.9)', color: '#cfd2d8',
        'font-size': '12px', 'font-family': 'inherit', cursor: 'pointer',
        'pointer-events': 'auto', outline: 'none'
      })
      b.addEventListener('mouseenter', () => {
        if (!b.__on) b.style.setProperty('background', 'rgba(70,110,190,.8)', 'important')
      })
      b.addEventListener('mouseleave', () => {
        if (!b.__on) b.style.setProperty('background', 'rgba(24,26,32,.9)', 'important')
      })
      panel.appendChild(b)
      return b
    }

    const bTrans = mkBtn('透明', '背景透明 / 恢复')
    const bMedia = mkBtn('无图', '隐藏书籍封面与插图，只留文字（再次点击恢复）')
    const bWhite = mkBtn('白字', '文字改为白色（仅透明模式可用）')
    const bBlack = mkBtn('黑字', '文字改为黑色（仅透明模式可用）')
    const bPin = mkBtn('置顶', '窗口置顶')
    const bSet = mkBtn('设置', '快捷键与键位模式设置')

    /* ---- 白字/黑字只在透明模式下有意义：非透明时置灰并给出提示 ---- */
    let isTransparent = false
    function syncFgButtons() {
      for (const b of [bWhite, bBlack]) {
        b.style.setProperty('opacity', isTransparent ? '1' : '.38', 'important')
        b.style.setProperty('cursor', isTransparent ? 'pointer' : 'default', 'important')
      }
      bWhite.title = isTransparent
        ? '文字改为白色（点击切换，再点恢复）'
        : '白字：仅透明模式下可用'
      bBlack.title = isTransparent
        ? '文字改为黑色（点击切换，再点恢复）'
        : '黑字：仅透明模式下可用'
    }
    function fgAllowed() {
      if (isTransparent) return true
      showToast('「白字 / 黑字」仅在透明模式下可用')
      return false
    }

    bTrans.addEventListener('click', async () => {
      const opts = await api.getStyle()
      const o = await api.setStyle({ transparent: !opts.transparent })
      flashBtn(bTrans, !!o.transparent)   // 提示由下面的状态广播统一处理
    })
    bMedia.addEventListener('click', async () => {
      const opts = await api.getStyle()
      const o = await api.setStyle({ hideMedia: !opts.hideMedia })
      flashBtn(bMedia, !!o.hideMedia)
    })
    bWhite.addEventListener('click', async () => {
      if (!fgAllowed()) return
      const opts = await api.getStyle()
      const o = await api.setStyle({ fg: opts.fg !== '#f2f2f2' ? '#f2f2f2' : null })
      flashBtn(bWhite, o.fg === '#f2f2f2')
    })
    bBlack.addEventListener('click', async () => {
      if (!fgAllowed()) return
      const opts = await api.getStyle()
      const o = await api.setStyle({ fg: opts.fg !== '#000000' ? '#000000' : null })
      flashBtn(bBlack, o.fg === '#000000')
    })
    bPin.addEventListener('click', async () => {
      const on = await api.pin()
      flashBtn(bPin, on)
    })

    const bZoomIn = mkBtn('A+', '放大页面')
    const bZoomOut = mkBtn('A-', '缩小页面')
    bZoomIn.addEventListener('click', () => { zoomFactor = Math.min(2, zoomFactor + .1); api.zoom(zoomFactor) })
    bZoomOut.addEventListener('click', () => { zoomFactor = Math.max(.5, zoomFactor - .1); api.zoom(zoomFactor) })

    const bMin = mkBtn('—', '最小化')
    const bClose = mkBtn('✕', '关闭')
    bMin.addEventListener('click', () => api.minimize())
    bClose.addEventListener('click', () => api.close())

    document.body.appendChild(panel)

    /* ---- 页面内兜底：应用内模式的键位（before-input-event 万一被吞掉时仍可用） ---- */
    document.addEventListener('keydown', e => {
      if (settingsOpen || captureAction) return
      for (const a of ACTIONS) {
        const cfg = keys[a]
        if (!cfg || cfg.mode !== 'app') continue
        if (matchDom(cfg.key, e)) {
          e.preventDefault()
          api.fire(a)
          return
        }
      }
    }, true)

    /* ---- Esc：录制中交给录制逻辑取消；设置打开时关设置；否则切换面板常驻 ---- */
    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return
      if (keyBusy && keyBusy.recording) return
      if (settingsOpen) { closeSettings(); return }
      setPinned(!pinned)
    })

    /* ================= 快捷键设置弹层 ================= */
    let settingsEl = null
    let prevPinned = pinned
    const keyBusy = { recording: false }

    function mk(tag, props, text) {
      const el = document.createElement(tag)
      if (text != null) el.textContent = text
      if (props) css(el, props)
      return el
    }

    function syncPanelTitles() {
      const fmt = a => (keys[a] && keys[a].mode === 'off') ? '已关闭' : keys[a].key
      bTrans.title = `背景透明 / 恢复（${fmt('transparent')}）`
      bMedia.title = `隐藏书籍封面与插图（${fmt('noImage')}）`
    }

    function buildSettings() {
      if (settingsEl) return
      const overlay = mk('div', {
        position: 'fixed', inset: '0', 'z-index': '2147483010',
        display: 'none', 'align-items': 'center', 'justify-content': 'center',
        background: 'rgba(0,0,0,.55)', '-webkit-app-region': 'no-drag',
        'font-family': '"Microsoft YaHei",sans-serif'
      })
      // 透明模式下也不参与“抹背景”，设置界面始终是黑底白字，方便选中
      overlay.className = 'wr-ui-solid'
      overlay.addEventListener('click', e => { if (e.target === overlay) closeSettings() })

      const card = mk('div', {
        width: '440px', 'max-width': '92vw', padding: '16px 18px 14px',
        'border-radius': '12px', background: '#0d0f14',
        color: '#eef1f6', 'font-size': '13px', 'user-select': 'none',
        'box-shadow': '0 18px 48px rgba(0,0,0,.65)',
        border: '1px solid rgba(255,255,255,.12)', '-webkit-app-region': 'no-drag'
      })
      card.className = 'wr-ui-card'
      overlay.appendChild(card)

      card.appendChild(mk('div', { 'font-size': '15px', 'font-weight': '600', 'margin-bottom': '4px' }, '快捷键设置'))
      card.appendChild(mk('div', {
        'font-size': '12px', color: '#9aa0aa', 'line-height': '1.6', 'margin-bottom': '10px'
      }, '点键位后按下新组合键（Esc 取消）。模式：全局＝任何程序前台都生效；应用内＝仅本窗口；关闭＝不响应。'))

      const list = mk('div', { display: 'flex', 'flex-direction': 'column', gap: '8px' })
      card.appendChild(list)
      const footer = mk('div', { display: 'flex', 'justify-content': 'flex-end', gap: '8px', 'margin-top': '14px' })
      card.appendChild(footer)

      const btnStyle = {
        padding: '5px 12px', 'border-radius': '6px', border: '1px solid #3a3e49',
        background: '#23262e', color: '#e6e8ec', 'font-size': '12px',
        cursor: 'pointer', outline: 'none', 'font-family': 'inherit'
      }
      const bReset = mk('button', btnStyle, '恢复默认')
      bReset.addEventListener('click', resetAll)
      const bDone = mk('button', { ...btnStyle, background: 'rgba(80,140,255,.85)', 'border-color': 'rgba(80,140,255,.9)' }, '完成')
      bDone.addEventListener('click', closeSettings)
      footer.append(bReset, bDone)

      overlay.__list = list
      document.body.appendChild(overlay)
      settingsEl = overlay
    }

    function renderSettings() {
      if (!settingsEl) return
      const list = settingsEl.__list
      list.textContent = ''
      const btnStyle = {
        padding: '5px 8px', 'border-radius': '6px', border: '1px solid #3a3e49',
        background: '#23262e', color: '#e6e8ec', 'font-size': '12px',
        cursor: 'pointer', outline: 'none', 'font-family': 'inherit'
      }

      for (const action of ACTIONS) {
        const cfg = keys[action]
        const row = mk('div', { display: 'flex', 'align-items': 'center', gap: '8px' })
        row.appendChild(mk('div', { width: '104px', 'flex-shrink': '0', color: '#cfd2d8' }, KEY_LABELS[action]))

        const sel = document.createElement('select')
        for (const [v, t] of [['global', '全局'], ['app', '应用内'], ['off', '关闭']]) {
          const o = document.createElement('option')
          o.value = v
          o.textContent = t
          sel.appendChild(o)
        }
        sel.value = cfg.mode
        css(sel, {
          width: '92px', background: '#2a2d36', color: '#e6e8ec',
          border: '1px solid #3a3e49', 'border-radius': '6px',
          padding: '5px 6px', 'font-size': '12px', outline: 'none', 'font-family': 'inherit'
        })
        sel.addEventListener('change', () => setMode(action, sel.value))
        row.appendChild(sel)

        const recording = keyBusy.recording && keyBusy.action === action
        const kb = mk('button', {
          ...btnStyle, flex: '1', 'min-width': '120px', 'text-align': 'center',
          background: recording ? 'rgba(80,140,255,.3)' : '#23262e',
          border: recording ? '1px solid rgba(80,140,255,.9)' : '1px solid #3a3e49',
          cursor: cfg.mode === 'off' ? 'default' : 'pointer',
          opacity: cfg.mode === 'off' ? '.5' : '1'
        }, recording ? '请按下组合键…' : (cfg.mode === 'off' ? '已关闭' : cfg.key))
        kb.disabled = cfg.mode === 'off'
        kb.addEventListener('click', () => startCapture(action))
        row.appendChild(kb)

        const rb = mk('button', { ...btnStyle, opacity: '.85' }, '默认')
        rb.addEventListener('click', () => resetOne(action))
        row.appendChild(rb)

        list.appendChild(row)
      }
    }

    async function setMode(action, mode) {
      const res = await api.setKey({ action, key: keys[action].key, mode })
      if (!res || !res.ok) {
        showToast('设置失败：' + ((res && res.error) || '未知错误'))
        renderSettings()
        return
      }
      keys = res.config
      showToast(`${KEY_LABELS[action]} 模式：${modeLabel(mode)}`)
      syncPanelTitles()
      renderSettings()
    }

    async function resetOne(action) {
      const d = DEFAULTS[action]
      const res = await api.setKey({ action, key: d.key, mode: d.mode })
      if (!res || !res.ok) {
        showToast('恢复失败：' + ((res && res.error) || '未知错误'))
        return
      }
      keys = res.config
      showToast(`${KEY_LABELS[action]} 已恢复默认（${d.key} · ${modeLabel(d.mode)}）`)
      syncPanelTitles()
      renderSettings()
    }

    async function resetAll() {
      const res = await api.resetKeys()
      if (res && res.ok) {
        keys = res.config
        showToast('四个快捷键均已恢复默认')
        syncPanelTitles()
        renderSettings()
      }
    }

    async function startCapture(action) {
      if (keyBusy.recording) return
      if (keys[action].mode === 'off') { showToast('当前模式是「关闭」，请先选模式'); return }
      keyBusy.recording = true
      keyBusy.action = action
      await api.captureBegin()
      renderSettings()
      showToast(`请按下「${KEY_LABELS[action]}」的新快捷键，Esc 取消`)
      document.addEventListener('keydown', onCaptureKey, true)
    }

    function stopCapture() {
      keyBusy.recording = false
      keyBusy.action = null
      document.removeEventListener('keydown', onCaptureKey, true)
    }

    async function onCaptureKey(e) {
      if (!keyBusy.recording) return
      e.preventDefault()
      e.stopImmediatePropagation()
      if (e.key === 'Escape') {
        const action = keyBusy.action
        stopCapture()
        await api.captureEnd()
        renderSettings()
        showToast(`已取消修改「${KEY_LABELS[action]}」`)
        return
      }
      // 只按修饰键时继续等待
      if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return
      const acc = accelFromEvent(e)
      if (!acc) return
      const action = keyBusy.action
      const mode = keys[action].mode === 'off' ? 'app' : keys[action].mode
      stopCapture()
      const res = await api.setKey({ action, key: acc, mode })
      if (!res || !res.ok) {
        await api.captureEnd()
        showToast('设置失败：' + ((res && res.error) || '未知错误'))
        renderSettings()
        return
      }
      keys = res.config
      showToast(res.notice || `${KEY_LABELS[action]} 已设为 ${acc}`)
      syncPanelTitles()
      renderSettings()
    }

    function openSettings() {
      if (settingsOpen) return
      settingsOpen = true
      prevPinned = pinned
      setPinned(true)
      buildSettings()
      renderSettings()
      settingsEl.style.setProperty('display', 'flex', 'important')
    }

    function closeSettings() {
      if (!settingsOpen) return
      if (keyBusy.recording) {
        stopCapture()
        api.captureEnd()
      }
      settingsOpen = false
      if (settingsEl) settingsEl.style.setProperty('display', 'none', 'important')
      setPinned(prevPinned)
    }

    bSet.addEventListener('click', () => openSettings())

    /* 沉浸模式的左右翻页点击区 / 滚轮 / 方向键由注入脚本 page-turn.js 负责
       （必须在页面主世界派发指针事件，隔离世界派发的会被站点忽略） */

    /* ---- 开启沉浸模式时给一句提示（3 秒后自动消失） ---- */
    let toast = null
    // kind === 'success' 用于书签快捷键的成功提示：绿色对勾 + 绿色描边
    function showToast(text, kind) {
      if (!toast) {
        toast = document.createElement('div')
        toast.className = 'wr-ui-solid'
        css(toast, {
          position: 'fixed', bottom: '18px', left: '50%', transform: 'translateX(-50%)',
          'z-index': '2147483002', 'pointer-events': 'none',
          padding: '8px 14px', 'border-radius': '10px',
          background: 'rgba(18,20,26,.88)', color: '#e6e8ec',
          'font-size': '12px', 'font-family': '"Microsoft YaHei",sans-serif',
          'box-shadow': '0 4px 16px rgba(0,0,0,.35)', opacity: '0',
          visibility: 'hidden', transition: 'opacity .2s'
        })
        document.body.appendChild(toast)
      }
      if (!document.body.contains(toast)) document.body.appendChild(toast)
      const success = kind === 'success'
      toast.textContent = success ? '✓  ' + text : text
      toast.style.setProperty('color', success ? '#eafbf3' : '#e6e8ec', 'important')
      toast.style.setProperty('border-left', success ? '3px solid #3ecf8e' : 'none', 'important')
      toast.style.setProperty('visibility', 'visible', 'important')
      toast.style.setProperty('opacity', '1', 'important')
      clearTimeout(toast.__t)
      clearTimeout(toast.__hideT)
      toast.__t = setTimeout(() => {
        toast.style.setProperty('opacity', '0', 'important')
        // 透明窗口里只压 opacity 会残留一帧旧合成画面：淡出结束再彻底隐藏。
        // 若这期间又弹了新提示（opacity 被设回 1），则不隐藏。
        toast.__hideT = setTimeout(() => {
          if (toast.style.getPropertyValue('opacity') === '0') {
            toast.style.setProperty('visibility', 'hidden', 'important')
          }
        }, 220)
      }, 3000)
    }
    window.__wrToast = showToast

    /* ---- 主进程状态广播：同步按钮高亮 + 透明切换提示（快捷键也走这里） ---- */
    let lastTrans = null
    ipcRenderer.on('wr-state', (_e, o) => {
      if (!o) return
      flashBtn(bTrans, !!o.transparent)
      flashBtn(bMedia, !!o.hideMedia)
      flashBtn(bWhite, o.fg === '#f2f2f2')
      flashBtn(bBlack, o.fg === '#000000')
      // 白字/黑字仅透明模式可用：退出透明时按钮置灰、高亮清除
      isTransparent = !!o.transparent
      if (!isTransparent) { bWhite.__on = false; bBlack.__on = false }
      syncFgButtons()
      if (lastTrans !== null && lastTrans !== !!o.transparent) {
        showToast(o.transparent
          ? `沉浸模式：已隐藏全部界面，点击左右边缘 / 滚轮 / ←→ 翻页（${keys.transparent.key} 切换）`
          : '已恢复微信读书原界面')
      }
      lastTrans = !!o.transparent
    })

    /* ---- 快捷键配置广播：键位/模式改动后同步面板提示与设置界面 ---- */
    ipcRenderer.on('wr-keys', (_e, data) => {
      if (!data || !data.config) return
      keys = data.config
      syncPanelTitles()
      if (settingsOpen) renderSettings()
      if (data.message) showToast(data.message)
    })
    ipcRenderer.on('wr-open-settings', () => openSettings())
    // 主进程主动提示（例如书签快捷键在书架页找不到按钮时）
    ipcRenderer.on('wr-notice', (_e, text) => { if (text) showToast(text) })
    // 书签快捷键专用成功提示：只有快捷键触发才会走这条通道，
    // 手动点右上角书签按钮不经过主进程，因此不会出现提示
    ipcRenderer.on('wr-bookmark-toast', (_e, text) => { if (text) showToast(text, 'success') })

    /* ---- 初始化键位提示 ---- */
    api.getKeys().then(k => {
      if (k) keys = k
      syncPanelTitles()
      if (settingsOpen) renderSettings()
    })

    /* ---- SPA 场景：body 若被站点整体替换，面板会丢失，用 MutationObserver 兜底重挂 ---- */
    const mo = new MutationObserver(() => {
      if (!document.body.contains(panel)) document.body.appendChild(panel)
      if (!document.body.contains(drag)) document.body.appendChild(drag)
    })
    mo.observe(document.documentElement, { childList: true, subtree: false })

    /* ---- 根据已保存的样式状态点亮按钮 ---- */
    api.getStyle().then(opts => {
      flashBtn(bTrans, !!opts.transparent)
      flashBtn(bMedia, !!opts.hideMedia)
      flashBtn(bWhite, opts.fg === '#f2f2f2')
      flashBtn(bBlack, opts.fg === '#000000')
      lastTrans = !!opts.transparent
      isTransparent = !!opts.transparent
      syncFgButtons()
    })
  })
})()
