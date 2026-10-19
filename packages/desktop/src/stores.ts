import {
  createIdentity,
  exportIdentity,
  importIdentity,
  type Identity,
} from '@remote-assist/crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { TrustedPeer } from './channels';

/** Encrypts secrets at rest; in the apps this is Electron's `safeStorage` (the macOS Keychain). */
export interface SecretBox {
  encrypt(text: string): Buffer;
  decrypt(data: Buffer): string;
}

/**
 * This device's key pair: created on first launch, then stored encrypted. If it can't be read
 * back (the Keychain entry is gone), a new one is made and the device has to pair again.
 */
export function loadIdentity(path: string, box: SecretBox): Identity {
  if (existsSync(path)) {
    try {
      return importIdentity(box.decrypt(readFileSync(path)));
    } catch (error) {
      console.error('Could not read the device key; making a new one.', error);
    }
  }
  const identity = createIdentity();
  writeAtomically(path, box.encrypt(exportIdentity(identity)));
  return identity;
}

type StoredPeer = Omit<TrustedPeer, 'online'>;

function isStoredPeer(value: unknown): value is StoredPeer {
  if (typeof value !== 'object' || value === null) return false;
  const peer = value as Record<string, unknown>;
  return (
    typeof peer.id === 'string' &&
    /^[A-Za-z0-9_-]{43}$/.test(peer.id) &&
    typeof peer.name === 'string' &&
    peer.name.length > 0 &&
    peer.name.length <= 40 &&
    (peer.role === 'host' || peer.role === 'helper') &&
    Number.isFinite(peer.pairedAt)
  );
}

/**
 * The devices this one paired with: their keys are what every later request and connection is
 * checked against. Kept on this computer; the server only keeps a copy of who is paired.
 */
export class TrustStore {
  private readonly path: string;
  private peers: StoredPeer[];

  constructor(path: string) {
    this.path = path;
    this.peers = this.read();
  }

  list(): StoredPeer[] {
    return [...this.peers];
  }

  get(id: string): StoredPeer | undefined {
    return this.peers.find((peer) => peer.id === id);
  }

  add(peer: StoredPeer): void {
    this.peers = [...this.peers.filter((p) => p.id !== peer.id), peer];
    this.write();
  }

  remove(id: string): boolean {
    const before = this.peers.length;
    this.peers = this.peers.filter((peer) => peer.id !== id);
    this.write();
    return this.peers.length < before;
  }

  rename(id: string, name: string): void {
    this.peers = this.peers.map((peer) => (peer.id === id ? { ...peer, name } : peer));
    this.write();
  }

  private read(): StoredPeer[] {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, 'utf8'));
      return Array.isArray(parsed) ? parsed.filter(isStoredPeer) : [];
    } catch {
      return [];
    }
  }

  private write(): void {
    writeAtomically(this.path, JSON.stringify(this.peers, null, 2));
  }
}

/** Small JSON settings (this device's display name). */
export class Settings {
  private readonly path: string;
  private values: { name?: string };

  constructor(path: string) {
    this.path = path;
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
      this.values =
        typeof parsed === 'object' && parsed !== null ? (parsed as { name?: string }) : {};
    } catch {
      this.values = {};
    }
  }

  get name(): string | undefined {
    return typeof this.values.name === 'string' ? this.values.name : undefined;
  }

  set name(name: string | undefined) {
    this.values = { ...this.values, name };
    writeAtomically(this.path, JSON.stringify(this.values));
  }
}

/** Write a new file, then swap it in, so a crash mid-write can't leave a broken one. */
function writeAtomically(path: string, data: string | Buffer): void {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, data, { mode: 0o600 });
  renameSync(temporary, path);
}
