const { app, BrowserWindow, ipcMain, shell, session, Menu, globalShortcut, Tray } = require('electron')
const path = require('path')
const fs = require('fs')

/* ---------- 数据目录与任务栏标识（便携版关键） ---------- */
// 默认数据目录固定为 %APPDATA%\weread-transparent，保证升级/换壳后登录态不丢。
// 便携模式：exe 同目录放一个空的 portable.txt，数据就存到 exe 旁边的 data\，
// 整个文件夹拷到 U 盘也能带着登录态走。
function resolveUserData() {
  try {
    const exeDir = path.dirname(app.getPath('exe'))
    if (fs.existsSync(path.join(exeDir, 'portable.txt'))) {
      const dir = path.join(exeDir, 'data')
      fs.mkdirSync(dir, { recursive: true })
      return dir
    }
  } catch (_) {}
  return path.join(app.getPath('appData'), 'weread-transparent')
}
try { app.setPath('userData', resolveUserData()) } catch (_) {}
app.setAppUserModelId('com.mao.wereadtransparent')   // 任务栏图标归组，便携版不会被当成陌生程序

// 正文文字是画在 canvas 上的，CSS 无法改色，用运行时补丁按主题画成黑/白
let TEXT_PATCH = ''
try { TEXT_PATCH = fs.readFileSync(path.join(__dirname, 'black-text-patch.js'), 'utf8') } catch (_) {}

// 主题同步：维护 <html> 上的 --wr-auto-fg（亮/透明=黑，暗=白）
let THEME_SYNC = ''
try { THEME_SYNC = fs.readFileSync(path.join(__dirname, 'theme-sync.js'), 'utf8') } catch (_) {}

// 沉浸模式翻页补丁：左右点击区 / 滚轮 / 方向键翻页（必须注入页面主世界）
let PAGE_TURN = ''
try { PAGE_TURN = fs.readFileSync(path.join(__dirname, 'page-turn.js'), 'utf8') } catch (_) {}

// 透明模式右上角书签角标的 hover 显隐控制（主世界，幂等）
let BM_HOVER = ''
try { BM_HOVER = fs.readFileSync(path.join(__dirname, 'bookmark-hover.js'), 'utf8') } catch (_) {}

let win = null
let cssKey = null
let tray = null

// 阅读样式状态（由悬浮面板控制）
let styleOpts = {
  transparent: false,   // 背景透明（露出桌面）
  hideMedia: false,     // 无图：隐藏书籍封面/插图，只留文字
  fg: null              // 文字颜色覆盖（null=使用网站原色）
}

/* 开发调试用：启动时强制某个模式，不必依赖 UI 点击。
   WR_FORCE_TRANSPARENT=1 / WR_FORCE_NOIMAGE=1 只在设置了环境变量时生效，
   正常双击启动完全无影响。 */
if (process.env.WR_FORCE_TRANSPARENT === '1') styleOpts.transparent = true
if (process.env.WR_FORCE_NOIMAGE === '1') styleOpts.hideMedia = true

/* ---------- 快捷键设置：键位 + 模式（可自定义、持久化） ---------- */
const KEY_LABELS = { transparent: '透明切换', noImage: '无图切换', boss: '老板键', bookmark: '添加/移除书签' }
const DEFAULT_KEYS = {
  transparent: { key: 'F12',   mode: 'app' },
  noImage:     { key: 'Alt+X', mode: 'app' },
  boss:        { key: 'Alt+Z', mode: 'global' },
  bookmark:    { key: 'Alt+B', mode: 'app' }
}
let keyConfig = loadKeys()
let capturing = false          // 正在录制新键位：暂停一切快捷键触发
const lastFire = {}            // 每个动作的去抖（主进程拦截 + 页面兜底会双触发）

