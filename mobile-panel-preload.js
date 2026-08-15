'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('panel', {
  get: () => ipcRenderer.invoke('mobile:get'),
  setEnabled: (v) => ipcRenderer.invoke('mobile:set-enabled', v),
  setMode: (m) => ipcRenderer.invoke('mobile:set-mode', m),
  pairStart: () => ipcRenderer.invoke('mobile:pair-start'),
  pairCancel: () => ipcRenderer.invoke('mobile:pair-cancel'),
  setActiveDevice: (id) => ipcRenderer.invoke('mobile:set-active-device', id),
  removeDevice: (id) => ipcRenderer.invoke('mobile:remove-device', id),
  regenerate: () => ipcRenderer.invoke('mobile:regenerate'),
  setPort: (p) => ipcRenderer.invoke('mobile:set-port', p),
  tunnelSet: (on) => ipcRenderer.invoke('mobile:tunnel-set', on),
  tunnelStatus: () => ipcRenderer.invoke('mobile:tunnel-status'),
  openUrl: (u) => ipcRenderer.invoke('mobile:open-url', u),
  firewall: () => ipcRenderer.invoke('mobile:firewall'),
  copy: (t) => ipcRenderer.invoke('mobile:copy', t),
  close: () => ipcRenderer.invoke('mobile:close-panel'),
  onTunnelUpdated: (cb) => {
    ipcRenderer.on('tunnel-updated', (_e, url) => cb && cb(url));
  },
});
