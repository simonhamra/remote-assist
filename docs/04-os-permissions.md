# 4. OS Permissions

Remote control touches the most protected parts of an operating system. These permissions protect people like Grandma, so the plan **never** works around them. It only asks for them in the least confusing way possible.

## What the host app needs

### macOS

| Capability | Permission (System Settings → Privacy & Security) | Needed? | Notes |
|---|---|---|---|
| See the screen | **Screen & System Audio Recording** | **Yes** | First capture shows a system dialog. She has to switch the app on in Settings, and the app must be **relaunched** before the grant takes effect. |
| Move mouse / type | **Accessibility** | **Yes**, for control | Needed to post synthetic events (`CGEventPost`). The prompt comes from `AXIsProcessTrustedWithOptions`, and it is a one-time switch. |
| Local network | **Local Network** (macOS 15+) | **Test it** | macOS 15 prompts non-Apple apps that contact devices on the LAN. WebRTC's local address probing *may* trigger it. Check early on a clean Mac. If it appears, include it in setup (allowing it is harmless) or limit ICE to server-reflexive and relay candidates. |
| Voice chat | **Microphone** | Only if voice is built | Leave out of the MVP to avoid the prompt |
| Start at login | Login Items | Recommended | No approval is needed, but macOS 13+ shows a "Background item added" notification once |
| — | Input Monitoring, Full Disk Access, Camera, Automation, Contacts | **No** | Never ask. Fewer permissions mean fewer scary prompts and a smaller risk. |

**Screen recording reconfirmation on macOS 15+.** Since macOS Sequoia, apps that capture the screen without the system's own picker get a periodic *"continue to allow?"* reconfirmation. Apple moved it from weekly to **monthly** during the 15.x betas ([9to5Mac](https://9to5mac.com/2024/08/14/macos-sequoia-screen-recording-prompt-monthly/), [TidBITS](https://tidbits.com/2024/08/19/apple-reduces-excessive-sequoia-permission-requests-shifts-to-monthly)). Remote-desktop apps can apply to Apple for the **Persistent Content Capture** entitlement (`com.apple.developer.persistent-content-capture`), which removes the reconfirmation. Jump Desktop shipped with it ([Jump Desktop note](https://support.jumpdesktop.com/hc/en-us/articles/29070118000781-macOS-Sequoia-Screen-Recording-Policies-and-Jump-Desktop-Connect)). Apple documents the process only sparsely. Plan to:

1. apply for the entitlement as soon as you have a Developer ID (Phase 0)
2. until it is granted, teach Grandma that the system box *"Remote Assist would like to continue…"* is expected and the answer is **Allow**, about once a month
3. re-check the behaviour on the newest macOS release before shipping, because Apple has changed this policy several times

> These sources are from 2024. Verify against Apple's current developer documentation and a test Mac on the latest macOS.

**What a user-level app cannot do on macOS (by design):** see or control the login window or lock screen, or approve system authentication dialogs for her. She types her own Mac password, and the helper never asks for it.

### Windows

| Capability | Permission | Needed? | Notes |
|---|---|---|---|
| See the screen | None | — | Windows Graphics Capture / DXGI. Windows may draw a yellow border around captured content. Keep it: it is a useful visible indicator. |
| Move mouse / type | None for normal apps | — | `SendInput`. **UIPI** blocks input into *elevated* windows (Task Manager, admin installers) from a non-elevated app. |
| UAC prompts | Secure Desktop | **Cannot be controlled** | The helper sees a dark or frozen screen and Grandma clicks **Yes** herself. Never disable the Secure Desktop or UAC. A SYSTEM service with `uiAccess` *could* handle this, but it greatly enlarges the attack surface, so it stays post-MVP and is probably never worth it. |
| Firewall | Windows Defender Firewall dialog | Possible on first call | WebRTC opens UDP sockets, which can trigger the dialog. Options: a per-machine install (one UAC prompt at install time, while you're on the phone) that registers a firewall rule, or let her click either button. Outbound connections still work, and the direct path is just less likely. |
| Install | SmartScreen | Once | A signed installer avoids "Windows protected your PC". Unsigned means *More info → Run anyway*, once, during setup. |
| Voice chat | Microphone privacy setting | Only if voice is built | |

### Linux (post-MVP)

On Wayland, both capture and input go through **xdg-desktop-portal** (ScreenCast + RemoteDesktop). The portal asks every session unless the app stores a **restore token** (`persist_mode`). X11 needs no permissions but offers no isolation either.

## What the helper app needs (your computer)

Nothing, for basic use. Touch ID uses LocalAuthentication and needs no privacy permission. The only optional extras:

- **Accessibility**, only if you want the helper to capture OS-reserved shortcuts (Cmd+Tab, Cmd+Space). The toolbar buttons that send those combos are the simpler choice.
- **Microphone**, if voice chat is built.

## Minimizing prompts without bypassing them

1. **Ask only for what's needed.** On macOS that is two permissions (Screen Recording and Accessibility), possibly three (Local Network). On Windows it is usually zero.
2. **Ask once, during guided setup, never mid-session.** Setup happens with you on the phone or in person. After that, a support session never raises a system dialog, apart from the macOS monthly reconfirmation until the entitlement is granted.
3. **Explain before the system asks.** Each permission gets a pre-permission screen with a large screenshot of exactly which switch to flip and what it is for: *"So Alex can see your screen."*
4. **Take her straight there.** Deep-link to the right pane (for example `x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility`). Detect the grant by polling `CGPreflightScreenCaptureAccess()` / `AXIsProcessTrusted()`, then advance and relaunch automatically, so she never has to find the app again.
5. **Keep the code-signing identity stable.** macOS ties grants to the app's signature (Team ID + bundle ID). The same Developer ID across updates means **grants survive auto-updates**. Ad-hoc-signed builds lose their grants on every rebuild, so even development builds should use your Apple Development certificate.
6. **Apply for Persistent Content Capture** on macOS.
7. **Health check on every launch.** If a permission was turned off, the tray icon shows a gentle "Ask Alex to help fix this" status, and your helper app shows *"Grandma's Mac: Accessibility is off"*.
8. **Ask lazily for extras.** If voice or clipboard are added later, request them the first time they're used, with you there to explain.

### Never do

- Edit the TCC database, ask her to disable SIP, or use Accessibility to click "Allow" on system dialogs
- Disable UAC or the Secure Desktop, or run as SYSTEM to sidestep prompts
- Hide or suppress OS capture indicators, or exclude the app from them
- Use MDM/PPPC profiles to pre-grant permissions on a personal computer. (macOS does not allow pre-granting Screen Recording through MDM anyway, only letting standard users approve it.)
- Install silently, or keep running after she quits the app from the tray

## Setup assistant (host first run): target ~10 minutes on the phone

```
1. Welcome            "Alex set this up so they can help you with your computer."
2. Pair               big 8-digit code → read it to Alex → confirm 3 words
3. Screen Recording   picture + "Open Settings" → switch on → app relaunches itself
4. Accessibility      picture + "Open Settings" → switch on → ✔ detected
5. (Local Network)    only if it appeared in testing
6. Start at login     on by default, explained in one sentence
7. Test call          Alex connects once and she practices: Yes → Pause → Stop
8. Done               "You're all set. When you need help, call Alex."
```
