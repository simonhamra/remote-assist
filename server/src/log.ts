export type Log = (event: string, fields?: Record<string, unknown>) => void;

/**
 * One JSON line per event on stdout. Never log IP addresses, session codes or message contents:
 * the server should know as little as possible about who is helping whom.
 */
export const jsonLog: Log = (event, fields = {}) => {
  console.log(JSON.stringify({ time: new Date().toISOString(), event, ...fields }));
};

export const silentLog: Log = () => {};
