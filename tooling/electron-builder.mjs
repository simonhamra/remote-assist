// Packaging settings shared by both apps (each app's electron-builder.config.mjs adds its own).
// Signing and notarization switch on when their secrets are set; see docs/06-releases.md.
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const tooling = import.meta.dirname;

/**
 * @param {{
 *   appId: string,
 *   productName: string,
 *   artifactName: string,
 *   localNetworkReason: string,
 *   extraResources?: { from: string, to: string }[],
 * }} app
 */
export function appConfig(app) {
  const env = process.env;
  // A Developer ID certificate from CI secrets (CSC_LINK) or this Mac's keychain (CSC_NAME).
  // Without one the app is signed ad hoc: it runs on this Mac only and loses its permissions
  // at every rebuild.
  const signed = Boolean(env.CSC_LINK || env.CSC_NAME);
  const notarize = Boolean(env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID);
  const entitlements = join(tooling, 'mac/entitlements.plist');

  return {
    appId: app.appId,
    productName: app.productName,
    electronVersion: require('electron/package.json').version,
    artifactName: `${app.artifactName}-\${version}-\${arch}.\${ext}`,
    directories: { output: 'dist', buildResources: 'build' },
    // electron-vite bundles everything into out/: no node_modules, nothing to rebuild.
    files: ['out/**/*', 'package.json'],
    npmRebuild: false,
    extraResources: app.extraResources ?? [],
    // Electron features the apps don't use, switched off in the binary itself.
    electronFuses: {
      runAsNode: false,
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
      enableCookieEncryption: true,
      enableEmbeddedAsarIntegrityValidation: true,
      onlyLoadAppFromAsar: true,
    },
    mac: {
      // One download for Apple silicon and Intel Macs.
      target: [
        { target: 'dmg', arch: ['universal'] },
        { target: 'zip', arch: ['universal'] },
      ],
      category: 'public.app-category.utilities',
      minimumSystemVersion: '13.0',
      // Required for notarization. Ad hoc builds go without: their libraries carry no team ID
      // for the runtime's library check to compare.
      hardenedRuntime: signed,
      entitlements,
      entitlementsInherit: entitlements,
      identity: signed ? undefined : '-',
      notarize: signed && notarize,
      // The input agent is already universal in both halves of the universal build.
      x64ArchFiles: 'Contents/Resources/input-agent',
      extendInfo: { NSLocalNetworkUsageDescription: app.localNetworkReason },
    },
    dmg: { title: app.productName },
    // Where installed apps look for updates (an https folder on your server). Without it the
    // build has no update check.
    publish: env.RA_UPDATE_URL ? [{ provider: 'generic', url: env.RA_UPDATE_URL }] : null,
  };
}
