import { contextBridge, ipcRenderer } from 'electron';
import { Channels, type HelperApi } from '../shared/api';

const api: HelperApi = {
  getConfig: () => ipcRenderer.invoke(Channels.config),
  copyText: (text) => ipcRenderer.invoke(Channels.copy, text),
  showProbe: () => ipcRenderer.invoke(Channels.showProbe),
  hideProbe: () => ipcRenderer.invoke(Channels.hideProbe),
};

contextBridge.exposeInMainWorld('helperApi', api);
