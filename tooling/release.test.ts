import { describe, expect, it } from 'vitest';
import { DEV_SIGNALING_URL, bakedSignalingUrl, releaseProblems } from './release';

const ready = {
  RA_SIGNALING_URL: 'wss://help.example.com/ws',
  RA_UPDATE_URL: 'https://help.example.com/updates/host',
  CSC_LINK: 'base64-certificate',
  APPLE_ID: 'me@example.com',
  APPLE_APP_SPECIFIC_PASSWORD: 'app-password',
  APPLE_TEAM_ID: 'TEAM123456',
};

describe('release settings', () => {
  it('uses the local server unless a URL is given at build time', () => {
    expect(bakedSignalingUrl({})).toBe(DEV_SIGNALING_URL);
    expect(bakedSignalingUrl({ RA_SIGNALING_URL: ready.RA_SIGNALING_URL })).toBe(
      ready.RA_SIGNALING_URL,
    );
  });

  it('accepts a signed, notarized build of the tagged version', () => {
    const versions = { host: '0.2.0', helper: '0.2.0' };
    expect(releaseProblems({ env: ready, tag: 'v0.2.0', versions })).toEqual([]);
  });

  it('lists everything missing or wrong', () => {
    const problems = releaseProblems({
      env: { RA_SIGNALING_URL: 'ws://127.0.0.1:8787/ws' },
      tag: 'v0.2.0',
      versions: { host: '0.2.0', helper: '0.1.0' },
    });
    expect(problems).toHaveLength(5);
    expect(problems.join('\n')).toMatch(/wss:\/\//);
    expect(problems.join('\n')).toMatch(/helper is version 0.1.0, but the tag is v0.2.0/);
    expect(problems.join('\n')).toMatch(/CSC_LINK/);
  });
});