function keyFile() { return path.join(app.getPath('userData'), 'hotkeys.json') }
function loadKeys() {
  const out = {}
  let saved = null
  try { saved = JSON.parse(fs.readFileSync(keyFile(), 'utf8')) } catch (_) {}
  for (const a of Object.keys(DEFAULT_KEYS)) {
    const c = (saved && saved[a]) || {}
    out[a] = {
      key: typeof c.key === 'string' && c.key ? c.key : DEFAULT_KEYS[a].key,
      mode: ['global', 'app', 'off'].includes(c.mode) ? c.mode : DEFAULT_KEYS[a].mode
    }
  }
  return out
}
function saveKeys() {
  try { fs.writeFileSync(keyFile(), JSON.stringify(keyConfig, null, 2), 'utf8') } catch (_) {}
}
function normalizeKey(k) {
  if (k == null) return ''
  let s = String(k).toLowerCase()
  const map = {
    ' ': 'space', spacebar: 'space', esc: 'escape',
    arrowup: 'up', arrowdown: 'down', arrowleft: 'left', arrowright: 'right',
    del: 'delete'
  }
  if (s === ' ') s = 'space'
  return map[s] || s
}
function parseAccel(acc) {
  const parts = String(acc || '').split('+')
  const key = normalizeKey(parts.pop())
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
function matchInput(acc, input) {
  const p = parseAccel(acc)
  const m = input.modifiers || []
  const has = x => m.includes(x)
  const alt = has('alt') || has('option')
  const ctrl = has('control') || has('ctrl') || has('command')
  const shift = has('shift')
  const meta = has('meta') || has('super') || has('command')
  if (alt !== p.mods.alt || ctrl !== p.mods.ctrl || shift !== p.mods.shift || meta !== p.mods.meta) return false
  return normalizeKey(input.key) === p.key
}
function validateKey(acc) {
  const p = parseAccel(acc)
  if (!p.key) return '键位为空'
  if (/^(alt\+f4|ctrl\+alt\+delete)$/i.test(acc)) return '该组合被系统占用'
  const bare = !p.mods.ctrl && !p.mods.alt && !p.mods.shift && !p.mods.meta
  const special = /^(f[1-9]|f1[0-2]|escape|tab|space|up|down|left|right|pageup|pagedown|home|end|insert|delete)$/.test(p.key)
  if (bare && !special) return '请带上 Ctrl / Alt / Shift，或改用 F1~F12 等功能键'
  return null
}
function modeLabel(m) { return m === 'global' ? '全局' : m === 'app' ? '应用内' : '关闭' }

// 伪装成普通 Chrome，避免被站点风控特殊对待
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

// 门控式样式表：规则挂在 <html> 属性上（__wr_t / __wr_m / __wr_fg），
// 开关 = 设置/移除属性，秒级生效且绝无残留（不再依赖 removeInsertedCSS）
/* 透明模式要放行的浮层：应用自己的 UI + 书籍内「热门想法/划线笔记」浮层。
   这些浮层必须保留自己的不透明底色，否则字直接浮在桌面上，没法读。
   写成变量是为了下面「抹背景」和「改字色」两条规则共用同一份排除列表。 */
const KEEP_UI = `:not(.wr-ui-solid):not(.wr-ui-solid *):not([class*="float_panel"]):not([class*="float_panel"] *):not([class*="reviews_panel"]):not([class*="reviews_panel"] *)`

const CSS_RULES = `
html[__wr_t], html[__wr_t] body { background: transparent !important; }
/* 抹掉站点背景（保留：应用 UI、热门想法浮层） */
html[__wr_t] body *${KEEP_UI} {
  background-color: transparent !important;
  background-image: none !important;
  box-shadow: none !important;
  text-shadow: none !important;
}
/* 透明（沉浸）模式：正文以外的界面元素全部隐形——顶部书名栏、右侧工具栏、
   底部翻页按钮与进度、书签角标、目录浮层，只留正文文字浮在桌面上 */
html[__wr_t] .readerTopBar,
html[__wr_t] .readerControls,
html[__wr_t] .renderTarget_pager,
html[__wr_t] .readerFooter,
html[__wr_t] .renderTargetPageInfo_header,
html[__wr_t] [class*="renderTargetPageInfo_header"],
html[__wr_t] .readerCatalog,
html[__wr_t] [class*="readerProgress"],
html[__wr_t] [class*="float_corner"]:not([class*="bookmark"]) {
  opacity: 0 !important;
  pointer-events: none !important;
  transition: opacity .18s !important;
}
/* 透明模式唯一保留的站点功能：右上角「添加书签」角标。
   ★ 显隐由 __wr_bm 属性门控（bookmark-hover.js 按鼠标位置设置），不用 CSS :hover，
     也绝不带 transition：站点点击加/移除书签后会重建节点，只要有淡出过渡就会「先闪一下」。
   ★ 隐藏必须连 wrapper 自身一起藏，而且要 opacity + visibility 双保险：
     只压后代时 wrapper 自己的 ::before/::after 与站点给的背景仍会绘制；
     只压 opacity 时透明窗口的合成层还可能残留一帧旧画面 →「鼠标移开后上方再闪一下」。
   ★ 伪元素要单独点名：通配选择器（星号）匹配不到 ::before / ::after。 */
html[__wr_t] [class*="float_corner_bookmark_wrapper"],
html[__wr_t] [class*="float_corner_bookmark_wrapper"] *,
html[__wr_t] [class*="float_corner_bookmark_wrapper"] *::before,
html[__wr_t] [class*="float_corner_bookmark_wrapper"] *::after {
  opacity: 0 !important;
  visibility: hidden !important;
  transition: none !important;
  animation: none !important;
}
html[__wr_t][__wr_bm] [class*="float_corner_bookmark_wrapper"],
html[__wr_t][__wr_bm] [class*="float_corner_bookmark_wrapper"] *,
html[__wr_t][__wr_bm] [class*="float_corner_bookmark_wrapper"] *::before,
html[__wr_t][__wr_bm] [class*="float_corner_bookmark_wrapper"] *::after {
  opacity: 1 !important;
  visibility: visible !important;
  transition: none !important;
  animation: none !important;
}
/* ★ 书签图标固定站点品牌蓝（#1b88ee）。
   站点的蓝色只挂在「指针精确落在 15px 宽的 svg 上」这一条规则（svg:hover #iconFill），
   鼠标停在旁边的「点击添加书签」文字上时图标仍是灰色 #d4d6d8，看着像一枚半透明残影
   ——就是用户标为「错误图标」的那一态。这里把填充色锁死，两种落点看到的都是「正确图标」。 */
html[__wr_t][__wr_bm] [class*="bookmark_actionArea_lang"] {
  opacity: 1 !important;
  visibility: visible !important;
}
html[__wr_t][__wr_bm] [class*="bookmark_actionArea_icon"] #iconFill,
html[__wr_t][__wr_bm] [class*="bookmark_actionArea_icon"] #iconStroke,
html[__wr_t][__wr_bm] [class*="bookmark_actionArea_icon"] path {
  opacity: 1 !important;
  fill: #1b88ee !important;
  transition: none !important;
}
/* ★ 位移钉死。
   站点给 actionArea 写了 transform: translateY(-100%)（70px），也就是默认只有一小截
   书签「舌头」探在页面顶边外面，靠 hover 才落回页内和「点击添加书签」文字对齐。
   只要我们让它可见、而指针正好落在热区里却压不到 wrapper/actionArea（热区比按钮大一圈，
   上下各留了余量），站点就收不到 hover，于是文字在页内、图标却还挂在顶边——
   用户看到的就是「两个书签按钮」：一枚探出页面顶边，一枚在文字旁。
   透明模式下直接把位移钉成 0，永远停在页内的正确位置，显隐只由 __wr_bm 决定。 */
html[__wr_t] [class*="float_corner_bookmark_wrapper"] [class*="float_corner_bookmark_actionArea"]:not([class*="actionArea_"]) {
  transform: translateY(0) !important;
  transition: none !important;
}
html[__wr_t] [class*="float_corner_bookmark_actionArea"]:not([class*="actionArea_"]) {
  pointer-events: auto !important;
  cursor: pointer !important;
}
/* 无图模式（__wr_m）：只隐藏「书籍封面」和「书籍正文插图」，不动任何功能按钮/图标/头像。
   ① 站点按钮图标大多是 svg，功能按钮（AI问书、上下滚动阅读、加入书架、想法里的
      头像/红心/评论）绝不能按 svg / img / avatar 全量隐藏；
   ② 正文文字画在 canvas 上，canvas 更不能隐藏；
   ③ 封面 = .wr_bookCover（容器里只有封面图 + 纯装饰 span，不含任何按钮）；
      正文插图 = img[class*="wr_readerImage"]（实测）。 */
html[__wr_m] [class*="wr_bookCover"],
html[__wr_m] img[class*="wr_readerImage"],
html[__wr_m] picture[class*="wr_readerImage"],
html[__wr_m] [class*="wr_readerImage"] img { display: none !important; }
/* 正文自动色：--wr-auto-fg 由 theme-sync.js 维护
   亮色 / 透明模式 = 纯黑，暗色主题 = 白色，白字/黑字按钮 = 覆盖色 */
html body .readerChapterContent, html body .readerChapterContent *,
html body [class*="readerChapterContent"], html body [class*="readerChapterContent"] *,
html body .renderTargetContent, html body .renderTargetContent *,
html body [class*="readerContent"], html body [class*="readerContent"] * {
  color: var(--wr-auto-fg, #000000) !important;
}
/* 文字色覆盖：双属性选择器抬高优先级，确保能压过上面的正文自动色
   同样跳过「应用 UI」和「热门想法浮层」——它们的配色是固定的，不能被改 */
html[__wr_fg][__wr_fg] body *${KEEP_UI} {
  color: var(--wr-fg, #f2f2f2) !important;
}
/* 设置弹层等应用自有 UI：无论透明/亮色/暗色，始终深底浅字 */
html body .wr-ui-solid .wr-ui-card {
  background-color: #0d0f14 !important;
  color: #eef1f6 !important;
}
/* 热门想法 / 划线笔记浮层：它在 .readerChapterContent 里面，会继承正文的强制色。
   透明模式正文是纯黑，暗色面板配黑字就看不见了 —— 这里按站点主题给浮层一个
   基础字色（--wr-panel-fg 由 theme-sync 维护），子元素自身有配色的照旧生效。 */
html[__wr_t] body [class*="float_panel"],
html[__wr_t] body [class*="reviews_panel"] {
  color: var(--wr-panel-fg, #eef0f4) !important;
}
`

function syncAttrsJS(o) {
  return `(() => {
    const d = document.documentElement;
    ${o.transparent ? "d.setAttribute('__wr_t','1')" : "d.removeAttribute('__wr_t')"};
    ${o.hideMedia ? "d.setAttribute('__wr_m','1')" : "d.removeAttribute('__wr_m')"};
    ${o.fg
      ? `d.setAttribute('__wr_fg','1'); d.style.setProperty('--wr-fg', ${JSON.stringify(o.fg)})`
      : `d.removeAttribute('__wr_fg'); d.style.removeProperty('--wr-fg')`};
    // 主题/文字色同步交给页面主世界的 theme-sync（含暗色识别）
    try { window.__wrTheme && window.__wrTheme.sync() } catch (_) {}
  })()`
}

// 串行化执行；cssKey 为 null 表示当前页面尚未注入样式表（跳转/刷新后需重注）
let styleChain = Promise.resolve()
function applyStyle() {
  const p = styleChain.then(async () => {
    if (!win || win.isDestroyed()) return styleOpts
    if (cssKey === null) {
      try {
        cssKey = await win.webContents.insertCSS(CSS_RULES, { cssOrigin: 'user' })
      } catch (e) {
        // 某些环境下 insertCSS 会因参数转换失败（Electron 内部 gin 层报 conversion failure），
        // 退化成往页面里插一个 <style>：效果等价，页面导航后随文档一起销毁、下次重建
        console.error('[wr] insertCSS failed:', e && e.message, '| css:', typeof CSS_RULES, CSS_RULES && CSS_RULES.length)
        cssKey = await win.webContents.executeJavaScript(
          `(() => {
            let s = document.getElementById('wr-style');
            if (!s) { s = document.createElement('style'); s.id = 'wr-style'; (document.head || document.documentElement).appendChild(s) }
            s.textContent = ${JSON.stringify(CSS_RULES)};
            return 'inline-style'
          })()`, true)
      }
    }
    await win.webContents.executeJavaScript(syncAttrsJS(styleOpts), true)
    // 广播状态：preload 用它同步面板按钮高亮与提示
    try { win.webContents.send('wr-state', styleOpts) } catch (_) {}
    // 每次页面加载后重挂主题同步（幂等），顺序在文字补丁之前
    if (THEME_SYNC) {
      try { await win.webContents.executeJavaScript(THEME_SYNC, true) } catch (_) {}
    }
    // 每次页面加载后重新挂上 canvas 文字补黑/补白补丁（内部有幂等保护）
    if (TEXT_PATCH) {
      try { await win.webContents.executeJavaScript(TEXT_PATCH, true) } catch (_) {}
    }
    // 沉浸模式的翻页点击区（同样每次加载后重挂）
    if (PAGE_TURN) {
      try { await win.webContents.executeJavaScript(PAGE_TURN, true) } catch (_) {}
    }
    // 透明模式书签角标的 hover 显隐控制（内部幂等，页面导航后会自动重挂）
    if (BM_HOVER) {
      try { await win.webContents.executeJavaScript(BM_HOVER, true) } catch (_) {}
    }
    return styleOpts
  })
  styleChain = p.catch(e => { console.error('[wr] applyStyle failed:', e && e.message) })
  return p
}

function createWindow() {
  // 使用默认 Session（持久化在 userData），微信扫码登录后 Cookie 一直保留
  session.defaultSession.setUserAgent(UA)

  win = new BrowserWindow({
    width: 1000,
    height: 720,
    minWidth: 400,
    minHeight: 300,
    transparent: true,
    frame: false,
    backgroundColor: '#00000000',
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      devTools: false   // 释放 F12，避免被 Chromium 的开发者工具快捷键吞掉
    }
  })

  Menu.setApplicationMenu(null)
  win.loadURL('https://weread.qq.com/')

  // 主页面加载失败（网络抖动）自动重试
  win.webContents.on('did-fail-load', (_e, code, desc, url, isMain) => {
    if (isMain && win && !win.isDestroyed()) {
      setTimeout(() => { try { win.loadURL('https://weread.qq.com/') } catch (_) {} }, 3000)
    }
  })

  win.once('ready-to-show', () => win.show())

  // 应用内模式的键位：在输入进入渲染进程之前拦截（全局模式由 globalShortcut 处理）
  win.webContents.on('before-input-event', (event, input) => {
    if (capturing || input.type !== 'keyDown') return
    for (const [action, cfg] of Object.entries(keyConfig)) {
      if (cfg.mode !== 'app') continue
      if (matchInput(cfg.key, input)) {
        event.preventDefault()
        fireAction(action)
        return
      }
    }
  })

  // 站内弹出新窗口一律拒绝，改用系统浏览器打开
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  win.on('closed', () => { win = null })

  // 整页加载/刷新：样式表随页面销毁，重置 key 后重新注入并同步属性
  // （首次启动的 dom-ready 也会走到这里，保证样式表从第一页就位）
  const reloadStyle = () => {
    if (!win || win.isDestroyed()) return
    cssKey = null
    applyStyle()
  }
  // SPA 页内路由切换：页面未销毁、样式表仍在，仅需同步属性开关
  const resyncAttrs = () => {
    if (!win || win.isDestroyed()) return
    applyStyle()
  }
  win.webContents.on('did-navigate', reloadStyle)
  win.webContents.on('dom-ready', reloadStyle)
  // dom-ready 阶段页面还在 loading，insertCSS 有时会失败（样式表随页面销毁后重注失败），
  // 这里在 did-finish-load 再补一次，确保样式表一定就位
  win.webContents.on('did-finish-load', reloadStyle)
  win.webContents.on('did-navigate-in-page', resyncAttrs)
}

