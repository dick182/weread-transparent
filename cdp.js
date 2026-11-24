// 轻量 CDP 客户端：node cdp.js list|eval "<js>"|shot <file>|nav <url>
const http = require('http')
const fs = require('fs')
const PORT = 9222

function httpGet(path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path }, res => {
      let d = ''
      res.setEncoding('utf8')
      res.on('data', c => (d += c))
      res.on('end', () => resolve(d))
    })
    req.on('error', reject)
    req.setTimeout(8000, () => req.destroy(new Error('timeout')))
  })
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    ws.onopen = () => resolve(ws)
    ws.onerror = () => reject(new Error('ws connect failed'))
  })
}

let msgId = 0
function send(ws, method, params = {}) {
  const id = ++msgId
  return new Promise((resolve, reject) => {
    const onMsg = ev => {
      const msg = JSON.parse(ev.data)
      if (msg.id === id) {
        ws.removeEventListener('message', onMsg)
        if (msg.error) reject(new Error(JSON.stringify(msg.error)))
        else resolve(msg.result)
      }
    }
    ws.addEventListener('message', onMsg)
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2)
  const targets = JSON.parse(await httpGet('/json/list'))
  if (cmd === 'list') {
    console.log(targets.map(t => `${t.type}\t${t.url}`).join('\n'))
    return
  }
  const page = targets.find(t => t.type === 'page' && /weread/.test(t.url)) || targets.find(t => t.type === 'page')
  if (!page) throw new Error('no page target')

  const ws = await connect(page.webSocketDebuggerUrl)
  await send(ws, 'Runtime.enable')

  if (cmd === 'eval') {
    const expr = args.join(' ')
    const r = await send(ws, 'Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception || {}).description)
    console.log(typeof r.result.value === 'object' ? JSON.stringify(r.result.value, null, 1) : r.result.value)
  } else if (cmd === 'shot') {
    let r
    try {
      r = await send(ws, 'Page.captureScreenshot', { format: 'png', fromSurface: true })
    } catch (_) {
      r = await send(ws, 'Page.captureScreenshot', { format: 'png', fromSurface: false })
    }
    fs.writeFileSync(args[0] || 'shot.png', Buffer.from(r.data, 'base64'))
    console.log('saved', args[0])
  } else if (cmd === 'inject') {
    // node cdp.js inject <file.js>
    const code = fs.readFileSync(args[0], 'utf8')
    const r = await send(ws, 'Runtime.evaluate', { expression: code, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception || {}).description)
    console.log('injected ->', r.result.value)
  } else if (cmd === 'search') {
    // node cdp.js search "风景如画"
    await send(ws, 'DOM.enable')
    const q = args.join(' ')
    const r = await send(ws, 'DOM.performSearch', { query: q, includeUserAgentShadowDOM: true })
    const res = await send(ws, 'DOM.getSearchResults', { searchId: r.searchId, fromIndex: 0, toIndex: Math.min(r.resultCount, 5) })
    const out = []
    for (const id of res.nodeIds) {
      const d = await send(ws, 'DOM.describeNode', { nodeId: id, depth: 3 })
      out.push({ name: d.node.nodeName, attrs: d.node.attributes, parent: d.node.parentNode ? { name: d.node.parentNode.nodeName, attrs: d.node.parentNode.attributes } : null })
    }
    console.log(JSON.stringify({ resultCount: r.resultCount, hits: out }, null, 1).slice(0, 2000))
  } else if (cmd === 'node') {
    // node cdp.js node 497 537
    await send(ws, 'DOM.enable')
    const x = parseFloat(args[0]), y = parseFloat(args[1])
    const loc = await send(ws, 'DOM.getNodeForLocation', { x, y, includeUserAgentShadowDOM: true })
    const desc = await send(ws, 'DOM.describeNode', { backendNodeId: loc.backendNodeId, depth: 4 })
    console.log(JSON.stringify(desc.node, null, 1).slice(0, 2500))
  } else if (cmd === 'click') {
    // node cdp.js click 945 573
    const x = parseFloat(args[0]), y = parseFloat(args[1])
    await send(ws, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await send(ws, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await new Promise(r => setTimeout(r, 80))
    await send(ws, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
    console.log('clicked', x, y)
  } else if (cmd === 'key') {
    // node cdp.js key ArrowLeft 3
    const key = args[0] || 'ArrowLeft'
    const times = parseInt(args[1] || '1', 10)
    const codes = { ArrowLeft: 37, ArrowRight: 39, ArrowUp: 38, ArrowDown: 40, F12: 123 }
    for (let i = 0; i < times; i++) {
      for (const type of ['keyDown', 'keyUp']) {
        await send(ws, 'Input.dispatchKeyEvent', {
          type, key, code: key, windowsVirtualKeyCode: codes[key] || 0, nativeVirtualKeyCode: codes[key] || 0
        })
      }
      await new Promise(r => setTimeout(r, 400))
    }
    console.log('sent', key, 'x' + times)
  } else if (cmd === 'front') {
    await send(ws, 'Page.bringToFront')
    console.log('brought to front')
  } else if (cmd === 'nav') {
    await send(ws, 'Page.navigate', { url: args[0] })
    console.log('navigating to', args[0])
  }
  ws.close()
}

main().catch(e => { console.error('ERR', e.message); process.exit(1) })
