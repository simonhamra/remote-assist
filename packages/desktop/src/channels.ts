/** IPC channels for the signaling session. Safe to import from sandboxed preload scripts. */
export const SessionChannels = {
  host: 'session:host',
  join: 'session:join',
  signal: 'session:signal',
  leave: 'session:leave',
  /** Main → renderer: a `SignalingEvent`. */
  event: 'session:event',
} as const;