/* ---------- 快捷键：三个动作，键位 / 模式可在设置里改 ---------- */

function toggleWindow() {
  if (!win) return
  if (win.isVisible() && win.isFocused()) {
    win.hide()           // 一键消失（老板键）
  } else {
    win.show()
    win.focus()
  }
}
function toggleTransparent() {
  styleOpts.transparent = !styleOpts.transparent
  // 白字/黑字只服务于「透明模式下字浮在桌面上看不清」的场景，
  // 退出透明时应回到站点原色，否则普通模式会被强行改色
  if (!styleOpts.transparent) styleOpts.fg = null
  applyStyle()
}
function toggleMedia() {
  styleOpts.hideMedia = !styleOpts.hideMedia
  applyStyle()
}

// 添加 / 移除书签：直接触发站点右上角的书签按钮。
// DOM 的 .click() 会冒泡到 React 的事件委托，实测可切换 _hasBookmark 状态；
// 用 CDP 合成指针序列反而常丢失 mouseup。找不到按钮时给一句提示。
// source === 'hotkey' 才发「书签添加成功 / 书签移除成功」：
// 手动点站点自己的按钮完全不经过这个函数，所以天然不会弹提示。
async function toggleBookmark(source) {
  if (!win || win.isDestroyed()) return
  const js = `(async () => {
    const SEL = '[class*="float_corner_bookmark_actionArea"]:not([class*="actionArea_"])';
    const btn = document.querySelector(SEL);
    if (!btn) return { status: 'none' };
    const isAdded = function (node) {
      if (!node) return false;
      const w = node.closest('[class*="bookmark_wrapper"]');
      const cls = (w && typeof w.className === 'string' ? w.className : '') + ' ' +
                  (typeof node.className === 'string' ? node.className : '');
      const txt = node.innerText || node.textContent || '';
      if (/移除/.test(txt)) return true;
      if (/添加/.test(txt)) return false;
      return /hasBookmark/i.test(cls);
    };
    const before = isAdded(btn);
    btn.click();
    // 站点在 React 里改文案并可能重建节点，等一帧再读
    await new Promise(r => setTimeout(r, 220));
    const after = isAdded(document.querySelector(SEL));
    // 只有 DOM 确实翻转了才采信 after；否则按 toggle 语义由 before 反推
    const added = (after !== before) ? after : !before;
    return { status: 'ok', added: added };
  })()`
  try {
    const r = await win.webContents.executeJavaScript(js, true)
    if (win.isDestroyed()) return
    if (!r || r.status === 'none') {
      win.webContents.send('wr-notice', '当前页面没有书签按钮，请先打开书籍正文')
    } else if (r.status === 'ok' && source === 'hotkey') {
      win.webContents.send('wr-bookmark-toast', r.added ? '书签添加成功' : '书签移除成功')
    }
  } catch (_) {}
}

