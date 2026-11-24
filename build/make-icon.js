/* 生成应用图标 build/icon.png（1024x1024，RGBA）：
   蓝色圆角方块 + 三条白色“文字行” + 右上角一枚透明小孔，象征“透明阅读”。
   纯 Node 手写 PNG 编码，不依赖任何图形库。 */
const zlib = require('zlib')
const fs = require('fs')
const path = require('path')

const S = 1024
const buf = Buffer.alloc(S * S * 4)

const inRoundRect = (x, y, l, t, r, b, rad) => {
  if (x < l || x > r || y < t || y > b) return false
  const cx = Math.min(Math.max(x, l + rad), r - rad)
  const cy = Math.min(Math.max(y, t + rad), b - rad)
  const dx = x - cx, dy = y - cy
  return dx * dx + dy * dy <= rad * rad
}
const inCircle = (x, y, cx, cy, r) => (x - cx) * (x - cx) + (y - cy) * (y - cy) <= r * r

// 3x3 超采样，得到平滑边缘
const SS = 3
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    let acc = [0, 0, 0, 0]
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const px = x + (sx + 0.5) / SS
        const py = y + (sy + 0.5) / SS
        let r = 0, g = 0, b = 0, a = 0

        // 底板：圆角方块（留 40px 边距，视觉上更稳）
        if (inRoundRect(px, py, 40, 40, S - 40, S - 40, 210)) {
          // 左上到右下的蓝色渐变
          const t = (px + py) / (2 * S)
          r = Math.round(74 + (29 - 74) * t)
          g = Math.round(144 + (78 - 144) * t)
          b = Math.round(255 + (216 - 255) * t)
          a = 255
          // 顶部一层很淡的高光
          if (py < 380) {
            const hi = Math.round(26 * (1 - py / 380))
            r = Math.min(255, r + hi); g = Math.min(255, g + hi); b = Math.min(255, b + hi)
          }
          // 三条白色“文字行”
          const bars = [[300, 372], [452, 524], [604, 676]]
          for (const [y0, y1] of bars) {
            if (py >= y0 && py <= y1) {
              const wide = x < S * 0.5 ? 1 : 0
              const right = wide ? 700 : 640
              if (px >= 236 && px <= right) {
                r = 255; g = 255; b = 255
              }
            }
          }
          // 第四条短行，做出“段落”节奏
          if (py >= 756 && py <= 828 && px >= 236 && px <= 512) {
            r = 255; g = 255; b = 255
          }
          // 右上角“透明”小孔：挖掉一块，露出西装色（模拟透明）
          const hx = S - 268, hy = 268
          if (inCircle(px, py, hx, hy, 92)) {
            a = 0
          } else if (inCircle(px, py, hx, hy, 116)) {
            // 小孔描边
            r = 255; g = 255; b = 255
          }
        }

        acc[0] += r; acc[1] += g; acc[2] += b; acc[3] += a
      }
    }
    const n = SS * SS
    const i = (y * S + x) * 4
    buf[i] = Math.round(acc[0] / n)
    buf[i + 1] = Math.round(acc[1] / n)
    buf[i + 2] = Math.round(acc[2] / n)
    buf[i + 3] = Math.round(acc[3] / n)
  }
}

/* ---- PNG 编码 ---- */
const table = new Int32Array(256)
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
  table[n] = c
}
function crc32(data) {
  let c = 0xFFFFFFFF
  for (const b of data) c = table[(c ^ b) & 0xFF] ^ (c >>> 8)
  return (c ^ 0xFFFFFFFF) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const t = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])))
  return Buffer.concat([len, t, data, crc])
}
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4)
ihdr[8] = 8; ihdr[9] = 6
const raw = Buffer.alloc((S * 4 + 1) * S)
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0
  buf.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4)
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
])
fs.writeFileSync(path.join(__dirname, 'icon.png'), png)
console.log('icon.png 生成完成:', png.length, 'bytes')
