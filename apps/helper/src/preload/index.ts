import { SessionChannels } from '@remote-assist/desktop/channels';
import type { SignalingEvent } from '@remote-assist/protocol';
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { Channels, type HelperApi } from '../shared/api';

const api: HelperApi = {
  getConfig: () => ipcRenderer.invoke(Channels.config),
  showProbe: () => ipcRenderer.invoke(Channels.showProbe),
  hideProbe: () => ipcRenderer.invoke(Channels.hideProbe),
  joinSession: (code) => ipcRenderer.invoke(SessionChannels.join, code),
  sendSignal: (data) => ipcRenderer.invoke(SessionChannels.signal, data),
  leaveSession: () => ipcRenderer.invoke(SessionChannels.leave),
  onSessionEvent: (listener) => {
    const forward = (_event: IpcRendererEvent, payload: SignalingEvent) => listener(payload);
    ipcRenderer.on(SessionChannels.event, forward);
    return () => void ipcRenderer.removeListener(SessionChannels.event, forward);
  },
};

contextBridge.exposeInMainWorld('helperApi', api);
