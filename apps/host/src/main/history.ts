import { readFile, rename, writeFile } from 'node:fs/promises';
import { SESSION_OUTCOMES, type SessionRecord } from '../shared/api';

const KEEP_DAYS = 90;
const KEEP_MOST = 100;

export function isSessionRecord(value: unknown): value is SessionRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    Number.isFinite(record.askedAt) &&
    Number.isFinite(record.endedAt) &&
    typeof record.helperName === 'string' &&
    record.helperName.length > 0 &&
    record.helperName.length <= 40 &&
    typeof record.wasLive === 'boolean' &&
    (SESSION_OUTCOMES as readonly unknown[]).includes(record.outcome)
  );
}

/** Newest first, nothing older than 90 days, at most 100 entries. */
export function pruneHistory(records: SessionRecord[], nowMs: number): SessionRecord[] {
  const cutoff = nowMs - KEEP_DAYS * 24 * 60 * 60_000;
  return records
    .filter((record) => record.endedAt >= cutoff)
    .sort((a, b) => b.endedAt - a.endedAt)
    .slice(0, KEEP_MOST);
}

/**
 * Who asked to help and how it ended, kept only on this computer so Grandma (and you, when
 * you look) can see every session and every request, including the refused ones.
 */
export class SessionHistory {
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async list(nowMs = Date.now()): Promise<SessionRecord[]> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, 'utf8'));
      return Array.isArray(parsed) ? pruneHistory(parsed.filter(isSessionRecord), nowMs) : [];
    } catch {
      return [];
    }
  }

  async add(record: SessionRecord): Promise<void> {
    const records = pruneHistory([record, ...(await this.list())], Date.now());
    // Write a new file, then swap it in: a crash mid-write can't corrupt the history.
    const temporary = `${this.path}.tmp`;
    await writeFile(temporary, JSON.stringify(records));
    await rename(temporary, this.path);
  }
}