const ACTIONS = {
  transparent: toggleTransparent,
  noImage: toggleMedia,
  boss: toggleWindow,
  bookmark: () => toggleBookmark('hotkey')
}
function fireAction(action) {
  if (capturing || !ACTIONS[action]) return
  const now = Date.now()
  if (now - (lastFire[action] || 0) < 250) return  // 主进程拦截 + 页面兜底可能都触发
  lastFire[action] = now
  ACTIONS[action]()
}

function broadcastKeys(message) {
  if (win && !win.isDestroyed()) {
    win.webContents.send('wr-keys', { config: keyConfig, message: message || '' })
  }
}
function setupShortcuts() {
  globalShortcut.unregisterAll()
  let downgraded = ''
  for (const [action, cfg] of Object.entries(keyConfig)) {
    if (cfg.mode !== 'global') continue
    // F12 等键被 Chromium 保留，globalShortcut 注册不上 → 自动降级为「应用内」
    if (!globalShortcut.register(cfg.key, () => fireAction(action))) {
      cfg.mode = 'app'
      downgraded += `${KEY_LABELS[action]}（${cfg.key}）`
    }
  }
  if (downgraded) saveKeys()
  updateTrayLabels()
  broadcastKeys(downgraded ? `${downgraded} 无法作为全局键，已自动改为「应用内」` : '')
  return downgraded ? `${downgraded} 无法作为全局键，已自动改为「应用内」` : ''
}

