import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { describe, expect, it } from 'vitest';
import type { AgentCommand, AgentMessage } from './agent.ts';

const binary = join(import.meta.dirname, '..', 'bin', 'input-agent');
// Built by `npm run build` on macOS. Elsewhere, or before a build, these tests are skipped.
const onMac = process.platform === 'darwin' && existsSync(binary) ? describe : describe.skip;

/** Runs commands through the agent in dry-run mode and returns the events it would post. */
async function dryRun(commands: AgentCommand[]): Promise<AgentMessage[]> {
  const child = spawn(binary, ['--dry-run']);
  const posted: AgentMessage[] = [];
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line) as AgentMessage;
    if (message.event === 'posted') posted.push(message);
  });
  for (const command of commands) child.stdin.write(`${JSON.stringify(command)}\n`);
  child.stdin.end();
  await new Promise((resolve) => child.on('close', resolve));
  return posted;
}

const COMMAND = 0x100000;

onMac('macOS input agent', () => {
  it('turns moves into drags while a button is held', async () => {
    const events = await dryRun([
      { op: 'move', x: 10, y: 10 },
      { op: 'button', button: 'left', down: true, x: 10, y: 10 },
      { op: 'move', x: 50, y: 40 },
      { op: 'button', button: 'left', down: false, x: 50, y: 40 },
    ]);
    expect(events.map((e) => e.type)).toEqual([
      'mouseMoved',
      'leftMouseDown',
      'leftMouseDragged',
      'leftMouseUp',
    ]);
  });

  it('counts double-clicks, which synthetic events do not do by themselves', async () => {
    const click = (down: boolean): AgentCommand => ({
      op: 'button',
      button: 'left',
      down,
      x: 5,
      y: 5,
    });
    const events = await dryRun([click(true), click(false), click(true), click(false)]);
    expect(events.filter((e) => e.type !== 'mouseMoved').map((e) => e.clickState)).toEqual([
      1, 1, 2, 2,
    ]);
  });

  it('holds modifiers across a shortcut and finds the key by character', async () => {
    const events = await dryRun([
      { op: 'key', id: 'MetaLeft', down: true, keycode: 0x37 },
      // A deliberately wrong fallback key code: the layout lookup for "c" must win.
      { op: 'key', id: 'KeyC', down: true, keycode: 99, char: 'c' },
      { op: 'key', id: 'KeyC', down: false, keycode: 99 },
      { op: 'key', id: 'MetaLeft', down: false, keycode: 0x37 },
    ]);
    expect(events.map((e) => [e.type, e.flags])).toEqual([
      ['flagsChanged', COMMAND],
      ['keyDown', COMMAND],
      ['keyUp', COMMAND],
      ['flagsChanged', 0],
    ]);
    expect(events[1]?.keycode).not.toBe(99);
    expect(events[2]?.keycode).toBe(events[1]?.keycode);
  });

  it('types text as characters with no modifiers', async () => {
    const events = await dryRun([
      { op: 'key', id: 'ShiftLeft', down: true, keycode: 0x38 },
      { op: 'text', text: 'Crème' },
    ]);
    const typed = events.filter((e) => e.type === 'keyDown' && 'text' in e);
    expect(typed.map((e) => e.text).join('')).toBe('Crème');
    expect(typed.every((e) => e.flags === 0)).toBe(true);
  });

  it('scrolls in the direction the helper scrolled', async () => {
    const [, scroll] = await dryRun([{ op: 'scroll', dx: 0, dy: 30, x: 1, y: 1 }]);
    expect(scroll).toMatchObject({ type: 'scrollWheel', wheel1: -30, wheel2: 0 });
  });

  it('releases held keys and buttons when its input closes', async () => {
    const events = await dryRun([
      { op: 'button', button: 'left', down: true, x: 1, y: 1 },
      { op: 'key', id: 'ShiftLeft', down: true, keycode: 0x38 },
      { op: 'key', id: 'KeyA', down: true, keycode: 0 },
    ]);
    expect(events.slice(-3).map((e) => e.type)).toEqual(['keyUp', 'flagsChanged', 'leftMouseUp']);
  });

  it('ignores a release for something that was never pressed', async () => {
    const events = await dryRun([
      { op: 'key', id: 'KeyA', down: false, keycode: 0 },
      { op: 'button', button: 'right', down: false, x: 3, y: 3 },
    ]);
    expect(events.filter((e) => e.type !== 'mouseMoved')).toEqual([]);
  });
});
