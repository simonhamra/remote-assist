import type {
  ClientMessage,
  DeviceRole,
  ErrorReason,
  ServerMessage,
} from '@remote-assist/protocol';
import { randomInt } from 'node:crypto';
import type { Log } from './log.ts';
import { RateLimiter } from './rateLimit.ts';
import type { PairingStore } from './store.ts';

/** A signed-in connection, as pairing sees it. */
export interface Device {
  readonly ip: string;
  readonly id: string;
  readonly role: DeviceRole;
  readonly name: string;
  send(message: ServerMessage): void;
}

interface Pending {
  readonly code: string;
  readonly host: Device;
  helper: Device | null;
  readonly needsApproval: boolean;
  matched: boolean;
  readonly confirmed: Set<string>;
  readonly expiry: ReturnType<typeof setTimeout>;
}

export interface PairingOptions {
  store: PairingStore;
  /** The signed-in connection of a device, if it is online. */
  online(id: string): Device | undefined;
  codeTtlMs: number;
  log: Log;
}

type PairingMessage = Extract<ClientMessage, { t: `pair.${string}` }>;

const WINDOW_MS = 10 * 60 * 1000;

/**
 * Pairing: the host shows a code, the helper types it, both people compare three words that
 * each device derives from the two keys and the code, and each confirms. Once a host has a
 * helper, anyone new must also be approved by one of its existing helpers, who are told about
 * every attempt. Codes are single use and expire.
 */
export class Pairing {
  private readonly options: PairingOptions;
  private readonly byCode = new Map<string, Pending>();
  private readonly byDevice = new Map<Device, Pending>();
  private readonly opens = new RateLimiter(20, WINDOW_MS);
  private readonly redeems = new RateLimiter(20, WINDOW_MS);

  constructor(options: PairingOptions) {
    this.options = options;
  }

  handle(device: Device, message: PairingMessage): void {
    switch (message.t) {
      case 'pair.open':
        return this.open(device);
      case 'pair.redeem':
        return this.redeem(device, message.code);
      case 'pair.confirm':
        return this.confirm(device, message.peer);
      case 'pair.cancel':
        return this.cancel(device, 'The other person cancelled the pairing.');
      case 'pair.approve':
        return this.approve(device, message.host, message.helper, message.approve);
      case 'pair.remove':
        return this.remove(device, message.peer);
    }
  }

  disconnect(device: Device): void {
    this.cancel(device, 'The other device went offline during pairing.');
  }

  prune(nowMs = Date.now()): void {
    this.opens.prune(nowMs);
    this.redeems.prune(nowMs);
  }

  closeAll(): void {
    for (const pending of new Set(this.byDevice.values())) this.close(pending);
  }

  private open(host: Device): void {
    if (host.role !== 'host')
      return fail(host, 'bad-message', 'Only the computer being helped shows a pairing code.');
    if (!this.opens.take(host.ip))
      return fail(host, 'rate-limited', 'Too many attempts. Wait a few minutes.');
    const previous = this.byDevice.get(host);
    if (previous) this.close(previous);

    const code = this.newCode();
    const pending: Pending = {
      code,
      host,
      helper: null,
      needsApproval: this.options.store.helpersOf(host.id).length > 0,
      matched: false,
      confirmed: new Set(),
      expiry: setTimeout(() => {
        this.close(pending);
        fail(host, 'code-expired', 'The pairing code expired. Start again for a new one.');
      }, this.options.codeTtlMs),
    };
    this.byCode.set(code, pending);
    this.byDevice.set(host, pending);
    host.send({
      t: 'pair.code',
      code,
      expiresAt: Date.now() + this.options.codeTtlMs,
      needsApproval: pending.needsApproval,
    });
    this.options.log('pairing.opened', { approval: pending.needsApproval });
  }

