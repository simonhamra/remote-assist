# 6. Releases and updates

How the apps get from this repository onto Grandma's Mac, and how they stay up to date without her doing anything.

## What a release is

| File | For |
|---|---|
| `RemoteAssist-<version>-universal.dmg` | Grandma's first install (Apple silicon and Intel Macs) |
| `RemoteAssistHelper-<version>-universal.dmg` | Your first install |
| `…-universal.zip` and `latest-mac.yml` | Updates: the installed apps download the ZIP once `latest-mac.yml` names a newer version |

Both apps are built by electron-builder from `tooling/electron-builder.mjs` plus each app's `electron-builder.config.mjs`:

- **Universal:** one DMG works on Apple silicon and Intel Macs.
- **Signed and notarized:** Developer ID signing with the hardened runtime, then Apple's notarization, so macOS opens the app without warnings.
- **Electron fuses:** these switch off features the apps don't use, in the binary itself:
  - running as plain Node;
  - `NODE_OPTIONS`;
  - the `--inspect` flags;
  - loading app code from outside the signed `app.asar`.
- **Self-contained:** everything is bundled by electron-vite, so the app ships no `node_modules`. The input agent ships as a universal binary in `Contents/Resources`.
- **Development and test switches ignored:** the installed app ignores every `RA_…` switch and the development page server. Nobody can talk Grandma into starting it with one-time codes switched on, or pointed at another server.
- **Server address baked in:** the signaling server's address is fixed at build time (`RA_SIGNALING_URL`), and so is the update folder (`RA_UPDATE_URL`).

## Once: what you need

1. **Apple Developer Program** membership ($99 a year). Without it macOS refuses to open the app on Grandma's Mac, and her permissions would not survive updates.
2. A **Developer ID Application** certificate:
   - create it in Xcode (Settings → Accounts → Manage Certificates → + → Developer ID Application) or on developer.apple.com;
   - export it from Keychain Access as a `.p12` file with a password;
   - base64-encode it: `base64 -i DeveloperID.p12 | pbcopy`.
3. An **app-specific password** for your Apple ID (account.apple.com → Sign-In and Security → App-Specific Passwords), and your **Team ID** (developer.apple.com → Membership).
4. The **server**, deployed as in [infra/README.md](../infra/README.md). It also serves the updates, from `https://<domain>/updates/`.
5. In GitHub (repository → Settings → Secrets and variables → Actions):
   - **Secrets:**
     - `MAC_CERTIFICATE_P12_BASE64` (the base64 text);
     - `MAC_CERTIFICATE_PASSWORD`;
     - `APPLE_ID`;
     - `APPLE_APP_SPECIFIC_PASSWORD`;
     - `APPLE_TEAM_ID`.
   - **Variables:**
     - `SIGNALING_URL`: `wss://<domain>/ws`;
     - `UPDATE_URL`: `https://<domain>/updates`.

Never put any of these in the repository. Only GitHub's secret store and your own Keychain hold them.

**Decide the bundle IDs before the first install, and never change them afterwards.** They are `io.github.simonhamra.remoteassist.host` and `.helper`, set in each app's `electron-builder.config.mjs`. macOS ties Screen Recording and Accessibility to the bundle ID and the signing team: a change means Grandma grants both again.

## Every release

1. Bump both apps to the same version:

   ```bash
   npm version 0.2.0 --no-git-tag-version -w @remote-assist/host -w @remote-assist/helper
   ```

2. Commit, then tag and push the tag:

   ```bash
   git tag v0.2.0 && git push origin v0.2.0
   ```

3. The **Release** workflow:
   - checks the settings: tag and versions match, `wss://` server, `https://` update folder, signing and notarization secrets present;
   - builds, runs the checks, packages and notarizes both apps;
   - drafts a GitHub release with the files.

   It takes about 20–30 minutes, mostly notarization.

4. **Try it on your own Mac first.**
   - Download the host DMG from the draft release.
   - Install it. It should open without any "unidentified developer" warning, only macOS's "downloaded from the internet" question.
   - Run the setup, then have the helper connect.
   - If you installed an earlier version, check it updated without asking for permissions again.

5. **Publish the update.** This copies the files to the server, update files last:

   ```bash
   infra/publish-update.sh v0.2.0 you@assist.example.com
   ```

   Then publish the draft release on GitHub if you want to keep it as a record.

To make a build without releasing (for example to check the workflow), start **Release** by hand from the Actions tab. It warns instead of stopping when something is missing, and keeps the files as a workflow artifact for 14 days.

## First install on Grandma's Mac

Do it together, in person or on the phone:

1. Open the DMG: from the release, or from `https://<domain>/updates/host/RemoteAssist-<version>-universal.dmg`.
2. Drag **Remote Assist** to Applications.
3. Open it from Applications. macOS asks once whether to open an app downloaded from the internet: **Open**.
4. The guided setup takes it from there ([OS permissions](04-os-permissions.md#setup-assistant-host-first-run-target-10-minutes-on-the-phone)).

## How updates reach her

Both installed apps:

- check the update folder a minute after starting, then every 6 hours;
- download a newer version in the background;
- install it when the app quits. Before installing, macOS checks the update is signed by the same developer as the app already installed.

Grandma's app rarely quits: it starts with the computer and lives in the menu bar. So it also restarts to install by itself, but only at a moment nobody would notice:

- nobody is helping or asking;
- the window is closed;
- nobody has touched the computer for 15 minutes.

It comes back in the menu bar, without its window. Because the bundle ID and signing team stay the same, her Screen Recording and Accessibility permissions carry over.

Rules:

- **Never roll back.** The apps refuse older versions. To undo a bad release, ship a newer version with the fix.
- **Server first.** If a release changes the protocol, deploy the server before publishing the update. Old and new apps must both keep working until each has updated.
- Old files in the update folders can be deleted once every app has updated.

## Building locally

```bash
npm run package
```

This builds both apps into `apps/host/dist` and `apps/helper/dist`. The first run downloads Electron for both architectures, so it takes a few minutes.

Without a certificate the apps are **signed ad hoc**: they run on this Mac only. They have no hardened runtime and no update check (unless `RA_UPDATE_URL` is set), and they lose their macOS permissions at every rebuild.

To sign with a Developer ID certificate in your Keychain, set `CSC_NAME`:

```bash
CSC_NAME="Developer ID Application: Your Name (TEAMID)" npm run package
```

Add `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` to notarize as well.

The installed app ignores `RA_…` switches. To point a local build at another server, set `RA_SIGNALING_URL` when building, not when running.

## Not done yet

- **Windows installers** (NSIS, Authenticode signing, firewall rule). Grandma uses a Mac, and the input agent is macOS-only so far.
- **Signing and notarization tested for real:** needs the Developer ID certificate. The pipeline has only made ad hoc builds so far.
- **Updates tested end to end:** an installed version updating itself while keeping its permissions.
