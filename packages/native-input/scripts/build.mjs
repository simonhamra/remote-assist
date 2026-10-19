// Builds the macOS input agent with swiftc, which comes with Xcode's Command Line Tools.
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

if (process.platform !== 'darwin') {
  console.log('input agent: skipped (only macOS is supported so far)');
  process.exit(0);
}

const arch = process.arch === 'arm64' ? 'arm64' : 'x86_64';
mkdirSync(join(root, 'bin'), { recursive: true });
execFileSync(
  'swiftc',
  [
    '-O',
    '-target',
    `${arch}-apple-macos13`,
    '-o',
    join(root, 'bin', 'input-agent'),
    join(root, 'macos', 'InputAgent.swift'),
  ],
  { stdio: 'inherit' },
);
console.log('input agent: built bin/input-agent');
