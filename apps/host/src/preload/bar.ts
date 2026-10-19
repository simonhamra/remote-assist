import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { Channels, type BarApi, type ChromeState } from '../shared/api';

const api: BarApi = {
  send: (command) => ipcRenderer.send(Channels.barCommand, command),
  onState: (listener) => {
    const forward = (_event: IpcRendererEvent, state: ChromeState) => listener(state);
    ipcRenderer.on(Channels.barState, forward);
    return () => void ipcRenderer.removeListener(Channels.barState, forward);
  },
};

contextBridge.exposeInMainWorld('barApi', api);
