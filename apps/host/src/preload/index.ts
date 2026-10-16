import { contextBridge, ipcRenderer } from 'electron';
import { Channels, type HostApi } from '../shared/api';

const api: HostApi = {
  getConfig: () => ipcRenderer.invoke(Channels.config),
  copyText: (text) => ipcRenderer.invoke(Channels.copy, text),
  screenPermission: () => ipcRenderer.invoke(Channels.screenPermission),
  openScreenRecordingSettings: () => ipcRenderer.invoke(Channels.openScreenSettings),
  cpuPercent: () => ipcRenderer.invoke(Channels.cpu),
};

contextBridge.exposeInMainWorld('hostApi', api);
