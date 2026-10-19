import { SessionChannels, type SessionEvent } from '@remote-assist/desktop/channels';
import { createPeopleApi } from '@remote-assist/desktop/preload';
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { Channels, type HostApi, type SessionCommand } from '../shared/api';

const api: HostApi = {
  ...createPeopleApi(ipcRenderer),
  getConfig: () => ipcRenderer.invoke(Channels.config),
  screenPermission: () => ipcRenderer.invoke(Channels.screenPermission),
  openScreenRecordingSettings: () => ipcRenderer.invoke(Channels.openScreenSettings),
  cpuPercent: () => ipcRenderer.invoke(Channels.cpu),
  startSession: () => ipcRenderer.invoke(SessionChannels.host),
  sendSignal: (data) => ipcRenderer.invoke(SessionChannels.signal, data),
  leaveSession: () => ipcRenderer.invoke(SessionChannels.leave),
  onSessionEvent: (listener) => {
    const forward = (_event: IpcRendererEvent, payload: SessionEvent) => listener(payload);
    ipcRenderer.on(SessionChannels.event, forward);
    return () => void ipcRenderer.removeListener(SessionChannels.event, forward);
  },
  sendInput: (event) => ipcRenderer.send(Channels.input, event),
  setRemoteControl: (enabled, helperMachine) =>
    ipcRenderer.invoke(Channels.setRemoteControl, enabled, helperMachine),
  openAccessibilitySettings: () => ipcRenderer.invoke(Channels.openAccessibilitySettings),
  requestAttention: (asking) => ipcRenderer.invoke(Channels.attention, asking),
  setSessionChrome: (state) => ipcRenderer.invoke(Channels.sessionChrome, state),
  onSessionCommand: (listener) => {
    const forward = (_event: IpcRendererEvent, command: SessionCommand) => listener(command);
    ipcRenderer.on(Channels.sessionCommand, forward);
    return () => void ipcRenderer.removeListener(Channels.sessionCommand, forward);
  },
  recordSession: (record) => ipcRenderer.invoke(Channels.recordSession, record),
  sessionHistory: () => ipcRenderer.invoke(Channels.history),
  setupState: () => ipcRenderer.invoke(Channels.setupState),
  setSetupStep: (step) => ipcRenderer.invoke(Channels.setSetupStep, step),
  completeSetup: () => ipcRenderer.invoke(Channels.completeSetup),
  registerScreenRecording: () => ipcRenderer.invoke(Channels.registerScreenRecording),
  accessibilityGranted: () => ipcRenderer.invoke(Channels.accessibilityGranted),
  startAtLogin: () => ipcRenderer.invoke(Channels.startAtLogin),
  setStartAtLogin: (enabled) => ipcRenderer.invoke(Channels.setStartAtLogin, enabled),
  relaunch: () => ipcRenderer.invoke(Channels.relaunch),
};

contextBridge.exposeInMainWorld('hostApi', api);
