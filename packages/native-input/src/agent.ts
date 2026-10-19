import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';

/** What the agent understands. Positions are screen points in global display coordinates. */
export type AgentCommand =
  | { op: 'move'; x: number; y: number }
  | { op: 'button'; button: 'left' | 'right' | 'middle'; down: boolean; x: number; y: number }
  | { op: 'scroll'; dx: number; dy: number; x: number; y: number }
  | { op: 'key'; id: string; down: boolean; keycode: number; char?: string; repeat?: boolean }
  | { op: 'text'; text: string }
  | { op: 'release' }
  | { op: 'status' };

/** Lines the agent prints: readiness, permission status, errors, and in dry-run the events. */
export type AgentMessage = { event: string } & Record<string, unknown>;

export interface InputAgentOptions {
  /** Print events instead of posting them (tests; needs no Accessibility permission). */
  dryRun?: boolean;
  onMessage?: (message: AgentMessage) => void;
}

/**
 * The macOS input agent as a child process. It starts on the first command and stays up; ending
 * it closes its input, which makes it release every held key and button before exiting.
 */
export class InputAgent {
  private readonly path: string;
  private readonly options: InputAgentOptions;
  private child: ChildProcessWithoutNullStreams | null = null;

  constructor(path: string, options: InputAgentOptions = {}) {
    this.path = path;
    this.options = options;
  }

  get available(): boolean {
    return process.platform === 'darwin' && existsSync(this.path);
  }

  send(command: AgentCommand): void {
    if (!this.available) return;
    const child = this.child ?? this.start();
    child.stdin.write(`${JSON.stringify(command)}\n`);
  }

  stop(): void {
    this.child?.stdin.end();
    this.child = null;
  }

  private start(): ChildProcessWithoutNullStreams {
    const child = spawn(this.path, this.options.dryRun ? ['--dry-run'] : [], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    createInterface({ input: child.stdout }).on('line', (line) => {
      try {
        this.options.onMessage?.(JSON.parse(line) as AgentMessage);
      } catch {
        // Not JSON: ignore.
      }
    });
    child.stderr.on('data', (data: Buffer) => console.error(`input agent: ${String(data).trim()}`));
    child.on('exit', () => {
      if (this.child === child) this.child = null;
    });
    // A closed pipe (the agent exited) must not crash the app.
    child.stdin.on('error', () => {});
    this.child = child;
    return child;
  }
}
