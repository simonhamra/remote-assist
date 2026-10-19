export interface TurnConfig {
  /** Shared with coturn (`static-auth-secret`), used to mint short-lived credentials. */
  secret: string;
  urls: string[];
  ttlSeconds: number;
}

export interface ServerConfig {
  host: string;
  port: number;
  codeTtlMs: number;
  stunUrls: string[];
  turn: TurnConfig | null;
  /** Behind Caddy: take the client address from the last X-Forwarded-For entry. */
  trustProxy: boolean;
  /** Browser origins allowed to connect. The apps connect from Node and send no Origin. */
  allowedOrigins: string[];
  maxRooms: number;
  /** SQLite file for pairings; `:memory:` (the default) forgets them on restart. */
  databasePath: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const turnUrls = list(env.TURN_URLS);
  const secret = env.TURN_SECRET ?? '';
  if (turnUrls.length > 0 && secret.length < 32) {
    throw new Error('TURN_URLS is set, so TURN_SECRET must be at least 32 characters.');
  }
  return {
    host: env.HOST ?? '127.0.0.1',
    port: integer(env.PORT, 8787, 'PORT'),
    codeTtlMs: integer(env.CODE_TTL_SECONDS, 600, 'CODE_TTL_SECONDS') * 1000,
    stunUrls: list(env.STUN_URLS),
    turn:
      turnUrls.length > 0
        ? {
            secret,
            urls: turnUrls,
            ttlSeconds: integer(env.TURN_TTL_SECONDS, 4 * 60 * 60, 'TURN_TTL_SECONDS'),
          }
        : null,
    trustProxy: env.TRUST_PROXY === '1',
    allowedOrigins: list(env.ALLOWED_ORIGINS),
    maxRooms: integer(env.MAX_ROOMS, 500, 'MAX_ROOMS'),
    databasePath: env.DATABASE_PATH || ':memory:',
  };
}

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function integer(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} must be a whole number.`);
  return parsed;
}
