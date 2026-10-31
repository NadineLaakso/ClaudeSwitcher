const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('switchly', {
  getState: () => ipcRenderer.invoke('get-state'),
  saveInstances: (instances) => ipcRenderer.invoke('save-instances', instances),
  launch: (id) => ipcRenderer.invoke('launch', id),
  loginBegin: (id) => ipcRenderer.invoke('login-begin', id),
  loginFinish: (id) => ipcRenderer.invoke('login-finish', id),
  loginCancel: (id) => ipcRenderer.invoke('login-cancel', id),
  stop: (id) => ipcRenderer.invoke('stop', id),
  newInstance: () => ipcRenderer.invoke('new-instance'),
  deleteInstance: (id) => ipcRenderer.invoke('delete-instance', id),
  accountConflict: (payload) => ipcRenderer.invoke('account-conflict', payload),
  openProfileFolder: (id) => ipcRenderer.invoke('open-profile-folder', id),
  onStatus: (cb) => ipcRenderer.on('instance-status', (_e, payload) => cb(payload)),
  onOpenLogin: (cb) => ipcRenderer.on('open-login', (_e, id) => cb(id))
});
