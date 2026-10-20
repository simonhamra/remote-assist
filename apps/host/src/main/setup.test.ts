import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SetupStore } from './setup';

const file = () => join(mkdtempSync(join(tmpdir(), 'ra-setup-')), 'setup.json');

describe('SetupStore', () => {
  it('starts at the welcome step and remembers progress across restarts', () => {
    const path = file();
    const store = new SetupStore(path);
    expect(store.get()).toEqual({ step: 'welcome', completed: false });
    store.setStep('screen');
    expect(new SetupStore(path).get()).toEqual({ step: 'screen', completed: false });
    store.complete();
    expect(new SetupStore(path).get()).toEqual({ step: 'done', completed: true });
  });

  it('starts over when the file is damaged or names an unknown step', () => {
    const path = file();
    writeFileSync(path, JSON.stringify({ step: 'hack', completed: true }));
    expect(new SetupStore(path).get()).toEqual({ step: 'welcome', completed: false });
  });
});
