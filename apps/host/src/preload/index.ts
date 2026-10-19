import { SessionChannels } from '@remote-assist/desktop/channels';
import type { SignalingEvent } from '@remote-assist/protocol';
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { Channels, type HostApi } from '../shared/api';

const api: HostApi = {
  getConfig: () => ipcRenderer.invoke(Channels.config),
  screenPermission: () => ipcRenderer.invoke(Channels.screenPermission),
  openScreenRecordingSettings: () => ipcRenderer.invoke(Channels.openScreenSettings),
  cpuPercent: () => ipcRenderer.invoke(Channels.cpu),
  startSession: () => ipcRenderer.invoke(SessionChannels.host),
  sendSignal: (data) => ipcRenderer.invoke(SessionChannels.signal, data),
  leaveSession: () => ipcRenderer.invoke(SessionChannels.leave),
  onSessionEvent: (listener) => {
    const forward = (_event: IpcRendererEvent, payload: SignalingEvent) => listener(payload);
    ipcRenderer.on(SessionChannels.event, forward);
    return () => void ipcRenderer.removeListener(SessionChannels.event, forward);
  },
  sendInput: (event) => ipcRenderer.send(Channels.input, event),
  setRemoteControl: (enabled, helperMachine) =>
    ipcRenderer.invoke(Channels.setRemoteControl, enabled, helperMachine),
  openAccessibilitySettings: () => ipcRenderer.invoke(Channels.openAccessibilitySettings),
};

contextBridge.exposeInMainWorld('hostApi', api);
