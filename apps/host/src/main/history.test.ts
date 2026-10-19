import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SessionRecord } from '../shared/api';
import { SessionHistory, isSessionRecord, pruneHistory } from './history';

const DAY = 24 * 60 * 60_000;
const NOW = Date.UTC(2026, 9, 19, 12);

const record = (daysAgo: number, overrides: Partial<SessionRecord> = {}): SessionRecord => ({
  askedAt: NOW - daysAgo * DAY - 60_000,
  endedAt: NOW - daysAgo * DAY,
  helperName: 'Alex',
  wasLive: true,
  outcome: 'stopped',
  ...overrides,
});

describe('session history', () => {
  it('accepts only well-formed records', () => {
    expect(isSessionRecord(record(0))).toBe(true);
    expect(isSessionRecord({ ...record(0), outcome: 'hacked' })).toBe(false);
    expect(isSessionRecord({ ...record(0), helperName: '' })).toBe(false);
    expect(isSessionRecord({ ...record(0), endedAt: Number.NaN })).toBe(false);
    expect(isSessionRecord(null)).toBe(false);
  });

  it('keeps 90 days, newest first', () => {
    const kept = pruneHistory([record(100), record(2), record(0), record(89)], NOW);
    expect(kept.map((r) => Math.round((NOW - r.endedAt) / DAY))).toEqual([0, 2, 89]);
  });

  it('keeps at most 100 entries', () => {
    const many = Array.from({ length: 150 }, (_, i) => record(i / 10));
    expect(pruneHistory(many, NOW)).toHaveLength(100);
  });

  it('stores records in a file and survives a damaged one', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'ra-history-')), 'history.json');
    const history = new SessionHistory(path);
    expect(await history.list()).toEqual([]);

    await history.add(record(0, { endedAt: Date.now(), outcome: 'declined', wasLive: false }));
    expect((await history.list())[0]).toMatchObject({ outcome: 'declined', helperName: 'Alex' });

    await writeFile(path, '{ not json');
    expect(await history.list()).toEqual([]);
  });
});
