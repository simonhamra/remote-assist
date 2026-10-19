import { DatabaseSync } from 'node:sqlite';

/**
 * Which host is paired with which helper: two public keys and a date, nothing else. Names,
 * addresses and session contents are never stored. (Each device also pins its peers itself;
 * this copy lets the server route requests and refuse unpaired ones.)
 */
export class PairingStore {
  private readonly db: DatabaseSync;

  /** `:memory:` keeps nothing between restarts (development and tests). */
  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pairings (
        host TEXT NOT NULL,
        helper TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (host, helper)
      )
    `);
  }

  add(host: string, helper: string): void {
    this.db
      .prepare('INSERT OR IGNORE INTO pairings (host, helper, created_at) VALUES (?, ?, ?)')
      .run(host, helper, Date.now());
  }

  /** Removes the pairing between two devices, whichever is the host. */
  remove(a: string, b: string): boolean {
    const result = this.db
      .prepare('DELETE FROM pairings WHERE (host = ? AND helper = ?) OR (host = ? AND helper = ?)')
      .run(a, b, b, a);
    return Number(result.changes) > 0;
  }

  has(host: string, helper: string): boolean {
    return (
      this.db.prepare('SELECT 1 FROM pairings WHERE host = ? AND helper = ?').get(host, helper) !==
      undefined
    );
  }

  helpersOf(host: string): string[] {
    return this.db
      .prepare('SELECT helper FROM pairings WHERE host = ? ORDER BY created_at')
      .all(host)
      .map((row) => String(row.helper));
  }

  /** Every device paired with this one, in either role. */
  peersOf(device: string): string[] {
    return this.db
      .prepare(
        'SELECT helper AS peer FROM pairings WHERE host = ? UNION SELECT host AS peer FROM pairings WHERE helper = ?',
      )
      .all(device, device)
      .map((row) => String(row.peer));
  }

  close(): void {
    this.db.close();
  }
}
