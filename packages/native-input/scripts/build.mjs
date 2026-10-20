// Builds the macOS input agent with swiftc, which comes with Xcode's Command Line Tools. The
// result is universal (Apple silicon and Intel), like the packaged apps.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

if (process.platform !== 'darwin') {
  console.log('input agent: skipped (only macOS is supported so far)');
  process.exit(0);
}

const source = join(root, 'macos', 'InputAgent.swift');
const binary = join(root, 'bin', 'input-agent');
// `npm run dev:host` builds it every time; skip when nothing changed (--force builds anyway).
if (
  !process.argv.includes('--force') &&
  existsSync(binary) &&
  statSync(binary).mtimeMs > statSync(source).mtimeMs
) {
  console.log('input agent: up to date');
  process.exit(0);
}

const work = mkdtempSync(join(tmpdir(), 'input-agent-'));
try {
  const slices = ['arm64', 'x86_64'].map((arch) => {
    const output = join(work, arch);
    execFileSync('swiftc', ['-O', '-target', `${arch}-apple-macos13`, '-o', output, source], {
      stdio: 'inherit',
    });
    return output;
  });
  mkdirSync(join(root, 'bin'), { recursive: true });
  execFileSync('lipo', ['-create', '-output', binary, ...slices], {
    stdio: 'inherit',
  });
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log('input agent: built bin/input-agent (arm64 + x86_64)');
