const fs = require('node:fs');
const path = require('node:path');

const size = 256;
const stride = size * 4;
const pixels = Buffer.alloc(stride * size);

function insideRoundedRect(x, y, left, top, width, height, radius) {
  const right = left + width;
  const bottom = top + height;
  if (x >= left + radius && x < right - radius && y >= top && y < bottom) return true;
  if (y >= top + radius && y < bottom - radius && x >= left && x < right) return true;
  const cornerX = x < left + radius ? left + radius : right - radius - 1;
  const cornerY = y < top + radius ? top + radius : bottom - radius - 1;
  return (x - cornerX) ** 2 + (y - cornerY) ** 2 <= radius ** 2;
}

function putPixel(x, y, red, green, blue, alpha = 255) {
  const invertedY = size - 1 - y;
  const offset = invertedY * stride + x * 4;
  pixels[offset] = blue;
  pixels[offset + 1] = green;
  pixels[offset + 2] = red;
  pixels[offset + 3] = alpha;
}

for (let y = 0; y < size; y += 1) {
  for (let x = 0; x < size; x += 1) {
    if (!insideRoundedRect(x, y, 8, 8, 240, 240, 58)) continue;
    putPixel(x, y, 11, 18, 32);
    if (insideRoundedRect(x, y, 43, 47, 170, 162, 37)) {
      const ratio = ((x - 43) + (y - 47)) / 332;
      putPixel(x, y, Math.round(124 - 91 * ratio), Math.round(92 + 120 * ratio), Math.round(255 - 88 * ratio));
    }
    if (insideRoundedRect(x, y, 70, 75, 76, 56, 15)) putPixel(x, y, 247, 249, 255);
    if (insideRoundedRect(x, y, 154, 75, 29, 56, 12)) putPixel(x, y, 11, 18, 32, 225);
    if (insideRoundedRect(x, y, 70, 139, 48, 40, 11)) putPixel(x, y, 11, 18, 32, 220);
    if (insideRoundedRect(x, y, 126, 139, 57, 40, 11)) putPixel(x, y, 247, 249, 255);
  }
}

const maskStride = Math.ceil(size / 32) * 4;
const mask = Buffer.alloc(maskStride * size);
for (let y = 0; y < size; y += 1) {
  for (let x = 0; x < size; x += 1) {
    const pixelOffset = (size - 1 - y) * stride + x * 4;
    if (pixels[pixelOffset + 3] !== 0) continue;
    const maskOffset = (size - 1 - y) * maskStride + Math.floor(x / 8);
    mask[maskOffset] |= 0x80 >> (x % 8);
  }
}

const bitmapHeader = Buffer.alloc(40);
bitmapHeader.writeUInt32LE(40, 0);
bitmapHeader.writeInt32LE(size, 4);
bitmapHeader.writeInt32LE(size * 2, 8);
bitmapHeader.writeUInt16LE(1, 12);
bitmapHeader.writeUInt16LE(32, 14);
bitmapHeader.writeUInt32LE(pixels.length, 20);
const image = Buffer.concat([bitmapHeader, pixels, mask]);

const iconHeader = Buffer.alloc(6);
iconHeader.writeUInt16LE(1, 2);
iconHeader.writeUInt16LE(1, 4);
const entry = Buffer.alloc(16);
entry.writeUInt8(0, 0);
entry.writeUInt8(0, 1);
entry.writeUInt16LE(1, 4);
entry.writeUInt16LE(32, 6);
entry.writeUInt32LE(image.length, 8);
entry.writeUInt32LE(22, 12);

const outputDirectory = path.join(__dirname, '..', 'build');
fs.mkdirSync(outputDirectory, { recursive: true });
fs.writeFileSync(path.join(outputDirectory, 'icon.ico'), Buffer.concat([iconHeader, entry, image]));
console.log('Generated build/icon.ico');
