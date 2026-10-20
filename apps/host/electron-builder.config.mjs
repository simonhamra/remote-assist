import { appConfig } from '../../tooling/electron-builder.mjs';

// The bundle ID must never change once installed: macOS ties Screen Recording and
// Accessibility permissions to it (and to the signing team).
export default appConfig({
  appId: 'io.github.simonhamra.remoteassist.host',
  productName: 'Remote Assist',
  artifactName: 'RemoteAssist',
  localNetworkReason:
    "Remote Assist connects straight to your helper's computer when you are both on the same network.",
  extraResources: [{ from: '../../packages/native-input/bin/input-agent', to: 'input-agent' }],
});
