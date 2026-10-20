import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { SETUP_STEPS, type SetupState, type SetupStep } from '../shared/api';

export function isSetupStep(value: unknown): value is SetupStep {
  return (SETUP_STEPS as readonly unknown[]).includes(value);
}

/**
 * Where the guided setup got to, so that after a restart (a new Screen Recording permission
 * needs one) it carries on from the same step.
 */
export class SetupStore {
  private readonly path: string;
  private state: SetupState;

  constructor(path: string) {
    this.path = path;
    this.state = { step: 'welcome', completed: false };
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<SetupState>;
      if (isSetupStep(parsed.step)) {
        this.state = { step: parsed.step, completed: parsed.completed === true };
      }
    } catch {
      // First launch: start at the beginning.
    }
  }

  get(): SetupState {
    return { ...this.state };
  }

  setStep(step: SetupStep): void {
    this.state = { ...this.state, step };
    this.write();
  }

  complete(): void {
    this.state = { step: 'done', completed: true };
    this.write();
  }

  private write(): void {
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.state));
    renameSync(temporary, this.path);
  }
}
