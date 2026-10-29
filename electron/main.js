'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { Store, stamp } = require('./store');
const { exportWorkbook } = require('./exporter');

const isPackaged = app.isPackaged;
const baseDir = isPackaged ? path.dirname(app.getPath('exe')) : path.join(__dirname, '..');
const dataDir = path.join(baseDir, 'data');

try {
  fs.mkdirSync(path.join(dataDir, '.runtime'), { recursive: true });
} catch (e) {
  /* 目录不可写时由后续 Store 报错处理 */
}

try {
  app.setPath('userData', path.join(dataDir, '.runtime'));
} catch (e) {
  /* ignore */
}

app.setAppUserModelId('com.local.teacherleave');

let store;
try {
  store = new Store(dataDir);
} catch (err) {
  dialog.showErrorBox(
    '无法访问数据文件夹',
    '程序需要在本文件夹下创建 data 目录来保存请假记录，但创建失败：\n\n' + dataDir + '\n\n' +
    '请确认本文件夹没有被设置为只读，或没有被安全软件拦截。\n\n详细错误：' + (err.message || err)
  );
  app.exit(1);
}

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1080,
    minHeight: 680,
    title: '教师请假管理系统',
    backgroundColor: '#F4F6FA',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());

  mainWindow.on('closed', () => { mainWindow = null; });
}

const gotLock = app.requestSingleInstanceLock();if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    if (!isPackaged) {
      Menu.setApplicationMenu(Menu.buildFromTemplate([
        { label: '视图', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }] }
      ]));
    } else {
      Menu.setApplicationMenu(null);
    }
    registerIpc();
    createWindow();
  });

  app.on('window-all-closed', () => { app.quit(); });
}

function safe(handler) {
  return async (event, ...args) => {
    try {
      return await handler(event, ...args);
    } catch (err) {
      console.error('[ipc]', err);
      return { ok: false, error: err.message || String(err) };
    }
  };
}

function registerIpc() {
  ipcMain.handle('app:init', safe(async () => {
    try {
      const settings = store.loadSettings();
      const leaves = store.loadLeaves();
      return {
        ok: true,
        settings,
        records: leaves.records || [],
        info: store.info(),
        version: app.getVersion(),
        platform: process.platform
      };
    } catch (err) {
      return {
        ok: false,
        error: err.message,
        code: err.code || '',
        info: store.info(),
        backups: store.listBackups()
      };
    }
  }));

  ipcMain.handle('leaves:save', safe(async (event, records) => {
    if (!Array.isArray(records)) return { ok: false, error: '数据格式错误' };
    const payload = store.saveLeaves({ records });
    // noSeq 回传，让渲染进程的 settings 快照跟上（否则它下次存设置会把计数器写旧）
    return { ok: true, count: payload.records.length, noSeq: payload.noSeq };
  }));

  ipcMain.handle('leaves:nextNo', safe(async (event, dateStr) => {
    const leaves = store.loadLeaves();
    return { ok: true, no: store.nextLeaveNo(leaves.records || [], dateStr) };
  }));

  ipcMain.handle('settings:save', safe(async (event, settings) => {
    const merged = store.saveSettings(settings || {});
    return { ok: true, settings: merged };
  }));

  ipcMain.handle('export:excel', safe(async (event, payload) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    let defaultDir = '';
    try { defaultDir = app.getPath('desktop'); } catch (e) { defaultDir = os.homedir(); }
    const teacher = payload && payload.teacher ? payload.teacher : null;
    const who = teacher && teacher.name ? String(teacher.name).replace(/[\\\/:*?"<>|]/g, '_') : '';
    const defaultName = (who ? who + '_请假明细_' : '教师请假明细_') + stamp() + '.xlsx';

    const res = await dialog.showSaveDialog(win, {
      title: '导出为 Excel',
      defaultPath: path.join(defaultDir || baseDir, defaultName),
      filters: [{ name: 'Excel 工作簿', extensions: ['xlsx'] }]
    });

    if (res.canceled || !res.filePath) return { ok: false, canceled: true };

    let outPath = res.filePath;
    if (!/\.xlsx$/i.test(outPath)) outPath += '.xlsx';

    const result = await exportWorkbook({
      records: payload.records || [],
      filterText: payload.filterText || '全部记录',
      teacher,
      outPath
    });

    shell.showItemInFolder(outPath);
    return { ok: true, path: outPath, count: result.count };
  }));

  ipcMain.handle('data:openFolder', safe(async () => {
    await shell.openPath(dataDir);
    return { ok: true, path: dataDir };
  }));

  ipcMain.handle('data:openBackupFolder', safe(async () => {
    await shell.openPath(store.backupDir);
    return { ok: true, path: store.backupDir };
  }));

  ipcMain.handle('backups:list', safe(async () => {
    return { ok: true, items: store.listBackups() };
  }));

  ipcMain.handle('data:stats', safe(async () => {
    return Object.assign({ ok: true }, store.stats());
  }));

  ipcMain.handle('backups:prune', safe(async () => {
    store.pruneBackups();
    return { ok: true, items: store.listBackups() };
  }));

  ipcMain.handle('backups:create', safe(async () => {
    const p = store.backup('manual');
    return { ok: !!p, path: p };
  }));

  ipcMain.handle('backups:restore', safe(async (event, name) => {
    // 确认动作交给界面（renderer 的 askConfirm 会把这份备份里有多少条记录、
    // 哪些教师一并写清楚）。这里再弹一个系统对话框等于连问两次，
    // 用户很容易在第二个框上点「取消」或看错，反而以为恢复成功了。
    const data = store.restoreBackup(name);
    return { ok: true, records: data.records };
  }));

  ipcMain.handle('app:revealData', safe(async () => {
    shell.showItemInFolder(store.leavesPath);
    return { ok: true };
  }));

  ipcMain.handle('log:error', safe(async (event, payload) => {
    try {
      const file = path.join(dataDir, 'error.log');
      const line = '[' + new Date().toISOString() + '] ' +
        String((payload && payload.message) || '') + '\n' +
        String((payload && payload.stack) || '') + '\n\n';
      if (fs.existsSync(file) && fs.statSync(file).size > 512 * 1024) {
        fs.renameSync(file, file + '.old');
      }
      fs.appendFileSync(file, line, 'utf8');
    } catch (e) { /* ignore */ }
    return { ok: true };
  }));
}