/* ---------- 托盘：显示当前键位，兜底入口 ---------- */

function updateTrayLabels() {
  if (!tray || tray.isDestroyed()) return
  const k = keyConfig
  tray.setToolTip(`微信读书（透明版）· ${k.boss.key} 显示/隐藏 · ${k.transparent.key} 透明 · ${k.noImage.key} 无图 · ${k.bookmark.key} 书签`)
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `显示 / 隐藏窗口（${k.boss.key}）`, click: toggleWindow },
    { label: `切换透明（${k.transparent.key}）`, click: toggleTransparent },
    { label: `切换无图（${k.noImage.key}）`, click: toggleMedia },
    // 托盘菜单属于手动操作，按需求不弹「添加/移除成功」提示
    { label: `添加 / 移除书签（${k.bookmark.key}）`, click: () => toggleBookmark() },
    { type: 'separator' },
    { label: '快捷键设置（面板里点「设置」）', click: () => win && win.webContents.send('wr-open-settings') },
    { type: 'separator' },
    { label: `微信读书 ${app.getVersion()} · 作者 MΛØ`, enabled: false },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() }
  ]))
}
function setupTray() {
  tray = new Tray(path.join(__dirname, 'tray.png'))
  updateTrayLabels()
  tray.on('click', toggleWindow)
}

