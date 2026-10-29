'use strict';

/**
 * 极简 zip 写入器（纯 Node，无第三方依赖）。
 * 只做打包发布需要的事：store/deflate 两种方式、UTF-8 文件名、单个目录前缀。
 * 之所以不用 Compress-Archive / 7z：调用外部命令在不同环境里可能被拦或编码出错，
 * 而文件名是中文，一旦编码错了整包都是乱码。
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xFF];
  return (c ^ -1) >>> 0;
}

function dosTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/**
 * @param {string} dest 输出 zip 路径
 * @param {{name:string, filePath:string}[]} entries name 是包内路径（用 / 分隔）
 */
function writeZip(dest, entries) {
  const chunks = [];
  const central = [];
  let offset = 0;

  entries.forEach((entry) => {
    const data = fs.readFileSync(entry.filePath);
    const stat = fs.statSync(entry.filePath);
    const nameBuf = Buffer.from(entry.name.replace(/\\/g, '/'), 'utf8');
    const crc = crc32(data);
    const { time, date } = dosTime(stat.mtime);

    // 小于 1KB 或已经是压缩格式的直接 store，省时间也不涨体积
    const stored = !/\.(exe|dll|pak|bin|dat|asar)$/i.test(entry.name) && data.length < 4096;
    const body = stored ? data : zlib.deflateRawSync(data, { level: 6 });
    const method = stored ? 0 : 8;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);            // version needed
    local.writeUInt16LE(0x0800, 6);        // UTF-8 文件名
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    chunks.push(local, nameBuf, body);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);              // version made by
    dir.writeUInt16LE(20, 6);              // version needed
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt16LE(time, 12);
    dir.writeUInt16LE(date, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt16LE(0, 30);              // extra
    dir.writeUInt16LE(0, 32);              // comment
    dir.writeUInt16LE(0, 34);              // disk
    dir.writeUInt16LE(0, 36);              // internal attr
    dir.writeUInt32LE(0, 38);              // external attr
    dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  });

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, Buffer.concat([Buffer.concat(chunks), centralBuf, eocd]));
  return { files: entries.length, size: fs.statSync(dest).size };
}

module.exports = { writeZip, crc32 };
