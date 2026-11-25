# 微信读书（透明版）· WeRead Transparent 1.0.6

作者：**MΛØ**

把网页版微信读书包成一个无边框、可透明的桌面客户端：透明模式下只留正文浮在桌面上，
其余界面全部隐藏，配合老板键可以随时一键消失。

---

## 一、这个版本是什么

| 项 | 说明 |
|---|---|
| 形态 | Electron 33 桌面客户端，加载 `https://weread.qq.com/`，登录态本地持久化 |
| 版本 | 1.0.6 |
| 作者 | MΛØ |
| 免安装 | 便携版：单个 exe 双击即用，不写注册表、不建开始菜单 |
| 数据 | 默认 `%APPDATA%\weread-transparent`；放了 `portable.txt` 则存到 exe 旁边 `data\` |

## 二、功能

- **透明（沉浸）模式**：抹掉页面所有背景，只留正文与插图；顶部栏、右侧工具栏、底部翻页条、
  目录浮层、页头章节名全部隐藏——这些元素用 `opacity:0` 隐藏而不是 `display:none`，
  正文排版一个字都不会挪。想翻页就点左右 13% 边缘、滚轮，或用 ←/→、PageUp/PageDown。
  **唯一保留的站点功能是右上角「添加书签」角标**：平时完全隐形，鼠标移到右上角才出现
  蓝色书签图标 +「点击（移除）书签」文字，点一下加书签、再点一下移除；也可以直接用快捷键
  `Alt+B` 加/移除，不必去找按钮。站点原本只在指针精确压在那条 15px 宽的 svg 上时才把图标
  刷成蓝色，鼠标停在旁边的文字上就退化成灰色 `#d4d6d8`、看着像半透明残影（用户截图里的
  「错误图标」）。1.0.4 起在显示态把填充色锁死为站点品牌蓝 `#1b88ee`，隐藏态连 wrapper
  自身一起 `opacity:0 + visibility:hidden`。1.0.5 又把 `actionArea` 的默认位移
  `translateY(-100%)` 钉成 0——站点平时只让一小截书签「舌头」探在页面顶边外面、悬停才落回页内，
  钉死后按钮恒定停在页内的正确位置，不会出现「页内一枚 + 顶边一枚」两个书签。
  1.0.6 起用快捷键加/移除书签，会在窗口底部弹一句带绿色对勾的「书签添加成功 / 书签移除成功」
  （3 秒淡出）；这条提示只走快捷键路径，手动点右上角角标不会弹。
- **无图模式**：只隐藏书籍封面与正文插图，按钮图标、头像、想法里的红心/评论都不受影响。
- **白字 / 黑字**：仅透明模式下可用（透明=桌面底色不可控，需要手动定字色）。透明模式默认黑字，
  暗色主题下自动白字。
- **热门想法 / 划线笔记 / 设置界面**：透明模式下不做透明处理，始终保持自己的底色，保证可读；
  设置界面固定黑底白字。
- **快捷键**：`F12` 透明、`Alt+X` 无图、`Alt+Z` 老板键（隐藏/唤回窗口）、`Alt+B` 添加/移除书签，
  全部可在面板「设置」里改键位与模式（全局 / 应用内 / 关闭），带冲突与裸键校验，
  配置存 `hotkeys.json`。
- **书签快捷键反馈**：按 `Alt+B` 加/移除书签后，窗口底部弹出「✓ 书签添加成功 / 书签移除成功」，
  3 秒后自动淡出。手动点右上角书签角标不会弹这条提示。
- **托盘**：老板键失联时的兜底入口，菜单里也会显示当前键位。

## 三、目录结构

```
main.js              主进程：窗口、会话、样式注入、快捷键、托盘、IPC
preload.js           悬浮控制面板 + 设置弹层（隔离世界，直连 ipcRenderer）
theme-sync.js        页面主世界：按主题维护 --wr-auto-fg / --wr-panel-fg
black-text-patch.js  页面主世界：拦截 canvas 的 fillText/strokeText，改正文颜色
page-turn.js         页面主世界：透明模式的左右点击区 / 滚轮翻页
bookmark-hover.js    页面主世界：透明模式书签角标的右上角热区探测（切换 __wr_bm 属性）
cdp.js               调试用 CDP 小工具（打包时不会进 exe）
tray.png             托盘图标
gen-icon.js          生成 tray.png
build/make-icon.js   生成 build/icon.png（应用图标，纯 Node 手写 PNG）
build/icon.png       应用图标源文件
package.json         依赖 + electron-builder 打包配置
```

## 四、本地跑起来

```bash
npm install
npm start
```

> Windows 上如果 shell 里带着 `ELECTRON_RUN_AS_NODE=1`，Electron 会退化成纯 Node 直接退出，
> 用 `env -u ELECTRON_RUN_AS_NODE npx electron .` 启动即可。

## 五、重新打包

```bash
npm run icon     # 需要改图标时，重新生成 build/icon.png
npm run dist     # 产出 dist/WeRead-Transparent-1.0.6-Portable.exe
```

