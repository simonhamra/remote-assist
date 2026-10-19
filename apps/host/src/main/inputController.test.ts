import type { AgentCommand } from '@remote-assist/native-input';
import { describe, expect, it } from 'vitest';
import { InputController, type InputControllerDeps } from './inputController';
import { macKeyCode } from './keymap';

function setup(overrides: Partial<InputControllerDeps> = {}) {
  const sent: AgentCommand[] = [];
  let now = 0;
  const controller = new InputController({
    send: (command) => sent.push(command),
    display: () => ({ x: 0, y: 0, width: 1440, height: 900 }),
    ownWindows: () => [{ x: 450, y: 40, width: 540, height: 820 }],
    ownWindowFocused: () => false,
    now: () => now,
    ...overrides,
  });
  controller.setEnabled(true);
  return { controller, sent, advance: (ms: number) => (now += ms) };
}

describe('InputController', () => {
  it('maps the normalized position onto the shared display', () => {
    const { controller, sent } = setup({
      display: () => ({ x: -1440, y: 0, width: 1440, height: 900 }),
    });
    controller.handle({ t: 'move', x: 32_768, y: 0 });
    controller.handle({ t: 'move', x: 65_535, y: 65_535 });
    const [middle, corner] = sent as Extract<AgentCommand, { op: 'move' }>[];
    expect(middle?.x).toBeCloseTo(-720, 1);
    expect(middle?.y).toBe(0);
    // The far edge stays on the display (the last pixel), not one past it.
    expect(corner).toEqual({ op: 'move', x: -1, y: 899 });
  });

  it('drops everything while control is off, and releases when it is turned off', () => {
    const { controller, sent } = setup();
    controller.setEnabled(false);
    expect(sent).toEqual([{ op: 'release' }]);
    expect(controller.handle({ t: 'text', text: 'hi' })).toBe('disabled');
    expect(sent).toHaveLength(1);
  });

  it("never clicks or scrolls on the host app's own windows", () => {
    const { controller, sent } = setup();
    const overStopButton = {
      x: Math.round((700 / 1440) * 65_535),
      y: Math.round((500 / 900) * 65_535),
    };
    expect(controller.handle({ t: 'button', button: 'left', down: true, ...overStopButton })).toBe(
      'own-window',
    );
    expect(controller.handle({ t: 'wheel', dx: 0, dy: 10, ...overStopButton })).toBe('own-window');
    // Letting go of a button is always allowed.
    expect(controller.handle({ t: 'button', button: 'left', down: false, ...overStopButton })).toBe(
      'sent',
    );
    expect(sent.map((c) => c.op)).toEqual(['button']);
  });

  it('does not type into the host app while it has focus, but still lets keys go', () => {
    const { controller, sent } = setup({ ownWindowFocused: () => true });
    expect(controller.handle({ t: 'text', text: 'yes' })).toBe('own-window');
    expect(controller.handle({ t: 'key', code: 'Enter', down: true })).toBe('own-window');
    expect(controller.handle({ t: 'key', code: 'Enter', down: false })).toBe('sent');
    expect(sent).toEqual([{ op: 'key', id: 'Enter', down: false, keycode: 0x24 }]);
  });

  it('passes shortcut characters and repeats through', () => {
    const { controller, sent } = setup();
    controller.handle({ t: 'key', code: 'KeyQ', down: true, char: 'a', repeat: true });
    expect(sent).toEqual([
      { op: 'key', id: 'KeyQ', down: true, keycode: 0x0c, char: 'a', repeat: true },
    ]);
  });

  it('refuses keys outside the table', () => {
    const { controller } = setup();
    expect(controller.handle({ t: 'key', code: 'Power', down: true })).toBe('unknown-key');
    expect(macKeyCode('constructor')).toBeUndefined();
  });

  it('rate-limits floods but always allows release', () => {
    const { controller, sent, advance } = setup();
    for (let i = 0; i < 450; i++) controller.handle({ t: 'move', x: i, y: i });
    expect(sent).toHaveLength(400);
    expect(controller.handle({ t: 'release' })).toBe('sent');
    advance(1000);
    expect(controller.handle({ t: 'move', x: 1, y: 1 })).toBe('sent');
  });
});
