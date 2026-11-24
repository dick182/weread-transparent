// 生成 32x32 托盘图标（蓝色圆底 + 白色“文本行”，无需外部依赖）
const zlib = require('zlib')
const fs = require('fs')
const path = require('path')

const W = 32, H = 32
const buf = Buffer.alloc(W * H * 4)

for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4
    const dx = x - 15.5, dy = y - 15.5
    const r = Math.sqrt(dx * dx + dy * dy)
    if (r <= 15) {
      buf[i] = 76; buf[i + 1] = 141; buf[i + 2] = 255; buf[i + 3] = 255 // 蓝色圆底
      // 三条白色“文字行”
      const bar = (y >= 10 && y <= 12) || (y >= 16 && y <= 18) || (y >= 22 && y <= 24)
      if (bar && x >= 9 && x <= 22 && r <= 13) {
        buf[i] = 255; buf[i + 1] = 255; buf[i + 2] = 255
      }
    }
  }
}

// PNG 编码
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
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4)
ihdr[8] = 8; ihdr[9] = 6 // 8bit RGBA
const raw = Buffer.alloc((W * 4 + 1) * H)
for (let y = 0; y < H; y++) {
  raw[y * (W * 4 + 1)] = 0 // filter none
  buf.copy(raw, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4)
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0))
])
fs.writeFileSync(path.join(__dirname, 'tray.png'), png)
console.log('tray.png 生成完成:', png.length, 'bytes')