国内网络建议加镜像：

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ \
ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ \
npx electron-builder --win --x64
```

## 六、几个必须知道的坑（都是从调试里踩出来的）

1. **正文不是 DOM 文字**，是画在 canvas 上的，CSS 改不动颜色，只能拦截
   `CanvasRenderingContext2D.prototype.fillText/strokeText` 临时替换填充色。
2. **隔离世界的事件站点不认**：preload 里派发的 PointerEvent 会被站点忽略，翻页必须注入主世界。
3. **透明开关不能靠 `removeInsertedCSS`**：key 会失效、并发时残留。改用「属性门控 CSS」，
   `<html>` 上的 `__wr_t` / `__wr_m` / `__wr_fg` 就是开关，删属性即恢复，永远没有残留。
4. **方向键只能有一套逻辑**：透明模式早期自己拦了 keydown 又派发点击，和站点自带的键盘翻页
   叠加，一次按键翻两页。现在方向键完全交给站点，补丁只管滚轮和左右点击区。
5. **透明模式会把背景全抹掉**，导致「看背景亮度判断暗色主题」失效；此时沿用非透明时的采样结果。
6. **透明模式下要放行浮层**：设置界面、热门想法面板必须保留自身底色，否则字直接浮在桌面上。
   排除方式是 `:not(.wr-ui-solid):not([class*="float_panel"])…`，两条规则（抹背景 / 改字色）共用。
7. **滚轮不能无条件当翻页**：热门想法面板打开时，在面板里滚一下，`wheel` 冒泡到 window，
   补丁顺手点了「下一页」——面板被站点关掉，看起来像「滚一下想法就消失并翻页」。
   现在 `panelOpen()` / `insidePanel()` 会先判断浮层是否开着（用 `.reviews_panel`、
   `.reader_float_panel_container` 的可见尺寸，不能用 `[class*=float_panel]` 通配，
   页面上常驻着几个 `pointer-events:none` 的全屏 wrapper，会把正文滚轮误伤成永久失效）。
8. **点击区的 z-index 有两条上限**：既要低于书籍浮层（99999，否则浮层两侧 13% 点不到），
   又要让开整个书签角标区（`top:152px`，不是 84px —— 站点 hover 时按钮会从 y3 滑到 y72，
   下沿到 142，只让 84px 会把下移后的按钮盖住，既点不到、也让 hover 探测拿不到真实命中）。
9. **书签角标的隐藏必须连 wrapper 自身一起设为 `opacity:0`**：早期版本只压后代、把 wrapper
   留在 `opacity:1`，结果 wrapper 自己的 `::before/::after` 和站点给 wrapper 设的背景仍会
   渲染出来，鼠标移开后残留一小块 → 用户看到「上方又闪一下书签」。
   另外「通配选择器」匹配不到伪元素，`::before`/`::after` 要单独点名。
   显隐由 `bookmark-hover.js` 切 `<html>` 上的 `__wr_bm` 属性控制，CSS 依属性瞬时显隐
   （`transition:none` / `animation:none`），与站点点击后重建节点彻底解耦。
   1.0.4 又补了 `visibility:hidden`：透明窗口下只压 `opacity` 偶尔会残留一帧旧合成画面，
   加 `visibility` 后移开即彻底不绘制。
10. **书签图标的蓝色只挂在 `svg:hover` 上，是个坑**：站点 CSS 是
    `#iconFill{fill:#d4d6d8}` + `svg:hover #iconFill{fill:#1b88ee!important}`，
    也就是说指针必须精确落在那条 15px 宽的 svg 上才会变蓝；停在旁边的「点击添加书签」
    文字上时图标一直是灰色 `#d4d6d8`，在透明窗口里看着就像一枚半透明残影、位置也不对。
    现在显示态直接 `fill:#1b88ee !important`（连同 `#iconFill` 的 `opacity:0` 一起压成 1），
    热区内任意落点都是同一枚蓝色实心图标。
11. **`actionArea` 默认是 `translateY(-100%)`，必须钉成 0**：站点平时只让一小截书签「舌头」
    探在页面顶边外面，悬停才落回页内和文字同行。我们的热区上下各留了余量，指针停在余量里
    时站点收不到 hover，于是「文字在页内、图标挂在顶边」——用户看到的就是「两个书签按钮」。
    透明模式下强制 `transform: translateY(0) !important`，位置恒定，显隐只由 `__wr_bm` 决定。
12. **热区必须取按钮两态的并集**：站点 hover 时把 actionArea 从 y3~73 滑到 y72~142，
    鼠标停在原处就会一会儿在按钮上、一会儿不在，判定跟着反复翻转 → 闪烁。
    现在纵向固定 0~150、横向跟按钮左右，并用 `elementFromPoint` 做真实命中优先判断。
13. **模板字符串里的反引号是个隐雷**：CSS 规则写在 JS 模板字符串里，注释里随手写一个
    `` `*` `` 就会提前闭合模板，`CSS_RULES` 变成 `字符串 * 字符串` = `NaN`，
    表现是 `insertCSS` 报 `Error processing argument at index 0, conversion failure`，
    而且连累 `wr-style` IPC 一起失败（面板按钮全部失灵）。改注释时别在模板字符串里用反引号。
    `applyStyle` 现在对 `insertCSS` 失败做了降级：改用 `<style id="wr-style">` 注入。
14. **「书签成功」提示只在快捷键路径发**：`toggleBookmark(source)` 只有 `source === 'hotkey'`
    时才发 `wr-bookmark-toast`；`ACTIONS.bookmark` 包成 `() => toggleBookmark('hotkey')`，
    手动点站点角标根本不经过主进程，托盘菜单也显式传空 —— 三条路径天然分开，不必监听页面点击
    就能做到「只在快捷键时提示」。到底是添加还是移除，由点击前后的按钮文案（含「添加」/「移除」）
    判定；站点 DOM 没及时翻转时，按 toggle 语义用点击前状态反推。

## 七、便携版说明

- 单个 exe：双击运行，首次启动会解压到 `%TEMP%\WeReadTransparent`，退出即清理。
- 想让**登录态和数据跟着 U 盘走**：在 exe 同目录建一个空文件 `portable.txt`，
  数据就会写到 `data\` 子目录。
- 不建 `portable.txt` 时沿用 `%APPDATA%\weread-transparent`，和开发版共用同一份登录态。

## 八、许可

MIT。本项目只是把公开网页包装成桌面窗口，书籍内容与账号归微信读书所有，请遵守其服务条款。
