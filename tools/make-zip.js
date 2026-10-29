'use strict';

/**
 * 打一个干净的发布 zip：只装程序本体 + 使用说明，不含 data。
 * data 里既有用户数据，也有 .runtime（Chromium 缓存，约 9.5MB），都不该进安装包。
 *
 * 用法：npm run build  →  rcedit  →  npm run zip
 * 输出：release/教师请假系统-v<version>.zip
 */

const fs = require('fs');
const path = require('path');
const { writeZip } = require('./zip.js');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = pkg.version;
const srcDir = path.join(root, 'dist', 'win-unpacked');
const zipPath = path.join(root, 'release', `教师请假系统-v${version}.zip`);
const TOP = '教师请假系统';

if (!fs.existsSync(path.join(srcDir, '教师请假系统.exe'))) {
  console.error('找不到 dist/win-unpacked/教师请假系统.exe，请先执行 npm run build');
  process.exit(1);
}

// 这些不进包：data（用户数据 + .runtime 缓存）、electron-builder 的调试文件
const SKIP_FILES = new Set(['builder-debug.yml', 'builder-effective-config.yaml']);
const SKIP_DIRS = new Set(['data']);

const entries = [];

function walk(dir, prefix) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
    if (entry.isDirectory()) {
      if (prefix === TOP && SKIP_DIRS.has(entry.name)) return;
      walk(path.join(dir, entry.name), prefix + '/' + entry.name);
      return;
    }
    if (prefix === TOP && SKIP_FILES.has(entry.name)) return;
    entries.push({ name: prefix + '/' + entry.name, filePath: path.join(dir, entry.name) });
  });
}

walk(srcDir, TOP);

// 使用说明放在包根目录
const readme = path.join(root, '使用说明.txt');
if (fs.existsSync(readme)) entries.push({ name: TOP + '/使用说明.txt', filePath: readme });

const started = Date.now();
const out = writeZip(zipPath, entries);
const seconds = ((Date.now() - started) / 1000).toFixed(1);

console.log(`已生成 ${path.relative(root, zipPath)}`);
console.log(`  ${out.files} 个文件（已排除 data/，含 .runtime 缓存）`);
console.log(`  ${(out.size / 1024 / 1024).toFixed(1)} MB，耗时 ${seconds}s`);
