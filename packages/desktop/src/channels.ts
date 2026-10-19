/**
 * IPC between each app's main process and its window: channel names and the shapes that cross.
 * Safe to import from sandboxed preload scripts (no runtime dependencies).
 */
import type { SignalingEvent } from '@remote-assist/protocol';

export const SessionChannels = {
  /** Host: start a one-time code session (development and tests). */
  host: 'session:host',
  /** Helper: join a one-time code session. */
  join: 'session:join',
  /** Helper: ask to help a paired host. */
  request: 'session:request',
  signal: 'session:signal',
  leave: 'session:leave',
  /** Main → window: a `SessionEvent`. */
  event: 'session:event',
} as const;

export const PeopleChannels = {
  get: 'people:get',
  /** Main → window: the whole `PeopleState` whenever it changes. */
  state: 'people:state',
  startPairing: 'people:pair-start',
  redeemPairing: 'people:pair-redeem',
  confirmPairing: 'people:pair-confirm',
  cancelPairing: 'people:pair-cancel',
  remove: 'people:remove',
  rename: 'people:rename',
  answerApproval: 'people:approve',
  setName: 'people:set-name',
} as const;

/**
 * What the window hears about a session: the server's messages, plus what the main process
 * concluded. `verified`: the request came from this pinned device. `tampered`: something was
 * altered on the way, so the session was stopped.
 */
export type SessionEvent =
  | SignalingEvent
  | { t: 'verified'; peer: { id: string; name: string } }
  | { t: 'tampered'; message: string };

export interface TrustedPeer {
  id: string;
  name: string;
  role: 'host' | 'helper';
  pairedAt: number;
  online: boolean;
}

export type PairingState =
  | { step: 'idle' }
  /** Host: waiting for the helper to type this code. */
  | { step: 'code'; code: string; needsApproval: boolean }
  /** Helper: code sent, waiting for the server. */
  | { step: 'redeeming' }
  /** Someone is already paired with this computer and must approve the new helper. */
  | { step: 'waiting-approval' }
  /** Both people compare these words. */
  | { step: 'confirm'; peer: { id: string; name: string }; words: string[] }
  /** This side confirmed; waiting for the other person. */
  | { step: 'confirmed'; peer: { id: string; name: string } }
  | { step: 'done'; peer: TrustedPeer }
  | { step: 'failed'; message: string };

/** On a helper: someone new wants to pair with a computer this helper is paired with. */
export interface ApprovalRequest {
  host: string;
  hostName: string;
  helper: { id: string; name: string };
}

export interface PeopleState {
  /** This device's ID (its public key). */
  device: string;
  name: string;
  /** Whether the person chose the name (otherwise it's a default). */
  named: boolean;
  connection: 'connecting' | 'online' | 'offline';
  peers: TrustedPeer[];
  pairing: PairingState;
  approvals: ApprovalRequest[];
}

/** Exposed to both apps' windows (as part of `hostApi` / `helperApi`). */
export interface PeopleApi {
  getPeople(): Promise<PeopleState>;
  /** Returns a function that stops listening. */
  onPeople(listener: (state: PeopleState) => void): () => void;
  /** Host: show a pairing code. */
  startPairing(): Promise<void>;
  /** Helper: pair with the code the host shows. */
  redeemPairing(code: string): Promise<void>;
  /** After comparing the three words. */
  confirmPairing(match: boolean): Promise<void>;
  cancelPairing(): Promise<void>;
  removePeer(id: string): Promise<void>;
  renamePeer(id: string, name: string): Promise<void>;
  /** Helper: approve or refuse someone new pairing with a computer you help. */
  answerApproval(host: string, helper: string, approve: boolean): Promise<void>;
  /** The name others see during pairing and on the consent screen. */
  setName(name: string): Promise<void>;
}
