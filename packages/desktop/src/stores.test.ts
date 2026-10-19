import { createIdentity } from '@remote-assist/crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Settings, TrustStore, loadIdentity, type SecretBox } from './stores';

/** A stand-in for the Keychain: reversible, and visibly not plain text. */
const box: SecretBox = {
  encrypt: (text) => Buffer.from(text).reverse(),
  decrypt: (data) => Buffer.from(data).reverse().toString(),
};

const folder = () => mkdtempSync(join(tmpdir(), 'ra-desktop-'));

describe('loadIdentity', () => {
  it('creates a key once, stores it encrypted, and loads the same one again', () => {
    const path = join(folder(), 'identity.bin');
    const first = loadIdentity(path, box);
    expect(readFileSync(path, 'utf8')).not.toContain('PRIVATE KEY');
    expect(loadIdentity(path, box).id).toBe(first.id);
  });

  it('makes a new key if the stored one cannot be read', () => {
    const path = join(folder(), 'identity.bin');
    const first = loadIdentity(path, box);
    writeFileSync(path, 'garbage');
    expect(loadIdentity(path, box).id).not.toBe(first.id);
  });
});

describe('TrustStore', () => {
  it('pins, renames and forgets peers, and survives a restart', () => {
    const path = join(folder(), 'trusted.json');
    const store = new TrustStore(path);
    const id = createIdentity().id;
    store.add({ id, name: 'Alex', role: 'helper', pairedAt: 1 });
    store.rename(id, 'Alex (grandson)');
    expect(new TrustStore(path).get(id)?.name).toBe('Alex (grandson)');
    expect(store.remove(id)).toBe(true);
    expect(new TrustStore(path).list()).toEqual([]);
  });

  it('ignores entries that are not valid', () => {
    const path = join(folder(), 'trusted.json');
    writeFileSync(path, JSON.stringify([{ id: 'short', name: 'x', role: 'host', pairedAt: 1 }]));
    expect(new TrustStore(path).list()).toEqual([]);
  });
});

describe('Settings', () => {
  it('remembers the name', () => {
    const path = join(folder(), 'settings.json');
    new Settings(path).name = 'Alex';
    expect(new Settings(path).name).toBe('Alex');
  });
});
