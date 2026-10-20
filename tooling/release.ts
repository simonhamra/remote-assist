/** What a build bakes in, and what a release build must have. */

export const DEV_SIGNALING_URL = 'ws://127.0.0.1:8787/ws';

type Env = Record<string, string | undefined>;

/**
 * The signaling server built into the apps: RA_SIGNALING_URL at build time, or the local
 * development server. (Unpackaged apps can also be pointed elsewhere at run time.)
 */
export function bakedSignalingUrl(env: Env): string {
  return env.RA_SIGNALING_URL || DEV_SIGNALING_URL;
}

export interface ReleaseInput {
  env: Env;
  /** The git tag being released (`v1.2.3`); absent for a test build. */
  tag?: string;
  /** Each app's package.json version. */
  versions: Record<string, string>;
}

/** Everything that would make a build unfit to give to Grandma. Empty means ready. */
export function releaseProblems({ env, tag, versions }: ReleaseInput): string[] {
  const problems: string[] = [];
  if (!env.RA_SIGNALING_URL?.startsWith('wss://')) {
    problems.push('RA_SIGNALING_URL must be the deployed server, starting with wss://');
  }
  if (!env.RA_UPDATE_URL?.startsWith('https://')) {
    problems.push("RA_UPDATE_URL must be the server's update folder, starting with https://");
  }
  if (tag) {
    for (const [app, version] of Object.entries(versions)) {
      if (`v${version}` !== tag)
        problems.push(`${app} is version ${version}, but the tag is ${tag}`);
    }
  }
  if (!env.CSC_LINK) {
    problems.push('No Developer ID certificate (CSC_LINK): macOS would refuse to open the app');
  }
  if (!(env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID)) {
    problems.push(
      'No notarization login (APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID): macOS would warn',
    );
  }
  return problems;
}