/* ---------- IPC：悬浮面板与主进程通信 ---------- */

ipcMain.handle('wr-style', (_e, patch) => {
  const next = { ...patch }
  // 白字/黑字仅在透明模式下有效：非透明时收到的改色请求直接丢弃
  if ('fg' in next) {
    const willBeTransparent = ('transparent' in next) ? !!next.transparent : styleOpts.transparent
    if (next.fg && !willBeTransparent) next.fg = null
  }
  if ('transparent' in next && !next.transparent) next.fg = null
  Object.assign(styleOpts, next)
  return applyStyle()
})
ipcMain.handle('wr-get-style', () => styleOpts)

ipcMain.on('wr-zoom', (_e, factor) => {
  if (win) win.webContents.setZoomFactor(factor)
})
ipcMain.on('wr-minimize', () => win && win.minimize())
ipcMain.on('wr-close', () => win && win.close())
ipcMain.handle('wr-pin', () => {
  if (!win) return false
  const next = !win.isAlwaysOnTop()
  win.setAlwaysOnTop(next)
  return next
})
ipcMain.on('wr-reload', () => win && win.webContents.reload())

/* ---------- 快捷键设置 IPC ---------- */
ipcMain.handle('wr-get-keys', () => keyConfig)
ipcMain.handle('wr-set-key', (_e, { action, key, mode }) => {
  if (!DEFAULT_KEYS[action]) return { ok: false, error: '未知功能' }
  key = String(key || '').trim()
  const nextMode = ['global', 'app', 'off'].includes(mode) ? mode : keyConfig[action].mode
  const fail = error => {
    capturing = false
    setupShortcuts()   // 结束录制状态，恢复原来的快捷键
    return { ok: false, error }
  }
  if (nextMode !== 'off') {
    const err = validateKey(key)
    if (err) return fail(err)
    const p = parseAccel(key)
    for (const [a, c] of Object.entries(keyConfig)) {
      if (a === action || c.mode === 'off') continue
      const q = parseAccel(c.key)
      if (q.key === p.key && JSON.stringify(q.mods) === JSON.stringify(p.mods)) {
        return fail(`与「${KEY_LABELS[a]}」键位冲突`)
      }
    }
  }
  keyConfig[action] = { key: key || keyConfig[action].key, mode: nextMode }
  capturing = false
  saveKeys()
  const notice = setupShortcuts()
  return { ok: true, config: keyConfig, notice }
})
ipcMain.handle('wr-reset-keys', () => {
  for (const a of Object.keys(DEFAULT_KEYS)) keyConfig[a] = { ...DEFAULT_KEYS[a] }
  capturing = false
  saveKeys()
  setupShortcuts()
  return { ok: true, config: keyConfig }
})
ipcMain.handle('wr-capture-begin', () => {
  capturing = true
  globalShortcut.unregisterAll()   // 录制时先摘掉全局键，避免按键直接触发动作
  return true
})
ipcMain.handle('wr-capture-end', () => {
  capturing = false
  setupShortcuts()
  return true
})
ipcMain.on('wr-fire', (_e, action) => fireAction(action))
// 兼容旧的页面内兜底通道
ipcMain.on('wr-toggle-transparent', () => fireAction('transparent'))

/* ---------- 启动 ---------- */

app.whenReady().then(() => {
  createWindow()
  setupShortcuts()
  setupTray()
})

app.on('will-quit', () => globalShortcut.unregisterAll())
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
