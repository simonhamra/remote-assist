// Run by the release workflow before building. On a tag every problem stops the release;
// a test build (started by hand) only warns.
import { readFileSync } from 'node:fs';
import { releaseProblems } from './release.ts';

const versions = Object.fromEntries(
  ['host', 'helper'].map((app) => {
    const manifest = JSON.parse(readFileSync(`apps/${app}/package.json`, 'utf8')) as {
      version: string;
    };
    return [app, manifest.version];
  }),
);
const tag = process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : undefined;
const problems = releaseProblems({ env: process.env, tag, versions });
for (const problem of problems) console.log(`${tag ? '::error::' : '::warning::'}${problem}`);
if (tag && problems.length > 0) process.exit(1);
console.log(problems.length === 0 ? 'Release settings: ready.' : 'Test build: see the warnings.');