  private redeem(helper: Device, code: string): void {
    if (helper.role !== 'helper')
      return fail(helper, 'bad-message', 'Only a helper can enter a pairing code.');
    if (!this.redeems.take(helper.ip))
      return fail(helper, 'rate-limited', 'Too many attempts. Wait a few minutes.');
    const pending = this.byCode.get(code);
    if (!pending) {
      return fail(
        helper,
        'invalid-code',
        'That code does not work. Check the numbers, or ask for a new code.',
      );
    }
    // Single use: nobody else can try this code now.
    this.byCode.delete(code);
    pending.helper = helper;
    this.byDevice.set(helper, pending);

    if (!pending.needsApproval) return this.match(pending);
    // Existing helpers hear about every attempt, and one of them must approve it.
    const message: ServerMessage = {
      t: 'pair.approval',
      host: pending.host.id,
      helper: { id: helper.id, name: helper.name },
    };
    for (const id of this.options.store.helpersOf(pending.host.id)) {
      this.options.online(id)?.send(message);
    }
    pending.host.send({ t: 'pair.pending' });
    helper.send({ t: 'pair.pending' });
  }

  private approve(approver: Device, hostId: string, helperId: string, approve: boolean): void {
    if (!this.options.store.has(hostId, approver.id)) {
      return fail(
        approver,
        'not-paired',
        'Only someone already paired with this computer can approve.',
      );
    }
    const pending = [...this.byDevice.values()].find(
      (p) => p.host.id === hostId && p.helper?.id === helperId && p.needsApproval && !p.matched,
    );
    if (!pending) return;
    if (approve) return this.match(pending);
    const reason = 'Another helper of this person did not approve the pairing.';
    if (pending.helper) fail(pending.helper, 'not-approved', reason);
    fail(pending.host, 'not-approved', reason);
    this.close(pending);
  }

  private match(pending: Pending): void {
    const { host, helper } = pending;
    if (!helper) return;
    pending.matched = true;
    host.send({ t: 'pair.matched', peer: { id: helper.id, name: helper.name, role: 'helper' } });
    helper.send({ t: 'pair.matched', peer: { id: host.id, name: host.name, role: 'host' } });
  }

  private confirm(device: Device, peerId: string): void {
    const pending = this.byDevice.get(device);
    if (!pending?.matched || !pending.helper) return;
    const other = device === pending.host ? pending.helper : pending.host;
    if (other.id !== peerId) return;
    pending.confirmed.add(device.id);
    if (pending.confirmed.size < 2) return;

    this.options.store.add(pending.host.id, pending.helper.id);
    pending.host.send({ t: 'pair.done', peer: pending.helper.id });
    pending.helper.send({ t: 'pair.done', peer: pending.host.id });
    pending.host.send({ t: 'presence', peer: pending.helper.id, online: true });
    pending.helper.send({ t: 'presence', peer: pending.host.id, online: true });
    this.close(pending);
    this.options.log('pairing.done');
  }

  private cancel(device: Device, message: string): void {
    const pending = this.byDevice.get(device);
    if (!pending) return;
    for (const other of [pending.host, pending.helper]) {
      if (other && other !== device) fail(other, 'pairing-cancelled', message);
    }
    this.close(pending);
  }

  private remove(device: Device, peerId: string): void {
    if (this.options.store.remove(device.id, peerId)) {
      this.options.online(peerId)?.send({ t: 'pair.removed', peer: device.id });
      this.options.log('pairing.removed');
    }
    device.send({ t: 'pair.removed', peer: peerId });
  }

  private close(pending: Pending): void {
    clearTimeout(pending.expiry);
    this.byCode.delete(pending.code);
    this.byDevice.delete(pending.host);
    if (pending.helper) this.byDevice.delete(pending.helper);
  }

  private newCode(): string {
    for (;;) {
      const code = String(randomInt(0, 100_000_000)).padStart(8, '0');
      if (!this.byCode.has(code)) return code;
    }
  }
}

function fail(device: Device, reason: ErrorReason, message: string): void {
  device.send({ t: 'error', reason, message });
}
