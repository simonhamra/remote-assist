import type { IpcRenderer, IpcRendererEvent } from 'electron';
import { PeopleChannels, type PeopleApi, type PeopleState } from './channels';

/** The pairing and people API, the same in both apps' preload scripts. */
export function createPeopleApi(ipc: IpcRenderer): PeopleApi {
  return {
    getPeople: () => ipc.invoke(PeopleChannels.get),
    onPeople: (listener) => {
      const forward = (_event: IpcRendererEvent, state: PeopleState) => listener(state);
      ipc.on(PeopleChannels.state, forward);
      return () => void ipc.removeListener(PeopleChannels.state, forward);
    },
    startPairing: () => ipc.invoke(PeopleChannels.startPairing),
    redeemPairing: (code) => ipc.invoke(PeopleChannels.redeemPairing, code),
    confirmPairing: (match) => ipc.invoke(PeopleChannels.confirmPairing, match),
    cancelPairing: () => ipc.invoke(PeopleChannels.cancelPairing),
    removePeer: (id) => ipc.invoke(PeopleChannels.remove, id),
    renamePeer: (id, name) => ipc.invoke(PeopleChannels.rename, id, name),
    answerApproval: (host, helper, approve) =>
      ipc.invoke(PeopleChannels.answerApproval, host, helper, approve),
    setName: (name) => ipc.invoke(PeopleChannels.setName, name),
  };
}
