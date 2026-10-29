'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  init: () => ipcRenderer.invoke('app:init'),
  saveLeaves: (records) => ipcRenderer.invoke('leaves:save', records),
  nextNo: (dateStr) => ipcRenderer.invoke('leaves:nextNo', dateStr),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  exportExcel: (payload) => ipcRenderer.invoke('export:excel', payload),
  openDataFolder: () => ipcRenderer.invoke('data:openFolder'),
  openBackupFolder: () => ipcRenderer.invoke('data:openBackupFolder'),
  listBackups: () => ipcRenderer.invoke('backups:list'),
  createBackup: () => ipcRenderer.invoke('backups:create'),
  pruneBackups: () => ipcRenderer.invoke('backups:prune'),
  stats: () => ipcRenderer.invoke('data:stats'),
  restoreBackup: (name) => ipcRenderer.invoke('backups:restore', name),
  logError: (payload) => ipcRenderer.invoke('log:error', payload)
});
