import { appConfig } from '../../tooling/electron-builder.mjs';

export default appConfig({
  appId: 'io.github.simonhamra.remoteassist.helper',
  productName: 'Remote Assist Helper',
  artifactName: 'RemoteAssistHelper',
  localNetworkReason:
    'Remote Assist Helper connects straight to the computer you help when you are both on the same network.',
});
